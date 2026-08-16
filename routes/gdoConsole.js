/* 网上掼蛋赛事控制台 —— 对 4人 / 6人 在线对局与玩家做实时监控
   方案B：与游戏端共享同一个 Postgres，直接查 gdo_ / gdo6_ 表（与 guandan-admin 同模式）。
   四人：gdo_rooms / gdo_seats / gdo_rounds / gdo_queue
   六人：gdo6_rooms / gdo6_seats / gdo6_rounds / gdo6_queue（六人表无 game_mode，本身即 6p）
   玩家表 gdo_players 四人六人共用。 */
const express = require('express');
const router = express.Router();
const { query, pool } = require('../db/init');
const { requireSbAuth, requireSbAdmin } = require('../middleware/sbAuth');

// 全局管理员才能进网上掼蛋赛事控制台
router.use(requireSbAuth, requireSbAdmin);

// 模式 → 表名（白名单，杜绝表名注入）
const MODES = {
  '4p': { rooms: 'gdo_rooms',  seats: 'gdo_seats',  rounds: 'gdo_rounds',  is6: false },
  '6p': { rooms: 'gdo6_rooms', seats: 'gdo6_seats', rounds: 'gdo6_rounds', is6: true  }
};
const asMode = m => (m === '6p' ? '6p' : '4p');

/* ════════════ 实时快照：KPI + 活跃房间(含座位) + 玩家榜 ════════════ */

