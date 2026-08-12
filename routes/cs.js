/* 手机版在线客服客户端（管理员用）
   通过后台生成的"安装码(二维码)"访问：URL 内含一次性长随机 token，
   iPhone 扫码打开 → 添加到主屏 → 免登录直接与计分器用户对话。
   token 存 gd_settings.cs_mobile_token，可在后台重新生成以吊销旧码。*/
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db/init');

async function currentToken() {
  const r = await queryOne("SELECT sval FROM gd_settings WHERE skey='cs_mobile_token'");
  return r ? r.sval : null;
}
async function tokenOk(t) {
  if (!t) return false;
  const cur = await currentToken();
  return !!cur && cur === t;
}
function denyPage(res) {
  return res.status(403).send(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:-apple-system,sans-serif;text-align:center;margin-top:80px;color:#444;padding:20px">' +
    '<div style="font-size:44px">🔒</div><h2>安装码无效或已更新</h2>' +
    '<p style="color:#888">请从「掼蛋计分器系统管理 → 客服交流」重新获取安装码</p></div>');
}

// 手机客服页
router.get('/:token', async (req, res) => {
  try {
    if (!(await tokenOk(req.params.token))) return denyPage(res);
    res.render('scoreboard/cs-mobile', { token: req.params.token });
  } catch (e) {
    res.status(500).send('Error');
  }
});

// 会话列表
router.get('/:token/threads', async (req, res) => {
  try {
    if (!(await tokenOk(req.params.token))) return res.status(403).json({ ok: false, threads: [] });
    // 按来源App过滤（掼蛋计分器=scorer；其他App暂无数据）
    const source = String(req.query.source || 'scorer').slice(0, 32);
    const threads = await query(`
      SELECT m.device_id,
             MAX(m.created_at) AS last_at,
             MAX(m.user_name)   FILTER (WHERE m.user_name <> '')   AS user_name,
             MAX(m.user_city)   FILTER (WHERE m.user_city <> '')   AS user_city,
             MAX(m.user_region) FILTER (WHERE m.user_region <> '') AS user_region,
             COUNT(*) FILTER (WHERE m.sender = 'user' AND m.read_by_admin = 0) AS unread,
             (SELECT body FROM gd_support_messages x WHERE x.device_id = m.device_id ORDER BY x.id DESC LIMIT 1) AS last_body
      FROM gd_support_messages m
      WHERE COALESCE(m.source,'scorer') = $1
      GROUP BY m.device_id
      ORDER BY last_at DESC
      LIMIT 300
    `, [source]);
    res.json({ ok: true, threads });
  } catch (e) {
    res.json({ ok: false, threads: [] });
  }
});

// 某会话消息（并标记用户消息为管理员已读）
router.get('/:token/messages', async (req, res) => {
  try {
    if (!(await tokenOk(req.params.token))) return res.status(403).json({ ok: false, messages: [] });
    const { device_id } = req.query;
    if (!device_id) return res.json({ ok: false, messages: [] });
    const messages = await query(
      "SELECT id, sender, body, user_name, user_city, user_region, device_info, created_at FROM gd_support_messages WHERE device_id=$1 ORDER BY id ASC LIMIT 500",
      [device_id]
    );
    query("UPDATE gd_support_messages SET read_by_admin=1 WHERE device_id=$1 AND sender='user' AND read_by_admin=0",
      [device_id]).catch(function () {});
    res.json({ ok: true, messages });
  } catch (e) {
    res.json({ ok: false, messages: [] });
  }
});

// 管理员(手机)回复
router.post('/:token/reply', async (req, res) => {
  try {
    if (!(await tokenOk(req.params.token))) return res.status(403).json({ ok: false });
    const { device_id, body } = req.body || {};
    if (!device_id || !body || !String(body).trim()) return res.json({ ok: false, error: 'missing' });
    await query(
      "INSERT INTO gd_support_messages (device_id, user_name, sender, body) VALUES ($1,'客服','admin',$2)",
      [String(device_id).slice(0, 80), String(body).trim().slice(0, 1000)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
