const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db/init');
const { requireSbAuth, requireSbAdmin } = require('../middleware/sbAuth');
const { ipHash, geoLocate } = require('../utils/geo');

// ── 公开 API (CORS) ───────────────────────────────────────

router.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 广告获取 API — 返回当前区域所有可投放的广告（供客户端轮播）
router.get('/api/ads', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const geo = await geoLocate(ip);
    const now = new Date();
    // 返回：本区域广告 + GLOBAL广告（region_id IS NULL 或 area_code='GLOBAL'）
    // 严格隔离：其他区域广告不返回
    const ads = await query(`
      SELECT a.*, r.area_code as r_code FROM sb_ads a
      LEFT JOIN sb_regions r ON r.id = a.region_id
      WHERE a.is_active = 1
        AND (a.start_time IS NULL OR a.start_time <= $1)
        AND (a.end_time IS NULL OR a.end_time >= $1)
        AND (
          a.region_id IS NULL
          OR r.area_code = 'GLOBAL'
          OR r.area_code = $2
        )
      ORDER BY
        CASE WHEN r.area_code = $2 THEN 0 ELSE 1 END,
        CASE WHEN a.frequency_minutes IS NOT NULL THEN 0 ELSE 1 END,
        a.frequency_minutes ASC NULLS LAST,
        a.created_at DESC
    `, [now, geo.region_code]);
    res.json({ ads, geo });
  } catch (e) {
    console.error('Ads API error:', e.message);
    res.json({ ads: [] });
  }
});

// 管理员诊断接口：列出所有广告状态 + 调用者IP的geo结果
router.get('/api/debug/ads', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const geo = await geoLocate(ip);
  const allAds = await query(`
    SELECT a.id, a.title, a.is_active, a.region_id, r.area_code,
           a.start_time, a.end_time, a.frequency_minutes,
           CASE
             WHEN a.is_active = 0 THEN '⛔ 已暂停'
             WHEN a.start_time IS NOT NULL AND a.start_time > NOW() THEN '⏳ 未到开始时间'
             WHEN a.end_time   IS NOT NULL AND a.end_time   < NOW() THEN '⌛ 已过期'
             ELSE '✅ 有效'
           END as status
    FROM sb_ads a LEFT JOIN sb_regions r ON r.id = a.region_id
    ORDER BY a.id DESC
  `);
  res.json({ caller_ip: ip, geo, ads: allAds });
});

