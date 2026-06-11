const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const { query, queryOne } = require('../db/init');
const { requireSbAuth, requireSbAdmin } = require('../middleware/sbAuth');

// All routes require auth
router.use(requireSbAuth);

// GET / — Dashboard
router.get('/', async (req, res) => {
  try {
    const [
      totalUsersRow,
      pendingPaymentsRow,
      confirmedPaymentsRow,
      activeActivationsRow,
      recentPayments,
      recentActivations
    ] = await Promise.all([
      queryOne('SELECT COUNT(*) as c FROM gd_users'),
      queryOne("SELECT COUNT(*) as c FROM gd_payments WHERE status = 'pending'"),
      queryOne("SELECT COUNT(*) as c FROM gd_payments WHERE status = 'confirmed'"),
      queryOne('SELECT COUNT(*) as c FROM gd_activations WHERE valid_until > NOW()'),
      query(`
        SELECT p.*, u.name as user_name, u.contact as user_contact
        FROM gd_payments p
        LEFT JOIN gd_users u ON u.id = p.user_id
        ORDER BY p.created_at DESC LIMIT 10
      `),
      query(`
        SELECT a.*, u.name as user_name
        FROM gd_activations a
        LEFT JOIN gd_users u ON u.id = a.user_id
        ORDER BY a.created_at DESC LIMIT 10
      `)
    ]);

    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      stats: {
        totalUsers: parseInt(totalUsersRow.c),
        pendingPayments: parseInt(pendingPaymentsRow.c),
        confirmedPayments: parseInt(confirmedPaymentsRow.c),
        activeActivations: parseInt(activeActivationsRow.c)
      },
      recentPayments,
      recentActivations
    });
  } catch (e) {
    console.error('GD admin dashboard error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// GET /users — list all users
router.get('/users', async (req, res) => {
  try {
    const users = await query(`
      SELECT u.*,
        COUNT(DISTINCT p.id) as payment_count,
        MAX(a.valid_until) as latest_activation
      FROM gd_users u
      LEFT JOIN gd_payments p ON p.user_id = u.id
      LEFT JOIN gd_activations a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      tab: 'users',
      users,
      stats: null,
      recentPayments: [],
      recentActivations: []
    });
  } catch (e) {
    console.error('GD admin users error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// POST /users/:id/notes — update user notes
router.post('/users/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;
    await query('UPDATE gd_users SET notes = $1 WHERE id = $2', [notes || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /payments — list payments with optional status filter
router.get('/payments', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT p.*, u.name as user_name, u.contact as user_contact
      FROM gd_payments p
      LEFT JOIN gd_users u ON u.id = p.user_id
    `;
    const params = [];
    if (status && ['pending', 'confirmed', 'rejected'].includes(status)) {
      sql += ' WHERE p.status = $1';
      params.push(status);
    }
    sql += ' ORDER BY p.created_at DESC';
    const payments = await query(sql, params);

    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      tab: 'payments',
      payments,
      filterStatus: status || 'all',
      stats: null,
      recentPayments: [],
      recentActivations: []
    });
  } catch (e) {
    console.error('GD admin payments error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// POST /payments/:id/confirm
router.post('/payments/:id/confirm', async (req, res) => {
  try {
    const sbUser = req.session.sbUser;
    await query(
      "UPDATE gd_payments SET status='confirmed', confirmed_by=$1, confirmed_at=NOW() WHERE id=$2",
      [sbUser.username, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /payments/:id/reject
router.post('/payments/:id/reject', async (req, res) => {
  try {
    await query("UPDATE gd_payments SET status='rejected' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /activations — list all activations
router.get('/activations', async (req, res) => {
  try {
    const [activations, users] = await Promise.all([
      query(`
        SELECT a.*, u.name as user_name, p.amount as payment_amount
        FROM gd_activations a
        LEFT JOIN gd_users u ON u.id = a.user_id
        LEFT JOIN gd_payments p ON p.id = a.payment_id
        ORDER BY a.created_at DESC
      `),
      query('SELECT id, name FROM gd_users ORDER BY name ASC')
    ]);

    res.render('scoreboard/guandan-admin', {
      activePage: 'guandan-admin',
      sbUser: req.session.sbUser,
      tab: 'activations',
      activations,
      users,
      stats: null,
      recentPayments: [],
      recentActivations: []
    });
  } catch (e) {
    console.error('GD admin activations error:', e.message);
    res.status(500).send('Server Error: ' + e.message);
  }
});

// POST /activations/create — create new activation code
router.post('/activations/create', async (req, res) => {
  try {
    const sbUser = req.session.sbUser;
    const { user_id, payment_id, valid_days, device_bind } = req.body;

    const days = parseInt(valid_days) || 30;
    const code = crypto.randomBytes(16).toString('hex');
    const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const newAct = await queryOne(
      `INSERT INTO gd_activations
        (user_id, payment_id, code, valid_until, device_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, valid_until`,
      [
        user_id || null,
        payment_id || null,
        code,
        validUntil,
        device_bind || '',
        sbUser.username
      ]
    );

    const url = `https://silicon-guandan-system.onrender.com/guandan?act=${code}`;
    const qr_dataurl = await QRCode.toDataURL(url);

    res.json({
      ok: true,
      id: newAct.id,
      code: newAct.code,
      url,
      qr_dataurl,
      valid_until: newAct.valid_until
    });
  } catch (e) {
    console.error('GD activation create error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// GET /activations/:id/qr — get QR for existing activation
router.get('/activations/:id/qr', async (req, res) => {
  try {
    const act = await queryOne('SELECT code FROM gd_activations WHERE id = $1', [req.params.id]);
    if (!act) return res.json({ ok: false, error: 'not found' });

    const url = `https://silicon-guandan-system.onrender.com/guandan?act=${act.code}`;
    const qr_dataurl = await QRCode.toDataURL(url);

    res.json({ ok: true, url, qr_dataurl });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