async function collectMode(m) {
  const t = MODES[m];
  const queueSql = t.is6
    ? `SELECT COUNT(*)::int AS c FROM gdo6_queue WHERE status='waiting'`
    : `SELECT COUNT(*)::int AS c FROM gdo_queue  WHERE status='waiting' AND game_mode='4p'`;

  const [kpiRows, roomRows] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(DISTINCT s.player_id) FROM ${t.seats} s
           JOIN ${t.rooms} r ON r.id = s.room_id
          WHERE s.is_connected = TRUE AND r.status IN ('waiting','playing'))::int AS online_players,
        (SELECT COUNT(*) FROM ${t.rooms} WHERE status IN ('waiting','playing'))::int AS active_rooms,
        (SELECT COUNT(*) FROM ${t.rooms} WHERE status = 'playing')::int              AS playing_rooms,
        (SELECT COUNT(*) FROM ${t.rooms} WHERE created_at >= CURRENT_DATE)::int       AS rooms_today,
        (SELECT COUNT(*) FROM ${t.rounds} WHERE finished_at >= CURRENT_DATE)::int     AS rounds_today,
        (SELECT COUNT(*) FROM ${t.seats} s JOIN ${t.rooms} r ON r.id = s.room_id
          WHERE s.is_connected = FALSE AND r.status IN ('waiting','playing'))::int    AS offline_seats,
        (${queueSql}) AS queue_waiting
    `),
    query(`
      SELECT r.id, r.room_code, r.room_type, r.status,
             r.level_team1, r.level_team2, r.round_count,
             r.wins_team1, r.wins_team2, r.created_at, r.started_at
        FROM ${t.rooms} r
       WHERE r.status IN ('waiting','playing')
       ORDER BY r.created_at DESC
       LIMIT 60
    `)
  ]);

  let seatRows = [];
  if (roomRows.length) {
    const ids = roomRows.map(r => r.id);
    seatRows = await query(`
      SELECT s.room_id, s.seat, s.team, s.is_ready, s.is_connected, p.display_name
        FROM ${t.seats} s
        JOIN gdo_players p ON p.id = s.player_id
       WHERE s.room_id = ANY($1)
       ORDER BY s.room_id, s.seat
    `, [ids]);
  }
  const byRoom = {};
  seatRows.forEach(s => { (byRoom[s.room_id] = byRoom[s.room_id] || []).push(s); });
  const roomsOut = roomRows.map(r => Object.assign({}, r, { seats: byRoom[r.id] || [] }));

  return { kpi: kpiRows[0], rooms: roomsOut };
}

async function collectSnapshot() {
  const [four, six, players] = await Promise.all([
    collectMode('4p'),
    collectMode('6p'),
    query(`
      SELECT display_name, games_played, games_won, last_active_at,
             source, country, region_code, city,
             (CASE WHEN games_played > 0 THEN ROUND(games_won * 100.0 / games_played) ELSE 0 END)::int AS win_rate,
             (last_active_at >= NOW() - INTERVAL '5 minutes') AS active_now
        FROM gdo_players
       ORDER BY last_active_at DESC NULLS LAST
       LIMIT 50
    `)
  ]);
  return { ts: Date.now(), four, six, players };
}

/* ════════════ 阶段4：房间流水 + 逐局明细 + CSV导出 ════════════ */

async function collectHistory(m) {
  const t = MODES[m];
  return query(`
    SELECT r.id, r.room_code, r.room_type, r.status,
           r.level_team1, r.level_team2, r.round_count,
           r.wins_team1, r.wins_team2, r.created_at, r.finished_at,
           EXTRACT(EPOCH FROM (COALESCE(r.finished_at, NOW()) - r.created_at))::int AS dur_sec
      FROM ${t.rooms} r
     ORDER BY r.created_at DESC
     LIMIT 100
  `);
}

async function roomDetail(m, id) {
  const t = MODES[m];
  return query(`
    SELECT round_number, winner_team, result_type,
           level_team1_after, level_team2_after, started_at, finished_at
      FROM ${t.rounds} WHERE room_id = $1 ORDER BY round_number
  `, [id]);
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ════════════ 阶段5：数据统计（趋势） ════════════ */

async function collectStats(m, days) {
  const t = MODES[m];
  const [daily, totalsRows, roundAvgRows, byType] = await Promise.all([
    query(`
      SELECT to_char(g.d::date, 'MM-DD') AS d,
             (SELECT COUNT(*) FROM ${t.rooms}  r WHERE DATE(r.created_at)  = g.d::date)::int AS rooms,
             (SELECT COUNT(*) FROM ${t.rounds} n WHERE DATE(n.finished_at) = g.d::date)::int AS rounds
        FROM generate_series(CURRENT_DATE - ($1 || ' days')::interval, CURRENT_DATE, '1 day') g(d)
       ORDER BY g.d
    `, [days]),
    query(`
      SELECT COUNT(*)::int AS total_rooms,
             COUNT(*) FILTER (WHERE status = 'finished')::int  AS finished_rooms,
             COUNT(*) FILTER (WHERE status = 'abandoned')::int AS abandoned_rooms
        FROM ${t.rooms}
    `),
    query(`
      SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))), 0)::int AS avg_round_sec
        FROM ${t.rounds} WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
    `),
    query(`SELECT room_type, COUNT(*)::int AS c FROM ${t.rooms} GROUP BY room_type ORDER BY c DESC`)
  ]);
  let byRegion = [];
  try {
    byRegion = await query(`
      SELECT COALESCE(NULLIF(region_code, ''), '未知') AS region_code, COUNT(*)::int AS c
        FROM gdo_visits
       WHERE game_mode = $1 AND visited_at >= CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY COALESCE(NULLIF(region_code, ''), '未知')
       ORDER BY c DESC LIMIT 12
    `, [m, days]);
  } catch (e) { byRegion = []; }   // gdo_visits 尚未建表/无数据时静默降级
  return { daily, totals: totalsRows[0], avg_round_sec: roundAvgRows[0].avg_round_sec, byType, byRegion };
}

/* ════════════ 路由 ════════════ */

// 页面（首屏带实时初始数据）
router.get('/', async (req, res) => {
  try {
    const snap = await collectSnapshot();
    res.render('scoreboard/gdo', { activePage: 'gdo', sbUser: req.session.sbUser, snap });
  } catch (e) {
    console.error('[网上掼蛋控制台] 页面错误:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// 实时轮询（前端每 8 秒）
router.get('/api', async (req, res) => {
  try { res.json(await collectSnapshot()); }
  catch (e) { console.error('[控制台/实时]', e.message); res.status(500).json({ error: e.message }); }
});

// ── 是否进贡：4 个开关（4人/6人 × 随机/亲友）。默认 '1'=进贡；'0'=不进贡 ──
const TRIBUTE_KEYS = ['gdo_tribute_4p_random', 'gdo_tribute_4p_private',
                      'gdo_tribute_6p_random', 'gdo_tribute_6p_private'];
router.get('/tribute', async (req, res) => {
  try {
    const rows = await query('SELECT skey, sval FROM gd_settings WHERE skey = ANY($1)', [TRIBUTE_KEYS]);
    const map = {}; rows.forEach(r => { map[r.skey] = r.sval; });
    const out = {};
    TRIBUTE_KEYS.forEach(k => { out[k] = (map[k] === '0') ? '0' : '1'; });   // 缺省=进贡
    res.json(out);
  } catch (e) { console.error('[控制台/进贡读取]', e.message); res.status(500).json({ error: e.message }); }
});
router.post('/tribute', express.json(), async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (TRIBUTE_KEYS.indexOf(key) < 0) return res.status(400).json({ error: 'bad key' });
    const val = (value === '0') ? '0' : '1';
    await query(
      `INSERT INTO gd_settings (skey, sval, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (skey) DO UPDATE SET sval = EXCLUDED.sval, updated_at = NOW()`,
      [key, val]
    );
    res.json({ ok: true, key, value: val });
  } catch (e) { console.error('[控制台/进贡保存]', e.message); res.status(500).json({ error: e.message }); }
});

// 房间流水（四人 + 六人）
router.get('/data/history', async (req, res) => {
  try {
    const [four, six] = await Promise.all([collectHistory('4p'), collectHistory('6p')]);
    res.json({ four, six });
  } catch (e) { console.error('[控制台/流水]', e.message); res.status(500).json({ error: e.message }); }
});

// 某房逐局明细
router.get('/room/:mode/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    res.json({ rounds: await roomDetail(asMode(req.params.mode), id) });
  } catch (e) { console.error('[控制台/逐局]', e.message); res.status(500).json({ error: e.message }); }
});

// 数据统计（趋势）
router.get('/data/stats', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 7), 60);
    const [four, six] = await Promise.all([collectStats('4p', days), collectStats('6p', days)]);
    res.json({ days, four, six });
  } catch (e) { console.error('[控制台/统计]', e.message); res.status(500).json({ error: e.message }); }
});

// CSV 导出（房间流水）
router.get('/export', async (req, res) => {
  try {
    const mode = asMode(req.query.mode);
    const rows = await collectHistory(mode);
    const head = ['房号', '类型', '状态', '甲级牌', '乙级牌', '局数', '甲盘胜', '乙盘胜', '时长秒', '创建时间', '结束时间'];
    const lines = [head.map(csvCell).join(',')];
    rows.forEach(r => lines.push([
      r.room_code, r.room_type, r.status, r.level_team1, r.level_team2,
      r.round_count, r.wins_team1, r.wins_team2, r.dur_sec,
      r.created_at ? new Date(r.created_at).toISOString() : '',
      r.finished_at ? new Date(r.finished_at).toISOString() : ''
    ].map(csvCell).join(',')));
    const csv = '﻿' + lines.join('\r\n');   // BOM：让 Excel 正确识别 UTF-8 中文
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gdo_${mode}_rooms_${Date.now()}.csv"`);
    res.send(csv);
  } catch (e) { console.error('[控制台/导出]', e.message); res.status(500).send('导出失败: ' + e.message); }
});

