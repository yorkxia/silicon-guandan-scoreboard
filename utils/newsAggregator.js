const Parser = require('rss-parser');

const RSS_SOURCES = {
  bbc:      { name: 'BBC News',        url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                            region: 'UK' },
  reuters:  { name: 'Reuters',         url: 'https://feeds.reuters.com/reuters/topNews',                               region: 'US' },
  cnn:      { name: 'CNN',             url: 'http://rss.cnn.com/rss/edition.rss',                                      region: 'US' },
  foxnews:  { name: 'Fox News',        url: 'https://moxie.foxnews.com/google-publisher/world.xml',                    region: 'US' },
  guardian: { name: 'The Guardian',    url: 'https://www.theguardian.com/world/rss',                                   region: 'UK' },
  ap:       { name: 'AP News',         url: 'https://feeds.apnews.com/rss/topnews',                                    region: 'US' },
  abc:      { name: 'ABC News',        url: 'https://abcnews.go.com/abcnews/topstories',                               region: 'US' },
  nbc:      { name: 'NBC News',        url: 'https://feeds.nbcnews.com/nbcnews/public/news',                           region: 'US' },
  france24: { name: 'France 24',       url: 'https://www.france24.com/en/rss',                                         region: 'EU' },
  cgtn:     { name: 'CGTN (CMG)',      url: 'https://www.cgtn.com/subscribe/rss/section/world.xml',                    region: 'CN' },
  rt:       { name: 'RT News',         url: 'https://www.rt.com/rss/',                                                 region: 'RU' },
  wsj:      { name: 'MarketWatch/WSJ', url: 'https://feeds.content.dowjones.io/public/rss/mktw_realtimeheadlines',     region: 'US' },
};

async function fetchSource(src, maxItems = 5) {
  const parser = new Parser({
    timeout: 9000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelBot/1.0)' }
  });
  try {
    const feed = await parser.parseURL(src.url);
    return feed.items.slice(0, maxItems).map(item => ({
      source: src.name,
      region: src.region,
      title: (item.title || '').trim(),
      snippet: (item.contentSnippet || item.summary || '').slice(0, 250),
    }));
  } catch (err) {
    console.warn(`[News] Failed ${src.name}: ${err.message}`);
    return [];
  }
}

async function fetchAllNews(enabledKeys) {
  const keys = enabledKeys && enabledKeys.length ? enabledKeys : Object.keys(RSS_SOURCES);
  const promises = keys.filter(k => RSS_SOURCES[k]).map(k => fetchSource(RSS_SOURCES[k]));
  const settled = await Promise.allSettled(promises);
  const articles = [];
  settled.forEach(r => { if (r.status === 'fulfilled') articles.push(...r.value); });
  return articles;
}

async function summarizeWithAI(articles, sessionLabel, apiKey) {
  // Build a plain text fallback regardless
  const byRegion = {};
  articles.forEach(a => {
    if (!byRegion[a.region]) byRegion[a.region] = [];
    byRegion[a.region].push(`[${a.source}] ${a.title}`);
  });
  const regionNames = { US: '美国', UK: '英国/欧洲', EU: '欧洲', CN: '中国', RU: '俄罗斯' };
  let fallback = `**${sessionLabel}全球新闻摘要**\n\n`;
  for (const [reg, items] of Object.entries(byRegion)) {
    fallback += `**${regionNames[reg] || reg}**\n`;
    items.slice(0, 4).forEach(h => { fallback += `• ${h}\n`; });
    fallback += '\n';
  }
  const sourceList = [...new Set(articles.map(a => a.source))].join('、');
  fallback += `*信息来源：${sourceList}*`;

  if (!apiKey) return fallback;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const rawText = articles.slice(0, 35).map(a =>
      `[${a.region}|${a.source}] ${a.title}: ${a.snippet}`
    ).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `你是一位专业国际新闻编辑。以下是来自全球主流媒体的${sessionLabel}头条新闻原文。请用中文撰写一篇200-400字的全球时事摘要，按地区分类（美国、欧洲、中国、俄罗斯等），语言简洁、客观、专业。最后一行单独列出信息来源。

新闻原文：
${rawText}

格式要求：
## ${sessionLabel}全球时事摘要

[按地区分类的200-400字中文摘要]

**来源：** [媒体名称列表]`
      }]
    });
    return msg.content[0].text;
  } catch (err) {
    console.error('[News] AI error:', err.message);
    return fallback;
  }
}

module.exports = { RSS_SOURCES, fetchAllNews, summarizeWithAI };