// 广告曝光追踪（客户端每次展示时调用）
router.post('/api/ads/:id/impression', async (req, res) => {
  try {
    await query('UPDATE sb_ads SET impressions = impressions + 1 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// 广告点击追踪
router.post('/api/ads/:id/click', async (req, res) => {
  try {
    await query('UPDATE sb_ads SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// 访问上报 API
router.post('/api/visit', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const geo = await geoLocate(ip);
    const ua = req.headers['user-agent'] || '';
    const page = (req.body?.page || 'scoreboard').toString().slice(0, 50);
    await query(
      'INSERT INTO sb_visits (ip_hash, country, region_code, city, page, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
      [ipHash(ip), geo.country, geo.region_code, geo.city, page, ua.slice(0, 200)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Visit API error:', e.message);
    res.json({ ok: false });
  }
});

// ── 登录 ─────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.sbUser) return res.redirect('/scoreboard/dashboard');
  res.render('scoreboard/login', { error: req.flash('error'), success: req.flash('success') });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    req.flash('error', '请填写用户名和密码');
    return res.redirect('/scoreboard/login');
  }
  const user = await queryOne('SELECT * FROM sb_users WHERE username = $1 AND is_active = 1', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', '用户名或密码错误 | Invalid credentials');
    return res.redirect('/scoreboard/login');
  }
  req.session.sbUser = { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
  res.redirect('/scoreboard/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.sbUser = null;
  res.redirect('/scoreboard/login');
});

// ── 仪表板 ───────────────────────────────────────────────

router.get('/dashboard', requireSbAuth, async (req, res) => {
  try {
    const u = req.session.sbUser;
    let visitStats, adStats, recentVisits, regions;

    let gsVisitStats, gsTotalVisits30d, gsOnlineTotal;

    if (u.role === 'admin') {
      visitStats = await query(`
        SELECT region_code, COUNT(*) as cnt,
          COUNT(DISTINCT CASE WHEN visited_at >= NOW() - INTERVAL '5 minutes' THEN ip_hash END) as online_cnt
        FROM sb_visits WHERE visited_at >= NOW() - INTERVAL '30 days'
        GROUP BY region_code ORDER BY cnt DESC
      `);
      adStats = await queryOne('SELECT COUNT(*) as total, SUM(impressions) as imp, SUM(clicks) as clk FROM sb_ads WHERE is_active = 1');
      recentVisits = await query(`
        SELECT v.*,
          CASE WHEN v.visited_at >= NOW() - INTERVAL '5 minutes'
            THEN true ELSE false END AS is_active
        FROM sb_visits v
        ORDER BY is_active DESC, v.visited_at DESC LIMIT 30
      `);
      regions = await query('SELECT * FROM sb_regions ORDER BY country, area_code');
      gsVisitStats = await query(`
        SELECT region_code, COUNT(*) as cnt,
          COUNT(DISTINCT CASE WHEN visited_at >= NOW() - INTERVAL '5 minutes' THEN ip_hash END) as online_cnt
        FROM sb_visits WHERE page LIKE 'gs-%' AND visited_at >= NOW() - INTERVAL '30 days'
        GROUP BY region_code ORDER BY cnt DESC
      `);
      gsTotalVisits30d = await queryOne(`SELECT COUNT(*) as cnt FROM sb_visits WHERE page LIKE 'gs-%' AND visited_at >= NOW() - INTERVAL '30 days'`);
      gsOnlineTotal = await queryOne(`SELECT COUNT(DISTINCT ip_hash) as cnt FROM sb_visits WHERE page LIKE 'gs-%' AND visited_at >= NOW() - INTERVAL '5 minutes'`);
    } else {
      // 区域用户：只看自己管辖的区域
      const userRegions = await query(
        'SELECT r.* FROM sb_regions r JOIN sb_user_regions ur ON ur.region_id = r.id WHERE ur.user_id = $1',
        [u.id]
      );
      const codes = userRegions.map(r => r.area_code);
      regions = userRegions;
      if (codes.length > 0) {
        visitStats = await query(`
          SELECT region_code, COUNT(*) as cnt,
            COUNT(DISTINCT CASE WHEN visited_at >= NOW() - INTERVAL '5 minutes' THEN ip_hash END) as online_cnt
          FROM sb_visits
          WHERE region_code = ANY($1) AND visited_at >= NOW() - INTERVAL '30 days'
          GROUP BY region_code ORDER BY cnt DESC
        `, [codes]);
        recentVisits = await query(`
          SELECT v.*,
            CASE WHEN v.visited_at >= NOW() - INTERVAL '5 minutes'
              THEN true ELSE false END AS is_active
          FROM sb_visits v
          WHERE v.region_code = ANY($1)
          ORDER BY is_active DESC, v.visited_at DESC LIMIT 30
        `, [codes]);
        adStats = await queryOne(
          'SELECT COUNT(*) as total, SUM(impressions) as imp, SUM(clicks) as clk FROM sb_ads WHERE is_active = 1 AND region_id IN (SELECT id FROM sb_regions WHERE area_code = ANY($1))',
          [codes]
        );
        gsVisitStats = await query(`
          SELECT region_code, COUNT(*) as cnt,
            COUNT(DISTINCT CASE WHEN visited_at >= NOW() - INTERVAL '5 minutes' THEN ip_hash END) as online_cnt
          FROM sb_visits WHERE page LIKE 'gs-%' AND region_code = ANY($1) AND visited_at >= NOW() - INTERVAL '30 days'
          GROUP BY region_code ORDER BY cnt DESC
        `, [codes]);
        gsTotalVisits30d = await queryOne(`SELECT COUNT(*) as cnt FROM sb_visits WHERE page LIKE 'gs-%' AND region_code = ANY($1) AND visited_at >= NOW() - INTERVAL '30 days'`, [codes]);
        gsOnlineTotal = await queryOne(`SELECT COUNT(DISTINCT ip_hash) as cnt FROM sb_visits WHERE page LIKE 'gs-%' AND region_code = ANY($1) AND visited_at >= NOW() - INTERVAL '5 minutes'`, [codes]);
      } else {
        visitStats = []; recentVisits = []; adStats = { total: 0, imp: 0, clk: 0 };
        gsVisitStats = []; gsTotalVisits30d = { cnt: 0 }; gsOnlineTotal = { cnt: 0 };
      }
    }
    const totalVisits30d = await queryOne(
      u.role === 'admin'
        ? 'SELECT COUNT(*) as cnt FROM sb_visits WHERE visited_at >= NOW() - INTERVAL \'30 days\''
        : 'SELECT COUNT(*) as cnt FROM sb_visits WHERE visited_at >= NOW() - INTERVAL \'30 days\' AND region_code = ANY($1)',
      u.role === 'admin' ? [] : [(await query('SELECT area_code FROM sb_regions r JOIN sb_user_regions ur ON ur.region_id=r.id WHERE ur.user_id=$1',[u.id])).map(r=>r.area_code)]
    );
    const onlineTotal = await queryOne(
      u.role === 'admin'
        ? `SELECT COUNT(DISTINCT ip_hash) as cnt FROM sb_visits WHERE visited_at >= NOW() - INTERVAL '5 minutes'`
        : `SELECT COUNT(DISTINCT ip_hash) as cnt FROM sb_visits WHERE visited_at >= NOW() - INTERVAL '5 minutes' AND region_code = ANY($1)`,
      u.role === 'admin' ? [] : [(await query('SELECT area_code FROM sb_regions r JOIN sb_user_regions ur ON ur.region_id=r.id WHERE ur.user_id=$1',[u.id])).map(r=>r.area_code)]
    );
    res.render('scoreboard/dashboard', { sbUser: u, visitStats, adStats, recentVisits, regions, totalVisits30d, onlineTotal, gsVisitStats, gsTotalVisits30d, gsOnlineTotal });
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

// ── 用户管理 (admin only) ─────────────────────────────────

router.get('/users', requireSbAuth, requireSbAdmin, async (req, res) => {
  const users = await query('SELECT * FROM sb_users ORDER BY created_at DESC');
  const regions = await query('SELECT * FROM sb_regions ORDER BY country, area_code');
  const userRegions = await query('SELECT * FROM sb_user_regions');
  res.render('scoreboard/users', { sbUser: req.session.sbUser, users, regions, userRegions, error: req.flash('error'), success: req.flash('success') });
});

router.post('/users/add', requireSbAuth, requireSbAdmin, async (req, res) => {
  const { username, password, role, display_name, region_ids } = req.body;
  if (!username || !password) {
    req.flash('error', '请填写用户名和密码');
    return res.redirect('/scoreboard/users');
  }
  try {
    const hash = bcrypt.hashSync(password, 12);
    const newUser = await queryOne(
      'INSERT INTO sb_users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING id',
      [username, hash, role || 'regional', display_name || username]
    );
    if (region_ids) {
      const ids = Array.isArray(region_ids) ? region_ids : [region_ids];
      for (const rid of ids) {
        await query('INSERT INTO sb_user_regions (user_id, region_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [newUser.id, rid]);
      }
    }
    req.flash('success', `用户 ${username} 已创建`);
  } catch (e) {
    req.flash('error', e.message.includes('unique') ? '用户名已存在' : '创建失败: ' + e.message);
  }
  res.redirect('/scoreboard/users');
});

router.post('/users/:id/toggle', requireSbAuth, requireSbAdmin, async (req, res) => {
  const u = await queryOne('SELECT * FROM sb_users WHERE id = $1', [req.params.id]);
  if (u) await query('UPDATE sb_users SET is_active = $1 WHERE id = $2', [u.is_active ? 0 : 1, u.id]);
  res.redirect('/scoreboard/users');
});

router.post('/users/:id/delete', requireSbAuth, requireSbAdmin, async (req, res) => {
  await query('DELETE FROM sb_user_regions WHERE user_id = $1', [req.params.id]);
  await query('DELETE FROM sb_users WHERE id = $1 AND role != \'admin\'', [req.params.id]);
  req.flash('success', '用户已删除');
  res.redirect('/scoreboard/users');
});

// ── 区域管理 (admin only) ─────────────────────────────────

router.get('/regions', requireSbAuth, requireSbAdmin, async (req, res) => {
  const regions = await query('SELECT r.*, u.username as assigned_username FROM sb_regions r LEFT JOIN sb_users u ON u.id = r.assigned_user_id ORDER BY r.country, r.area_code');
  const users = await query('SELECT * FROM sb_users WHERE role = \'regional\' AND is_active = 1');
  res.render('scoreboard/regions', { sbUser: req.session.sbUser, regions, users, error: req.flash('error'), success: req.flash('success') });
});

router.post('/regions/:id/assign', requireSbAuth, requireSbAdmin, async (req, res) => {
  const { user_id } = req.body;
  await query('UPDATE sb_regions SET assigned_user_id = $1 WHERE id = $2', [user_id || null, req.params.id]);
  if (user_id) {
    await query('INSERT INTO sb_user_regions (user_id, region_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user_id, req.params.id]);
  }
  res.redirect('/scoreboard/regions');
});

// ── 广告管理 ─────────────────────────────────────────────

router.get('/ads', requireSbAuth, async (req, res) => {
  const u = req.session.sbUser;
  let ads, regions;
  if (u.role === 'admin') {
    ads = await query('SELECT a.*, r.area_name_zh FROM sb_ads a LEFT JOIN sb_regions r ON r.id = a.region_id ORDER BY a.created_at DESC');
    regions = await query('SELECT * FROM sb_regions ORDER BY country, area_code');
  } else {
    const userRegions = await query('SELECT r.* FROM sb_regions r JOIN sb_user_regions ur ON ur.region_id = r.id WHERE ur.user_id = $1', [u.id]);
    const rids = userRegions.map(r => r.id);
    ads = rids.length > 0
      ? await query('SELECT a.*, r.area_name_zh FROM sb_ads a LEFT JOIN sb_regions r ON r.id = a.region_id WHERE a.region_id = ANY($1) ORDER BY a.created_at DESC', [rids])
      : [];
    regions = userRegions;
  }
  res.render('scoreboard/ads', { sbUser: u, ads, regions, error: req.flash('error'), success: req.flash('success') });
});

router.post('/ads/add', requireSbAuth, async (req, res) => {
  const u = req.session.sbUser;
  const { title, content_type, content_text, content_url, link_url, region_id, start_time, end_time, frequency_minutes } = req.body;
  if (!title) { req.flash('error', '请填写广告标题'); return res.redirect('/scoreboard/ads'); }
  // 区域用户只能为自己的区域创建广告
  if (u.role !== 'admin' && region_id) {
    const allowed = await queryOne('SELECT 1 FROM sb_user_regions WHERE user_id=$1 AND region_id=$2', [u.id, region_id]);
    if (!allowed) { req.flash('error', '无权操作该区域'); return res.redirect('/scoreboard/ads'); }
  }
  const freqMin = frequency_minutes && parseInt(frequency_minutes) > 0 ? parseInt(frequency_minutes) : null;
  await query(
    'INSERT INTO sb_ads (title, content_type, content_text, content_url, link_url, region_id, start_time, end_time, frequency_minutes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [title, content_type || 'text', content_text || '', content_url || '', link_url || '',
     region_id || null, start_time || null, end_time || null, freqMin, u.id]
  );
  req.flash('success', '广告已创建');
  res.redirect('/scoreboard/ads');
});

router.post('/ads/:id/edit', requireSbAuth, async (req, res) => {
  const u = req.session.sbUser;
  const { title, content_type, content_text, content_url, link_url, region_id, start_time, end_time, frequency_minutes } = req.body;
  if (!title) { req.flash('error', '请填写广告标题'); return res.redirect('/scoreboard/ads'); }
  // 区域用户只能编辑自己区域的广告
  if (u.role !== 'admin') {
    const ad = await queryOne('SELECT * FROM sb_ads WHERE id = $1', [req.params.id]);
    if (!ad || (ad.region_id && !await queryOne('SELECT 1 FROM sb_user_regions WHERE user_id=$1 AND region_id=$2', [u.id, ad.region_id]))) {
      req.flash('error', '无权操作该广告'); return res.redirect('/scoreboard/ads');
    }
  }
  const freqMin = frequency_minutes && parseInt(frequency_minutes) > 0 ? parseInt(frequency_minutes) : null;
  await query(
    `UPDATE sb_ads SET title=$1, content_type=$2, content_text=$3, content_url=$4,
     link_url=$5, region_id=$6, start_time=$7, end_time=$8, frequency_minutes=$9,
     is_active=1 WHERE id=$10`,
    [title, content_type || 'text', content_text || '', content_url || '', link_url || '',
     region_id || null, start_time || null, end_time || null, freqMin, req.params.id]
  );
  req.flash('success', '广告已更新并重新发布');
  res.redirect('/scoreboard/ads');
});

router.post('/ads/:id/toggle', requireSbAuth, async (req, res) => {
  const ad = await queryOne('SELECT * FROM sb_ads WHERE id = $1', [req.params.id]);
  if (ad) await query('UPDATE sb_ads SET is_active = $1 WHERE id = $2', [ad.is_active ? 0 : 1, ad.id]);
  res.redirect('/scoreboard/ads');
});

router.post('/ads/:id/delete', requireSbAuth, async (req, res) => {
  await query('DELETE FROM sb_ads WHERE id = $1', [req.params.id]);
  req.flash('success', '广告已删除');
  res.redirect('/scoreboard/ads');
});

// ── 流量统计 ─────────────────────────────────────────────

router.get('/analytics', requireSbAuth, async (req, res) => {
  const u = req.session.sbUser;
  const days = parseInt(req.query.days) || 30;
  const source = req.query.source || 'all'; // all | guandan | gs
  let byRegion, byCountry, byDay, total;

  // 来源过滤条件
  const sourceFilter = source === 'guandan' ? `AND page = 'guandan'`
                     : source === 'gs'       ? `AND page LIKE 'gs-%'`
                     : '';

  if (u.role === 'admin') {
    byRegion = await query(`SELECT region_code, COUNT(*) as cnt FROM sb_visits WHERE visited_at >= NOW() - ($1 || ' days')::INTERVAL ${sourceFilter} GROUP BY region_code ORDER BY cnt DESC`, [days]);
    byCountry = await query(`SELECT country, COUNT(*) as cnt FROM sb_visits WHERE visited_at >= NOW() - ($1 || ' days')::INTERVAL ${sourceFilter} GROUP BY country ORDER BY cnt DESC`, [days]);
    byDay = await query(`SELECT DATE(visited_at) as day, COUNT(*) as cnt FROM sb_visits WHERE visited_at >= NOW() - ($1 || ' days')::INTERVAL ${sourceFilter} GROUP BY day ORDER BY day`, [days]);
    total = await queryOne(`SELECT COUNT(*) as cnt FROM sb_visits WHERE visited_at >= NOW() - ($1 || ' days')::INTERVAL ${sourceFilter}`, [days]);
    if (source === 'gs' || source === 'all') {
      var gsPageBreakdown = await query(`SELECT page, COUNT(*) as cnt FROM sb_visits WHERE page LIKE 'gs-%' AND visited_at >= NOW() - ($1 || ' days')::INTERVAL GROUP BY page ORDER BY cnt DESC`, [days]);
    }
  } else {
    const userRegions = await query('SELECT area_code FROM sb_regions r JOIN sb_user_regions ur ON ur.region_id=r.id WHERE ur.user_id=$1', [u.id]);
    const codes = userRegions.map(r => r.area_code);
    if (codes.length > 0) {
      byRegion = await query(`SELECT region_code, COUNT(*) as cnt FROM sb_visits WHERE region_code = ANY($1) AND visited_at >= NOW() - ($2 || ' days')::INTERVAL ${sourceFilter} GROUP BY region_code ORDER BY cnt DESC`, [codes, days]);
      byCountry = await query(`SELECT country, COUNT(*) as cnt FROM sb_visits WHERE region_code = ANY($1) AND visited_at >= NOW() - ($2 || ' days')::INTERVAL ${sourceFilter} GROUP BY country ORDER BY cnt DESC`, [codes, days]);
      byDay = await query(`SELECT DATE(visited_at) as day, COUNT(*) as cnt FROM sb_visits WHERE region_code = ANY($1) AND visited_at >= NOW() - ($2 || ' days')::INTERVAL ${sourceFilter} GROUP BY day ORDER BY day`, [codes, days]);
      total = await queryOne(`SELECT COUNT(*) as cnt FROM sb_visits WHERE region_code = ANY($1) AND visited_at >= NOW() - ($2 || ' days')::INTERVAL ${sourceFilter}`, [codes, days]);
      if (source === 'gs' || source === 'all') {
        var gsPageBreakdown = await query(`SELECT page, COUNT(*) as cnt FROM sb_visits WHERE page LIKE 'gs-%' AND region_code = ANY($1) AND visited_at >= NOW() - ($2 || ' days')::INTERVAL GROUP BY page ORDER BY cnt DESC`, [codes, days]);
      }
    } else {
      byRegion = []; byCountry = []; byDay = []; total = { cnt: 0 };
    }
  }
  res.render('scoreboard/analytics', { sbUser: u, byRegion, byCountry, byDay, total, days, source, gsPageBreakdown: gsPageBreakdown || [] });
});

module.exports = router;