/* ════════════ 系统备份与恢复（仅管理员；控制台已 requireSbAdmin） ════════════ */

// 绿灯清理计划：与游戏端 scripts/db-maintain.js 完全一致；红线表不出现在任何 DELETE
const GREENLIGHT = [
  { name: '四人·已结束老房间(座位/轮次级联删)',
    count: `SELECT COUNT(*)::int AS c FROM gdo_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`,
    steps: [
      `DELETE FROM gdo_queue WHERE room_id IN (SELECT id FROM gdo_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1)`,
      `DELETE FROM gdo_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`
    ] },
  { name: '六人·已结束老房间(座位/轮次级联删)',
    count: `SELECT COUNT(*)::int AS c FROM gdo6_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`,
    steps: [
      `DELETE FROM gdo6_queue WHERE room_id IN (SELECT id FROM gdo6_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1)`,
      `DELETE FROM gdo6_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`
    ] },
  { name: '四人·瞬态匹配队列(非等待中)',
    count: `SELECT COUNT(*)::int AS c FROM gdo_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1`,
    steps: [`DELETE FROM gdo_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1`] },
  { name: '六人·瞬态匹配队列(非等待中)',
    count: `SELECT COUNT(*)::int AS c FROM gdo6_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1`,
    steps: [`DELETE FROM gdo6_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1`] },
  { name: 'play页访问日志 gdo_visits',
    count: `SELECT COUNT(*)::int AS c FROM gdo_visits WHERE visited_at < $1`,
    steps: [`DELETE FROM gdo_visits WHERE visited_at < $1`] },
  { name: '流量访问日志 sb_visits',
    count: `SELECT COUNT(*)::int AS c FROM sb_visits WHERE visited_at < $1`,
    steps: [`DELETE FROM sb_visits WHERE visited_at < $1`] },
];

