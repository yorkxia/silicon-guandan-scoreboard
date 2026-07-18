/* 网上掼蛋赛事控制台 —— 对 4人 / 6人 在线对局与玩家做实时监控
   方案B：与游戏端共享同一个 Postgres，直接查 gdo_ / gdo6_ 表（与 guandan-admin 同模式）。
   四人：gdo_rooms / gdo_seats / gdo_rounds / gdo_queue
   六人：gdo6_rooms / gdo6_seats / gdo6_rounds / gdo6_queue（六人表无 game_mode，本身即 6p）
   玩家表 gdo_players 四人六人共用。 */
const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
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
  return { daily, totals: totalsRows[0], avg_round_sec: roundAvgRows[0].avg_round_sec, byType };
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

module.exports = router;
