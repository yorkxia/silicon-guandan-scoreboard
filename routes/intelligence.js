const express = require('express');
const router  = express.Router();
const { query, queryOne } = require('../db/init');
const { requireSbAuth, requireSbAdmin } = require('../middleware/sbAuth');
const { runAllJobs } = require('../utils/scheduler');
const { RSS_SOURCES } = require('../utils/newsAggregator');
const { DEST_AIRPORTS } = require('../utils/flightSearcher');
const { DEFAULT_WATCHLIST } = require('../utils/stockAnalyzer');

// ─── GET /scoreboard/intelligence ────────────────────────────────────────────
router.get('/', requireSbAuth, async (req, res) => {
  try {
    const cfg = await queryOne('SELECT * FROM sb_intel_config WHERE id = 1') || {};

    // Latest news record
    const latestNews = await queryOne(
      'SELECT * FROM sb_intel_news ORDER BY fetched_at DESC LIMIT 1'
    );
    // History (last 10)
    const newsHistory = await query(
      'SELECT id, session_type, sources_used, fetched_at FROM sb_intel_news ORDER BY fetched_at DESC LIMIT 10'
    );

    // Latest stock record
    const latestStock = await queryOne(
      'SELECT * FROM sb_intel_stocks ORDER BY fetched_at DESC LIMIT 1'
    );
    // Parse watchlist data from latest stock record
    let latestWatchlist = [], latestMovers = { gainers: [], losers: [], active: [] };
    if (latestStock && latestStock.watchlist_json) {
      try {
        const parsed = JSON.parse(latestStock.watchlist_json);
        latestWatchlist = parsed.watchlistData || [];
        latestMovers    = parsed.movers || latestMovers;
      } catch(e) {}
    }

    // Latest flight record
    const latestFlight = await queryOne(
      'SELECT * FROM sb_intel_flights ORDER BY fetched_at DESC LIMIT 1'
    );
    let flightData = null;
    if (latestFlight && latestFlight.results_json) {
      try { flightData = JSON.parse(latestFlight.results_json); } catch(e) {}
    }

    res.render('scoreboard/intelligence', {
      sbUser:       req.session.sbUser,
      activePage:   'intelligence',
      cfg,
      latestNews,
      newsHistory:  newsHistory.rows || [],
      latestStock,
      latestWatchlist,
      latestMovers,
      flightData,
      latestFlight,
      rssSources:   RSS_SOURCES,
      destAirports: DEST_AIRPORTS,
      defaultWatchlist: DEFAULT_WATCHLIST,
      success: req.flash('success'),
      error:   req.flash('error'),
    });
  } catch (err) {
    console.error('[Intelligence] GET error:', err);
    req.flash('error', '加载失败：' + err.message);
    res.redirect('/scoreboard/dashboard');
  }
});

// ─── POST /scoreboard/intelligence/config ────────────────────────────────────
router.post('/config', requireSbAuth, requireSbAdmin, async (req, res) => {
  try {
    const {
      news_times, news_sources, news_email,
      flight_origin, flight_destinations, flight_cabin, flight_months, flight_email,
      stock_watchlist, anthropic_api_key, seats_aero_key,
    } = req.body;

    // news_sources is a multi-value array from checkboxes
    const sourcesStr = Array.isArray(news_sources)
      ? news_sources.join(',')
      : (news_sources || '');
    const destStr = Array.isArray(flight_destinations)
      ? flight_destinations.join(',')
      : (flight_destinations || '');

    await query(`
      UPDATE sb_intel_config SET
        news_times   = $1,
        news_sources = $2,
        news_email   = $3,
        flight_origin       = $4,
        flight_destinations = $5,
        flight_cabin        = $6,
        flight_months       = $7,
        flight_email        = $8,
        stock_watchlist     = $9,
        anthropic_api_key   = $10,
        seats_aero_key      = $11,
        updated_at   = NOW()
      WHERE id = 1
    `, [
      news_times || '07:30,11:30,17:00',
      sourcesStr,
      news_email || 'York.xia@gmail.com',
      flight_origin || 'SFO',
      destStr,
      flight_cabin || 'business',
      Number(flight_months) || 1,
      flight_email || 'York.xia@gmail.com',
      stock_watchlist || '',
      anthropic_api_key || '',
      seats_aero_key || '',
    ]);

    // Restart scheduler with new times
    const { startScheduler } = require('../utils/scheduler');
    await startScheduler();

    req.flash('success', '配置已保存，定时任务已更新');
    res.redirect('/scoreboard/intelligence');
  } catch (err) {
    console.error('[Intelligence] Config save error:', err);
    req.flash('error', '保存失败：' + err.message);
    res.redirect('/scoreboard/intelligence');
  }
});

// ─── POST /scoreboard/intelligence/run-now ───────────────────────────────────
router.post('/run-now', requireSbAuth, requireSbAdmin, async (req, res) => {
  const { job_type, session } = req.body;
  const label = session || '手动';
  try {
    if (job_type === 'news') {
      const { runNewsJob }   = require('../utils/scheduler');
      await runNewsJob(label);
    } else if (job_type === 'flight') {
      const { runFlightJob } = require('../utils/scheduler');
      await runFlightJob(label);
    } else if (job_type === 'stock') {
      const { runStockJob }  = require('../utils/scheduler');
      await runStockJob(label);
    } else {
      await runAllJobs(label);
    }
    req.flash('success', `✅ ${label} ${job_type || '全部'}任务已执行完毕`);
  } catch (err) {
    console.error('[Intelligence] Run-now error:', err);
    req.flash('error', '执行失败：' + err.message);
  }
  res.redirect('/scoreboard/intelligence');
});

// ─── GET /scoreboard/intelligence/news/:id ───────────────────────────────────
router.get('/news/:id', requireSbAuth, async (req, res) => {
  try {
    const record = await queryOne('SELECT * FROM sb_intel_news WHERE id = $1', [req.params.id]);
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