// 全库 JSON 备份下载（导出所有表；供浏览器下载保存到本地）
router.get('/backup', async (req, res) => {
  try {
    const tbls = await query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    const data = {};
    for (const t of tbls) data[t.tablename] = await query(`SELECT * FROM "${t.tablename}"`);
    const payload = {
      meta: {
        generated_at: new Date().toISOString(),
        table_count: tbls.length,
        note: '硅谷掼蛋全库备份(JSON)。registrations 等为加密字段，恢复需配合 ENCRYPTION_KEY。'
      },
      data
    };
    const fname = 'gdb_backup_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.json';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(JSON.stringify(payload));
  } catch (e) {
    console.error('[控制台/备份]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 清理：dryRun 预览行数 / confirm==='DELETE' 才真正执行（单事务，失败回滚）
router.post('/cleanup', async (req, res) => {
  try {
    const body = req.body || {};
    const months = parseInt(body.months, 10);
    const dryRun = !!body.dryRun;
    if (!months || months < 1) return res.status(400).json({ error: '请指定保留月数(≥1)' });
    if (!dryRun && body.confirm !== 'DELETE') return res.status(400).json({ error: '确认词不正确，请输入 DELETE' });

    const cut = await query(`SELECT (now() - make_interval(months => $1)) AS cutoff`, [months]);
    const cutoff = cut[0].cutoff;

    const items = [];
    for (const it of GREENLIGHT) {
      const r = await query(it.count, [cutoff]);
      items.push({ name: it.name, n: r[0].c });
    }
    const total = items.reduce((a, b) => a + b.n, 0);

    if (dryRun) return res.json({ dryRun: true, months, cutoff, items, total });

    const client = await pool.connect();
    let deleted = 0;
    try {
      await client.query('BEGIN');
      for (const it of GREENLIGHT) {
        for (const sql of it.steps) {
          const r = await client.query(sql, [cutoff]);
          deleted += r.rowCount || 0;
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, months, deleted, total });
  } catch (e) {
    console.error('[控制台/清理]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ════════════ 🤖 机器人测试系统：读写 gd_settings 开关 + 展示状态（游戏服 botRunner 每 20s 轮询生效）════════════ */
async function botGet(k, dflt) {
  try { const r = await query('SELECT sval FROM gd_settings WHERE skey=$1', [k]); return (r.length && r[0].sval != null) ? r[0].sval : dflt; }
  catch (e) { return dflt; }
}
async function botSet(k, v) {
  await query(`INSERT INTO gd_settings(skey,sval,updated_at) VALUES($1,$2,NOW())
               ON CONFLICT (skey) DO UPDATE SET sval=$2, updated_at=NOW()`, [k, String(v)]);
}
/* 可选：配了 GAME_BASE_URL(或 BOT_TICK_URL)+BOT_TICK_KEY 时，best-effort 通知游戏服立即唤醒并生效 */
async function nudgeGame() {
  try {
    const base = process.env.GAME_BASE_URL || process.env.BOT_TICK_URL;
    const key  = process.env.BOT_TICK_KEY  || process.env.BOT_SECRET;
    if (!base || typeof fetch !== 'function') return;
    await fetch(base.replace(/\/$/, '') + '/internal/bot-tick?key=' + encodeURIComponent(key || ''), { method: 'GET' }).catch(() => {});
  } catch (e) {}
}

router.get('/bots', async (req, res) => {
  try {
    const [enabled, cEnabled, cMonths, statusRaw, cleanTs] = await Promise.all([
      botGet('bot_sim_enabled', '0'), botGet('bot_sim_cleanup_enabled', '0'),
      botGet('bot_sim_cleanup_months', '2'), botGet('bot_sim_status', ''),
      botGet('bot_sim_cleanup_last_ts', '')
    ]);
    let status = null; try { status = statusRaw ? JSON.parse(statusRaw) : null; } catch (e) {}
    res.render('scoreboard/gdo-bots', {
      activePage: 'gdo-bots', sbUser: req.session.sbUser,
      enabled: enabled === '1', cleanupEnabled: cEnabled === '1',
      cleanupMonths: parseInt(cMonths, 10) || 2, status, cleanupLast: cleanTs ? Number(cleanTs) : 0
    });
  } catch (e) { res.status(500).send('机器人页面加载失败：' + e.message); }
});

router.get('/bots/status', async (req, res) => {
  try {
    const raw = await botGet('bot_sim_status', '');
    let status = null; try { status = raw ? JSON.parse(raw) : null; } catch (e) {}
    res.json({ ok: true, enabled: (await botGet('bot_sim_enabled', '0')) === '1', status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/bots/toggle', express.json(), async (req, res) => {
  try {
    const on = !!(req.body && req.body.enabled);
    await botSet('bot_sim_enabled', on ? '1' : '0');
    nudgeGame();
    res.json({ ok: true, enabled: on });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/bots/cleanup-config', express.json(), async (req, res) => {
  try {
    const on = !!(req.body && req.body.enabled);
    let months = parseInt(req.body && req.body.months, 10);
    if (!(months >= 1)) months = 2; if (months > 24) months = 24;
    await botSet('bot_sim_cleanup_enabled', on ? '1' : '0');
    await botSet('bot_sim_cleanup_months', String(months));
    res.json({ ok: true, enabled: on, months });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
