require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const path = require('path');
const { initDB } = require('./db/init');
const scoreboardRoutes = require('./routes/scoreboard');
const intelligenceRoutes = require('./routes/intelligence');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'scoreboard-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.user = req.session.sbUser || null;
  next();
});

app.use('/scoreboard', scoreboardRoutes);
app.use('/scoreboard/intelligence', intelligenceRoutes);

app.get('/', (req, res) => res.redirect('/scoreboard/login'));
app.use((req, res) => res.redirect('/scoreboard/login'));

const PORT = process.env.PORT || 3001;
initDB().then(async () => {
  const { startScheduler } = require('./utils/scheduler');
  await startScheduler().catch(e => console.error('Scheduler init error:', e.message));
  app.listen(PORT, () => {
    console.log(`\n✅ 流量监控系统已启动 | Scoreboard Monitor running`);
    console.log(`   访问地址: http://localhost:${PORT}`);
    console.log(`   登录入口: http://localhost:${PORT}/scoreboard/login`);
    console.log(`   默认账号: sbadmin / SbAdmin2026!\n`);
  });
}).catch(err => {
  console.error('❌ Database init failed:', err);
  process.exit(1);
});
