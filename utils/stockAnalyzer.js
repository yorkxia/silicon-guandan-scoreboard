const DEFAULT_WATCHLIST = ['AAPL', 'NVDA', 'MSFT', 'GOOG', 'META', 'AMZN', 'TSLA', 'AMD', 'NFLX', 'AVGO'];

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: dec });
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
}

async function getYahooFinance() {
  try {
    const yf = require('yahoo-finance2');
    return yf.default || yf;
  } catch (e) {
    console.warn('[Stock] yahoo-finance2 not available:', e.message);
    return null;
  }
}

async function fetchWatchlist(symbols) {
  const yf = await getYahooFinance();
  if (!yf) return [];
  const results = [];
  for (const sym of symbols.slice(0, 25)) {
    try {
      const q = await yf.quote(sym);
      results.push({
        symbol: sym,
        name: q.longName || q.shortName || sym,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePct: q.regularMarketChangePercent,
        volume: q.regularMarketVolume,
        marketCap: q.marketCap,
        dayHigh: q.regularMarketDayHigh,
        dayLow: q.regularMarketDayLow,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow,
      });
    } catch (err) {
      console.warn(`[Stock] Quote failed for ${sym}: ${err.message}`);
    }
  }
  return results;
}

async function fetchMovers() {
  const yf = await getYahooFinance();
  if (!yf) return { gainers: [], losers: [], active: [] };
  try {
    const [g, l, a] = await Promise.allSettled([
      yf.screener({ scrIds: 'day_gainers',  count: 8 }),
      yf.screener({ scrIds: 'day_losers',   count: 8 }),
      yf.screener({ scrIds: 'most_actives', count: 8 }),
    ]);
    return {
      gainers: g.status === 'fulfilled' ? (g.value.quotes || []) : [],
      losers:  l.status === 'fulfilled' ? (l.value.quotes || []) : [],
      active:  a.status === 'fulfilled' ? (a.value.quotes || []) : [],
    };
  } catch (err) {
    console.error('[Stock] Movers error:', err.message);
    return { gainers: [], losers: [], active: [] };
  }
}

async function analyzeStocks(watchlistSymbols, sessionLabel, apiKey) {
  const symbols = (watchlistSymbols && watchlistSymbols.length) ? watchlistSymbols : DEFAULT_WATCHLIST;
  const [watchlistData, movers] = await Promise.all([fetchWatchlist(symbols), fetchMovers()]);

  // Build plain text summary
  let plainText = `## ${sessionLabel}股票行情\n\n`;
  plainText += `### 自选股\n`;
  watchlistData.forEach(s => {
    const arrow = (s.changePct || 0) >= 0 ? '▲' : '▼';
    plainText += `${s.symbol}: $${fmt(s.price)} ${arrow}${fmtPct(s.changePct)} | Vol: ${fmt(s.volume, 0)}\n`;
  });

  plainText += `\n### 今日涨幅榜\n`;
  movers.gainers.slice(0, 5).forEach(s => {
    plainText += `${s.symbol}: $${fmt(s.regularMarketPrice)} ${fmtPct(s.regularMarketChangePercent)}\n`;
  });

  plainText += `\n### 今日跌幅榜\n`;
  movers.losers.slice(0, 5).forEach(s => {
    plainText += `${s.symbol}: $${fmt(s.regularMarketPrice)} ${fmtPct(s.regularMarketChangePercent)}\n`;
  });

  plainText += `\n### 成交最活跃\n`;
  movers.active.slice(0, 5).forEach(s => {
    plainText += `${s.symbol}: $${fmt(s.regularMarketPrice)} ${fmtPct(s.regularMarketChangePercent)} | Vol: ${fmt(s.regularMarketVolume, 0)}\n`;
  });

  if (!apiKey) {
    return { watchlistData, movers, analysis: plainText };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `你是一位资深华尔街股票分析师。请根据以下${sessionLabel}美国股市数据，用中文撰写一份300-500字的专业分析报告。内容包括：
1. 大盘整体走势判断
2. 科技股重点分析（尤其是NVDA、AAPL、MSFT、META等）
3. 今日最值得关注的机会与风险
4. 短线操作参考（声明：仅供参考，不构成投资建议）

数据：
${plainText}`
      }]
    });
    return { watchlistData, movers, analysis: msg.content[0].text };
  } catch (err) {
    console.error('[Stock] AI error:', err.message);
    return { watchlistData, movers, analysis: plainText };
  }
}

module.exports = { analyzeStocks, fetchWatchlist, fetchMovers, DEFAULT_WATCHLIST, fmt, fmtPct };
