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

/* 取某一模式（四人/六人）的实时快照：KPI + 活跃房间(含座位) */
async function collectMode(cfg) {
  const { rooms, seats, rounds } = cfg;
  const queueSql = cfg.is6
    ? `SELECT COUNT(*)::int AS c FROM gdo6_queue WHERE status='waiting'`
    : `SELECT COUNT(*)::int AS c FROM gdo_queue  WHERE status='waiting' AND game_mode='4p'`;

  const [kpiRows, roomRows] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(DISTINCT s.player_id) FROM ${seats} s
           JOIN ${rooms} r ON r.id = s.room_id
          WHERE s.is_connected = TRUE AND r.status IN ('waiting','playing'))::int AS online_players,
        (SELECT COUNT(*) FROM ${rooms} WHERE status IN ('waiting','playing'))::int AS active_rooms,
        (SELECT COUNT(*) FROM ${rooms} WHERE status = 'playing')::int              AS playing_rooms,
        (SELECT COUNT(*) FROM ${rooms} WHERE created_at >= CURRENT_DATE)::int       AS rooms_today,
        (SELECT COUNT(*) FROM ${rounds} WHERE finished_at >= CURRENT_DATE)::int     AS rounds_today,
        (SELECT COUNT(*) FROM ${seats} s JOIN ${rooms} r ON r.id = s.room_id
          WHERE s.is_connected = FALSE AND r.status IN ('waiting','playing'))::int  AS offline_seats,
        (${queueSql}) AS queue_waiting
    `),
    query(`
      SELECT r.id, r.room_code, r.room_type, r.status,
             r.level_team1, r.level_team2, r.round_count,
             r.wins_team1, r.wins_team2, r.created_at, r.started_at
        FROM ${rooms} r
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
        FROM ${seats} s
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

/* 完整快照：四人 + 六人 + 活跃玩家榜 */
async function collectSnapshot() {
  const [four, six, players] = await Promise.all([
    collectMode({ rooms: 'gdo_rooms',  seats: 'gdo_seats',  rounds: 'gdo_rounds',  is6: false }),
    collectMode({ rooms: 'gdo6_rooms', seats: 'gdo6_seats', rounds: 'gdo6_rounds', is6: true  }),
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

// 页面（首屏带初始数据）
router.get('/', async (req, res) => {
  try {
    const snap = await collectSnapshot();
    res.render('scoreboard/gdo', { activePage: 'gdo', sbUser: req.session.sbUser, snap });
  } catch (e) {
    console.error('[网上掼蛋控制台] 页面错误:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// 轮询接口（前端每隔数秒拉取，准实时刷新）
router.get('/api', async (req, res) => {
  try {
    res.json(await collectSnapshot());
  } catch (e) {
    console.error('[网上掼蛋控制台] API错误:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
