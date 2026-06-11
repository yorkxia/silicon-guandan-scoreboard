const cron = require('node-cron');
const { query, queryOne } = require('../db/init');
const { fetchAllNews, summarizeWithAI } = require('./newsAggregator');
const { analyzeStocks } = require('./stockAnalyzer');
const { searchFlights, formatFlightText } = require('./flightSearcher');

let activeTasks = [];

function sessionLabel(h) {
  if (h < 12) return '早上';
  if (h < 17) return '中午';
  return '晚上';
}

async function getCfg() {
  try {
    return (await queryOne('SELECT * FROM sb_intel_config WHERE id = 1')) || {};
  } catch (e) { return {}; }
}

function mdToHtml(md, title) {
  const body = md
    .replace(/^## (.+)$/gm,  '<h2 style="color:#1a5276;margin-top:20px">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#2874a6">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^• (.+)$/gm,   '<li style="margin:3px 0">$1</li>')
    .replace(/^  • (.+)$/gm, '<li style="margin:2px 0;margin-left:20px">$1</li>')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px">
    <div style="background:linear-gradient(135deg,#1a3a5c,#2874a6);color:#fff;padding:18px 24px;border-radius:10px 10px 0 0">
      <h1 style="margin:0;font-size:1.25rem">🌐 ${title}</h1>
      <p style="margin:4px 0 0;font-size:0.82rem;opacity:.75">硅谷监控系统 · 自动生成 · ${new Date().toLocaleString('zh-CN',{timeZone:'America/Los_Angeles'})}</p>
    </div>
    <div style="background:#f8f9fa;padding:22px;border-radius:0 0 10px 10px;line-height:1.8;color:#333">${body}</div>
  </div>`;
}

async function runNewsJob(label) {
  console.log(`[Scheduler] News job → ${label}`);
  const cfg = await getCfg();
  const sources = cfg.news_sources ? cfg.news_sources.split(',').map(s => s.trim()) : null;
  const articles = await fetchAllNews(sources);
  if (!articles.length) { console.warn('[Scheduler] No articles fetched'); return; }

  const summary = await summarizeWithAI(articles, label, cfg.anthropic_api_key);
  await query(
    'INSERT INTO sb_intel_news (session_type, summary, sources_used) VALUES ($1,$2,$3)',
    [label, summary, [...new Set(articles.map(a => a.source))].join(', ')]
  );

  // Email
  const { sendIntelEmail } = require('./email');
  const dateStr = new Date().toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric', timeZone:'America/Los_Angeles' });
  await sendIntelEmail({
    to: cfg.news_email || 'York.xia@gmail.com',
    subject: `${dateStr} ${label}新闻摘要`,
    html: mdToHtml(summary, `${dateStr} ${label}全球时事摘要`),
  }).catch(e => console.error('[Scheduler] News email error:', e.message));
}

async function runFlightJob(label) {
  console.log(`[Scheduler] Flight job → ${label}`);
  const cfg = await getCfg();
  const destinations = cfg.flight_destinations ? cfg.flight_destinations.split(',').map(s => s.trim()) : null;
  const data = await searchFlights({
    origin:       cfg.flight_origin || 'SFO',
    destinations,
    cabin:        cfg.flight_cabin || 'business',
    months:       Number(cfg.flight_months) || 1,
    seatsAeroKey: cfg.seats_aero_key,
  });

  await query(
    'INSERT INTO sb_intel_flights (session_type, results_json, origin, cabin) VALUES ($1,$2,$3,$4)',
    [label, JSON.stringify(data), data.origin, data.cabin || 'business']
  );

  if (data.results && data.results.length > 0) {
    const { sendIntelEmail } = require('./email');
    const dateStr = new Date().toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric', timeZone:'America/Los_Angeles' });
    const text = formatFlightText(data, label);
    await sendIntelEmail({
      to: cfg.flight_email || 'York.xia@gmail.com',
      subject: `${dateStr} ${label}旅行信息`,
      html: mdToHtml(text, `${dateStr} ${label}积分商务舱机票`),
    }).catch(e => console.error('[Scheduler] Flight email error:', e.message));
  }
}

async function runStockJob(label) {
  console.log(`[Scheduler] Stock job → ${label}`);
  const cfg = await getCfg();
  const watchlist = cfg.stock_watchlist ? cfg.stock_watchlist.split(',').map(s => s.trim()).filter(Boolean) : null;
  const { watchlistData, movers, analysis } = await analyzeStocks(watchlist, label, cfg.anthropic_api_key);
  await query(
    'INSERT INTO sb_intel_stocks (session_type, analysis, watchlist_json) VALUES ($1,$2,$3)',
    [label, analysis, JSON.stringify({ watchlistData, movers })]
  );
}

async function runAllJobs(label) {
  await Promise.allSettled([
    runNewsJob(label),
    runFlightJob(label),
    runStockJob(label),
  ]);
}

function parseTimes(str) {
  return (str || '07:30,11:30,17:00').split(',').map(t => {
    const [h, m] = t.trim().split(':').map(Number);
    return { h: h || 0, m: m || 0 };
  });
}

async function startScheduler() {
  activeTasks.forEach(t => { try { t.destroy(); } catch(e) {} });
  activeTasks = [];
  const cfg = await getCfg();
  const times = parseTimes(cfg.news_times);
  times.forEach(({ h, m }) => {
    const expr = `${m} ${h} * * *`;
    const label = sessionLabel(h);
    const task = cron.schedule(expr, () => {
      console.log(`[Scheduler] ⏰ Triggered ${label} (${h}:${String(m).padStart(2,'0')} PST)`);
      runAllJobs(label).catch(e => console.error('[Scheduler] Job error:', e.message));
    }, { timezone: 'America/Los_Angeles' });
    activeTasks.push(task);
    console.log(`[Scheduler] ✅ Registered ${label} @ ${h}:${String(m).padStart(2,'0')} PST`);
  });
  console.log(`[Scheduler] ${activeTasks.length} scheduled tasks active`);
}

module.exports = { startScheduler, runAllJobs, runNewsJob, runFlightJob, runStockJob };
