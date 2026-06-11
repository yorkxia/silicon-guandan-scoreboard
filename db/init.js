const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_super_admin SMALLINT DEFAULT 0,
      is_locked SMALLINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      title_zh TEXT NOT NULL,
      title_en TEXT NOT NULL,
      description_zh TEXT DEFAULT '',
      description_en TEXT DEFAULT '',
      date TEXT DEFAULT '',
      location_zh TEXT DEFAULT '',
      location_en TEXT DEFAULT '',
      max_participants INTEGER DEFAULT 100,
      fee INTEGER DEFAULT 10,
      venmo TEXT DEFAULT '@yorkxia',
      payment_type TEXT DEFAULT 'Venmo',
      status TEXT DEFAULT 'active',
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      wechat_qr TEXT DEFAULT '',
      wechat_note TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL,
      name_enc TEXT NOT NULL,
      phone_enc TEXT NOT NULL,
      email_enc TEXT,
      payment_confirmed SMALLINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      team_name_enc TEXT,
      partner_name_enc TEXT,
      backup_partner_name_enc TEXT,
      random_partner SMALLINT DEFAULT 0
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS page_content (
      id SERIAL PRIMARY KEY,
      page TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value_zh TEXT,
      value_en TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page, key_name)
    )
  `);

  // Default admin
  const adminExists = await queryOne('SELECT id FROM users WHERE username = $1', ['admin']);
  if (!adminExists) {
    const hash = bcrypt.hashSync('Admin2025!', 12);
    await query('INSERT INTO users (username, password_hash, is_super_admin) VALUES ($1, $2, 1)', ['admin', hash]);
    console.log('✅ Default admin created: admin / Admin2025!');
  }

  // Default page content
  const defaultContent = [
    { page: 'home', key: 'hero_title', zh: '硅谷掼蛋联赛', en: 'Silicon Valley Guandan League' },
    { page: 'home', key: 'hero_subtitle', zh: '🐎 2026马年春季联赛 · 现在报名参赛！', en: '🐎 2026 Year of the Horse Spring Tournament · Register Now!' },
    { page: 'home', key: 'hero_desc', zh: '欢迎参加硅谷最具活力的掼蛋比赛，与高手同台竞技，展示您的牌技！', en: 'Join the most vibrant Guandan tournament in Silicon Valley. Compete with the best!' },
    { page: 'home', key: 'about_title', zh: '关于掼蛋', en: 'About Guandan' },
    { page: 'home', key: 'about_text', zh: '掼蛋是一种流行于中国的四人纸牌游戏，分成两队对抗，以最先出完所有手牌为目标。比赛融合了策略、技巧与团队配合，老少皆宜，趣味横生！', en: 'Guandan is a popular Chinese card game for four players split into two teams. The goal is to be the first team to play all your cards. It combines strategy, skill, and teamwork — fun for all ages!' },
    { page: 'home', key: 'payment_note', zh: '报名费 $10，请通过 Venmo 支付至', en: 'Registration fee $10, please pay via Venmo to' },
    { page: 'register', key: 'title', zh: '比赛报名', en: 'Tournament Registration' },
    { page: 'register', key: 'subtitle', zh: '填写以下信息完成报名，并通过 Venmo 支付报名费', en: 'Complete the form below and pay via Venmo to register' },
    { page: 'register', key: 'payment_note', zh: '请在提交报名后，通过 Venmo 向 @yorkxia 支付 $10 报名费，并在备注中注明参赛者姓名和赛事名称。', en: 'After submitting, please pay $10 via Venmo to @yorkxia. Include your name and tournament name in the note.' },
    { page: 'register', key: 'wechat_note', zh: '或通过微信扫码支付 $10 报名费，请在备注中注明您的姓名和赛事名称。', en: 'Or scan the WeChat QR code to pay $10. Include your name and tournament name in the payment note.' },
    { page: 'register', key: 'wechat_qr', zh: '', en: '' },
  ];
  for (const c of defaultContent) {
    await query(
      'INSERT INTO page_content (page, key_name, value_zh, value_en) VALUES ($1, $2, $3, $4) ON CONFLICT (page, key_name) DO NOTHING',
      [c.page, c.key, c.zh, c.en]
    );
  }
  // ============ 掼蛋监控模块 sb_* 表 ============
  await query(`
    CREATE TABLE IF NOT EXISTS sb_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'regional',
      display_name TEXT DEFAULT '',
      is_active SMALLINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_regions (
      id SERIAL PRIMARY KEY,
      country TEXT NOT NULL,
      area_code TEXT UNIQUE NOT NULL,
      area_name_zh TEXT NOT NULL,
      area_name_en TEXT NOT NULL,
      cities TEXT DEFAULT '',
      assigned_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_ads (
      id SERIAL PRIMARY KEY,
      region_id INTEGER,
      title TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      content_text TEXT DEFAULT '',
      content_url TEXT DEFAULT '',
      link_url TEXT DEFAULT '',
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      is_active SMALLINT DEFAULT 1,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_visits (
      id SERIAL PRIMARY KEY,
      ip_hash TEXT DEFAULT '',
      country TEXT DEFAULT '',
      region_code TEXT DEFAULT '',
      city TEXT DEFAULT '',
      page TEXT DEFAULT 'scoreboard',
      user_agent TEXT DEFAULT '',
      visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_user_regions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      UNIQUE(user_id, region_id)
    )
  `);

  // ============ 时事与股票形势模块 sb_intel_* 表 ============
  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_config (
      id           INTEGER PRIMARY KEY DEFAULT 1,
      news_times   TEXT DEFAULT '07:30,11:30,17:00',
      news_sources TEXT DEFAULT 'bbc,reuters,cnn,foxnews,ap,abc,nbc,guardian,france24,cgtn,rt,wsj',
      news_email   TEXT DEFAULT 'York.xia@gmail.com',
      flight_origin       TEXT DEFAULT 'SFO',
      flight_destinations TEXT DEFAULT '欧洲,日本,台湾,韩国,香港,上海,南京',
      flight_cabin        TEXT DEFAULT 'business',
      flight_months       INTEGER DEFAULT 1,
      flight_email        TEXT DEFAULT 'York.xia@gmail.com',
      stock_watchlist     TEXT DEFAULT 'AAPL,NVDA,MSFT,GOOG,META,AMZN,TSLA,AMD,NFLX,AVGO',
      anthropic_api_key   TEXT DEFAULT '',
      seats_aero_key      TEXT DEFAULT '',
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`INSERT INTO sb_intel_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_news (
      id           SERIAL PRIMARY KEY,
      session_type TEXT NOT NULL,
      summary      TEXT NOT NULL,
      sources_used TEXT DEFAULT '',
      fetched_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_flights (
      id           SERIAL PRIMARY KEY,
      session_type TEXT NOT NULL,
      results_json TEXT NOT NULL,
      origin       TEXT DEFAULT 'SFO',
      cabin        TEXT DEFAULT 'business',
      fetched_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_stocks (
      id           SERIAL PRIMARY KEY,
      session_type TEXT NOT NULL,
      analysis     TEXT NOT NULL,
      watchlist_json TEXT DEFAULT '{}',
      fetched_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：添加 frequency_minutes 列（如果不存在）
  await query(`ALTER TABLE sb_ads ADD COLUMN IF NOT EXISTS frequency_minutes INTEGER DEFAULT NULL`);
  // 迁移：添加 backup_partner_name_enc 列（如果不存在）
  await query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS backup_partner_name_enc TEXT`);
  // 迁移：添加 payment_type 列（如果不存在）
  await query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'Venmo'`);

  // 默认 sb admin
  const sbAdminExists = await queryOne('SELECT id FROM sb_users WHERE username = $1', ['sbadmin']);
  if (!sbAdminExists) {
    const hash = bcrypt.hashSync('SbAdmin2026!', 12);
    await query('INSERT INTO sb_users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4)',
      ['sbadmin', hash, 'admin', '监控管理员']);
    console.log('✅ Scoreboard admin created: sbadmin / SbAdmin2026!');
  }

  // 默认地理区域
  const regionDefaults = [
    { country: 'US', code: 'US-WEST',    zh: '美国西部',   en: 'US West',    cities: '洛杉矶,旧金山,硅谷,西雅图,圣何塞' },
    { country: 'US', code: 'US-EAST',    zh: '美国东部',   en: 'US East',    cities: '纽约,华盛顿DC,波士顿,费城' },
    { country: 'US', code: 'US-SOUTH',   zh: '美国南部',   en: 'US South',   cities: '休斯顿,迈阿密,亚特兰大,达拉斯' },
    { country: 'US', code: 'US-CENTRAL', zh: '美国中部',   en: 'US Central', cities: '芝加哥,丹佛,明尼阿波利斯' },
    { country: 'US', code: 'US-NORTH',   zh: '美国北部',   en: 'US North',   cities: '底特律,克利夫兰,水牛城' },
    { country: 'CA', code: 'CA-WEST',    zh: '加拿大西部', en: 'CA West',    cities: '温哥华,维多利亚,卡尔加里' },
    { country: 'CA', code: 'CA-EAST',    zh: '加拿大东部', en: 'CA East',    cities: '多伦多,渥太华,蒙特利尔,魁北克' },
    { country: 'CA', code: 'CA-CENTRAL', zh: '加拿大中部', en: 'CA Central', cities: '温尼伯,萨斯卡通,里贾纳' },
    { country: 'CN', code: 'CN',         zh: '中国大陆',   en: 'China',      cities: '北京,上海,深圳,广州,成都' },
    { country: 'TW', code: 'TW',         zh: '台湾',       en: 'Taiwan',     cities: '台北,高雄,台中' },
    { country: 'HK', code: 'HK',         zh: '香港',       en: 'Hong Kong',  cities: '香港' },
    { country: 'GLOBAL', code: 'GLOBAL', zh: '全球其他',   en: 'Global',     cities: '' },
  ];
  for (const r of regionDefaults) {
    await query(
      'INSERT INTO sb_regions (country, area_code, area_name_zh, area_name_en, cities) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (area_code) DO NOTHING',
      [r.country, r.code, r.zh, r.en, r.cities]
    );
  }

  console.log('✅ Database initialized');
}

module.exports = { query, queryOne, initDB };
