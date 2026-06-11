function requireSbAuth(req, res, next) {
  if (req.session.sbUser) return next();
  req.flash('error', '请先登录 | Please login');
  res.redirect('/scoreboard/login');
}

function requireSbAdmin(req, res, next) {
  if (req.session.sbUser && req.session.sbUser.role === 'admin') return next();
  req.flash('error', '权限不足 | Access denied');
  res.redirect('/scoreboard/dashboard');
}

module.exports = { requireSbAuth, requireSbAdmin };
