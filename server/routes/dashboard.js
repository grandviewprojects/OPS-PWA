// server/routes/dashboard.js
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  const now = new Date().toISOString();

  if (req.user.role === 'onsite') {
    const myOrders = db.prepare("SELECT * FROM work_orders WHERE assigned_to = ? AND status NOT IN ('completed','cancelled') ORDER BY scheduled_at IS NULL, scheduled_at").all(req.user.id);
    const upcomingEvents = db.prepare('SELECT * FROM calendar_events WHERE user_id = ? AND end_at >= ? ORDER BY start_at LIMIT 10').all(req.user.id, now);
    return res.json({ role: 'onsite', my_work_orders: myOrders, upcoming_events: upcomingEvents });
  }

  // admin / operational overview
  const counts = db.prepare(`SELECT status, COUNT(*) AS c FROM work_orders GROUP BY status`).all();
  const overdueQuotes = db.prepare(`SELECT wo.*, u.name AS assignee_name FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to
    WHERE wo.status = 'inspection_submitted' AND wo.quote_due_at < ? ORDER BY wo.quote_due_at`).all(now);
  const dueSoonQuotes = db.prepare(`SELECT wo.*, u.name AS assignee_name FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to
    WHERE wo.status = 'inspection_submitted' AND wo.quote_due_at >= ? ORDER BY wo.quote_due_at`).all(now);
  const newRequests = db.prepare(`SELECT * FROM work_orders WHERE status = 'new' ORDER BY created_at DESC LIMIT 20`).all();
  const unassigned = db.prepare(`SELECT * FROM work_orders WHERE assigned_to IS NULL AND status NOT IN ('completed','cancelled') ORDER BY created_at`).all();

  res.json({
    role: req.user.role,
    status_counts: counts,
    overdue_quotes: overdueQuotes,
    due_soon_quotes: dueSoonQuotes,
    new_requests: newRequests,
    unassigned_work_orders: unassigned
  });
});

router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ notifications: rows });
});

router.put('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.put('/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
