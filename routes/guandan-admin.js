const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const { query, queryOne } = require('../db/init');
const { requireSbAuth, requireSbAdmin } = require('../middleware/sbAuth');

// All routes require auth
router.use(requireSbAuth);

// GET / — Dashboard
router.get('/', async (req, res) => {
  try {
    const [
      totalUsersRow,
      pendingPaymentsRow,
      confirmedPaymentsRow,
      activeActivationsRow,
      recentPayments,
      recentActivations
    ] = await Promise.all([
      queryOne('SELECT COUNT(*) as c FROM gd_users'),
      queryOne("SELECT COUNT(*) as c FROM gd_payments WHERE status = 'pending'"),
      queryOne("SELECT COUNT(*) as c FROM gd_payments WHERE status = 'confirmed'"),
      queryOne('SELECT COUNT(*) as c FROM gd_activations WHERE valid_until > NOW()'),
      query(`
        SELECT p.*, u.name as user_name, u.contact as user_contact
        FROM gd_payments p
        LEFT JOIN gd_users u ON u.id = p.user_id
        ORDER BY p.created_at DESC LIMIT 10
      `),
      query(`
        SELECT a.*, u.name as user_name
        FROM gd_activations a
        LEFT JOIN gd_users u ON u.id = a.user_id
        ORDER BY a.created_at DESC LIMIT 10
      `)
    ]);

    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      stats: {
        totalUsers: parseInt(totalUsersRow.c),
        pendingPayments: parseInt(pendingPaymentsRow.c),
        confirmedPayments: parseInt(confirmedPaymentsRow.c),
        activeActivations: parseInt(activeActivationsRow.c)
      },
      recentPayments,
      recentActivations
    });
  } catch (e) {
    console.error('GD admin dashboard error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// GET /users — list all users
router.get('/users', async (req, res) => {
  try {
    const users = await query(`
      SELECT u.*,
        COUNT(DISTINCT p.id) as payment_count,
        MAX(a.valid_until) as latest_activation
      FROM gd_users u
      LEFT JOIN gd_payments p ON p.user_id = u.id
      LEFT JOIN gd_activations a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      tab: 'users',
      users,
      stats: null,
      recentPayments: [],
      recentActivations: []
    });
  } catch (e) {
    console.error('GD admin users error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// POST /users/:id/notes — update user notes
router.post('/users/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;
    await query('UPDATE gd_users SET notes = $1 WHERE id = $2', [notes || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /payments — list payments with optional status filter
router.get('/payments', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT p.*, u.name as user_name, u.contact as user_contact
      FROM gd_payments p
      LEFT JOIN gd_users u ON u.id = p.user_id
    `;
    const params = [];
    if (status && ['pending', 'confirmed', 'rejected'].includes(status)) {
      sql += ' WHERE p.status = $1';
      params.push(status);
    }
    sql += ' ORDER BY p.created_at DESC';
    const payments = await query(sql, params);

    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      tab: 'payments',
      payments,
      filterStatus: status || 'all',
      stats: null,
      recentPayments: [],
      recentActivations: []
    });
  } catch (e) {
    console.error('GD admin payments error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// POST /payments/:id/confirm
router.post('/payments/:id/confirm', async (req, res) => {
  try {
    const sbUser = req.session.sbUser;
    await query(
      "UPDATE gd_payments SET status='confirmed', confirmed_by=$1, confirmed_at=NOW() WHERE id=$2",
      [sbUser.username, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /payments/:id/reject
router.post('/payments/:id/reject', async (req, res) => {
  try {
    await query("UPDATE gd_payments SET status='rejected' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /activations — list all activations
router.get('/activations', async (req, res) => {
  try {
    const [activations, users] = await Promise.all([
      query(`
        SELECT a.*, u.name as user_name, p.amount as payment_amount
        FROM gd_activations a
        LEFT JOIN gd_users u ON u.id = a.user_id
        LEFT JOIN gd_payments p ON p.id = a.payment_id
        ORDER BY a.created_at DESC
      `),
      query('SELECT id, name FROM gd_users ORDER BY name ASC')
    ]);

    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      tab: 'activations',
      activations,
      users,
      stats: null,
      recentPayments: [],
      recentActivations: []
    });
  } catch (e) {
    console.error('GD admin activations error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// POST /activations/create — create new activation code
router.post('/activations/create', async (req, res) => {
  try {
    const sbUser = req.session.sbUser;
    const { user_id, payment_id, valid_days, device_bind } = req.body;

    const days = parseInt(valid_days) || 30;
    const code = crypto.randomBytes(16).toString('hex');
    const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const newAct = await queryOne(
      `INSERT INTO gd_activations
        (user_id, payment_id, code, valid_until, device_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, valid_until`,
      [
        user_id || null,
        payment_id || null,
        code,
        validUntil,
        device_bind || '',
        sbUser.username
      ]
    );

    const url = `https://silicon-guandan-system.onrender.com/guandan?act=${code}`;
    const qr_dataurl = await QRCode.toDataURL(url);

    res.json({
      ok: true,
      id: newAct.id,
      code: newAct.code,
      url,
      qr_dataurl,
      valid_until: newAct.valid_until
    });
  } catch (e) {
    console.error('GD activation create error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// GET /activations/:id/qr — get QR for existing activation
router.get('/activations/:id/qr', async (req, res) => {
  try {
    const act = await queryOne('SELECT code FROM gd_activations WHERE id = $1', [req.params.id]);
    if (!act) return res.json({ ok: false, error: 'not found' });

    const url = `https://silicon-guandan-system.onrender.com/guandan?act=${act.code}`;
    const qr_dataurl = await QRCode.toDataURL(url);

    res.json({ ok: true, url, qr_dataurl });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ══════════ 计分器收费 全局开关 ══════════
// GET /billing — 当前开关状态
router.get('/billing', async (req, res) => {
  try {
    const en = await queryOne("SELECT sval FROM gd_settings WHERE skey='scorer_billing_enabled'");
    const si = await queryOne("SELECT sval FROM gd_settings WHERE skey='scorer_billing_since'");
    res.json({ ok: true, enabled: (en && en.sval === '1') ? 1 : 0, since: si ? si.sval : null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /billing — 开始/停止收费（仅管理员）
router.post('/billing', requireSbAdmin, async (req, res) => {
  try {
    const enable = (req.body && (req.body.enabled === '1' || req.body.enabled === 1 || req.body.enabled === true)) ? 1 : 0;
    const prev = await queryOne("SELECT sval FROM gd_settings WHERE skey='scorer_billing_enabled'");
    const wasEnabled = !!(prev && prev.sval === '1');
    await query(
      `INSERT INTO gd_settings (skey, sval, updated_at) VALUES ('scorer_billing_enabled', $1, NOW())
       ON CONFLICT (skey) DO UPDATE SET sval = $1, updated_at = NOW()`,
      [String(enable)]
    );
    // 仅在从"停"→"开"时刷新 2 周宽限起点；已在收费中不重置
    if (enable && !wasEnabled) {
      const nowIso = new Date().toISOString();
      await query(
        `INSERT INTO gd_settings (skey, sval, updated_at) VALUES ('scorer_billing_since', $1, NOW())
         ON CONFLICT (skey) DO UPDATE SET sval = $1, updated_at = NOW()`,
        [nowIso]
      );
    }
    const si = await queryOne("SELECT sval FROM gd_settings WHERE skey='scorer_billing_since'");
    res.json({ ok: true, enabled: enable, since: si ? si.sval : null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ══════════ 客服交流（用户 ↔ 管理员）══════════
// GET /support/threads — 会话列表（按设备聚合，含未读数与最后一条）
router.get('/support/threads', async (req, res) => {
  try {
    // 按来源App过滤（掼蛋计分器=scorer；网上赛事=online；赛事管理=tournament；报名=signup）
    const source = String(req.query.source || 'scorer').slice(0, 32);
    const threads = await query(`
      SELECT m.device_id,
             MAX(m.created_at) AS last_at,
             MAX(m.user_name) FILTER (WHERE m.user_name <> '') AS user_name,
             COUNT(*) FILTER (WHERE m.sender = 'user' AND m.read_by_admin = 0) AS unread,
             (SELECT body FROM gd_support_messages x WHERE x.device_id = m.device_id ORDER BY x.id DESC LIMIT 1) AS last_body
      FROM gd_support_messages m
      WHERE COALESCE(m.source,'scorer') = $1
      GROUP BY m.device_id
      ORDER BY last_at DESC
      LIMIT 300
    `, [source]);
    res.json({ ok: true, threads });
  } catch (e) {
    res.json({ ok: false, error: e.message, threads: [] });
  }
});

// GET /support/messages?device_id= — 某会话全部消息（并标记用户消息为管理员已读）
router.get('/support/messages', async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!device_id) return res.json({ ok: false, messages: [] });
    const messages = await query(
      "SELECT id, sender, body, user_name, created_at FROM gd_support_messages WHERE device_id=$1 ORDER BY id ASC LIMIT 500",
      [device_id]
    );
    query("UPDATE gd_support_messages SET read_by_admin=1 WHERE device_id=$1 AND sender='user' AND read_by_admin=0",
      [device_id]).catch(function () {});
    res.json({ ok: true, messages });
  } catch (e) {
    res.json({ ok: false, messages: [] });
  }
});

// ── 手机版客服「安装码」：生成/读取 token → 二维码 URL ──
async function ensureCsToken(regen) {
  let row = regen ? null : await queryOne("SELECT sval FROM gd_settings WHERE skey='cs_mobile_token'");
  if (row && row.sval) return row.sval;
  const token = crypto.randomBytes(18).toString('hex');
  await query(
    `INSERT INTO gd_settings (skey, sval, updated_at) VALUES ('cs_mobile_token', $1, NOW())
     ON CONFLICT (skey) DO UPDATE SET sval = $1, updated_at = NOW()`,
    [token]
  );
  return token;
}
async function csCodePayload(req, token) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const url = proto + '://' + req.get('host') + '/scoreboard/cs/' + token;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 1 });
  return { ok: true, url, qr };
}
// GET /cs-code — 取当前安装码（不存在则生成）
router.get('/cs-code', async (req, res) => {
  try {
    const token = await ensureCsToken(false);
    res.json(await csCodePayload(req, token));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
// POST /cs-code/regenerate — 重新生成（吊销旧码，仅管理员）
router.post('/cs-code/regenerate', requireSbAdmin, async (req, res) => {
  try {
    const token = await ensureCsToken(true);
    res.json(await csCodePayload(req, token));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /support/reply — 管理员回复某会话
router.post('/support/reply', async (req, res) => {
  try {
    const { device_id, body } = req.body || {};
    if (!device_id || !body || !String(body).trim()) return res.json({ ok: false, error: 'missing' });
    await query(
      "INSERT INTO gd_support_messages (device_id, user_name, sender, body) VALUES ($1,'客服','admin',$2)",
      [String(device_id).slice(0, 80), String(body).trim().slice(0, 1000)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
