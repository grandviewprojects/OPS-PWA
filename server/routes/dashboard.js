// server/routes/dashboard.js
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const PIPELINE_STAGES = [
  { key: 'new',                  label: 'New',               hint: 'Received — not yet assigned',             color: '#6c757d' },
  { key: 'assigned',             label: 'Assessment Pending', hint: 'Assigned — assessment not yet done',     color: '#0d6efd' },
  { key: 'in_progress',          label: 'In Progress',        hint: 'Work actively underway',                 color: '#fd7e14' },
  { key: 'inspection_submitted', label: 'Quote Needed',       hint: 'Report in — quote not yet sent',         color: '#dc3545' },
  { key: 'quote_sent',           label: 'Quote Sent',         hint: 'Quote sent — awaiting client approval',  color: '#6f42c1' },
  { key: 'completed',            label: 'Completed',          hint: 'Work done',                              color: '#198754' },
];

function daysInStage(wo) {
  const now = Date.now();
  let since;
  switch (wo.status) {
    case 'inspection_submitted': since = wo.inspection_submitted_at; break;
    case 'quote_sent':           since = wo.quote_sent_at;           break;
    case 'completed':            since = wo.completed_at;            break;
    default:                     since = wo.created_at;              break;
  }
  if (!since) return null;
  return Math.floor((now - new Date(since).getTime()) / (1000 * 60 * 60 * 24));
}

router.get('/', (req, res) => {
  const now = new Date().toISOString();

  // ── Onsite: unchanged ─────────────────────────────────────────────────────
  if (req.user.role === 'onsite') {
    const myOrders = db.prepare(
      "SELECT * FROM work_orders WHERE assigned_to = ? AND status NOT IN ('completed','cancelled') ORDER BY scheduled_at IS NULL, scheduled_at"
    ).all(req.user.id);
    const upcomingEvents = db.prepare(
      'SELECT * FROM calendar_events WHERE user_id = ? AND end_at >= ? ORDER BY start_at LIMIT 10'
    ).all(req.user.id, now);
    return res.json({ role: 'onsite', my_work_orders: myOrders, upcoming_events: upcomingEvents });
  }

  // ── Admin / Operational ───────────────────────────────────────────────────
  const allActive = db.prepare(`
    SELECT wo.*, u.name AS assignee_name
    FROM work_orders wo
    LEFT JOIN users u ON u.id = wo.assigned_to
    WHERE wo.status != 'cancelled'
    ORDER BY
      CASE wo.status
        WHEN 'new'                  THEN 1
        WHEN 'assigned'             THEN 2
        WHEN 'in_progress'          THEN 3
        WHEN 'inspection_submitted' THEN 4
        WHEN 'quote_sent'           THEN 5
        WHEN 'completed'            THEN 6
        ELSE 7
      END,
      wo.created_at ASC
  `).all();

  allActive.forEach(wo => { wo.days_in_stage = daysInStage(wo); });

  // Pipeline buckets (all stages — used for the summary bar counts)
  const pipeline = PIPELINE_STAGES.map(stage => ({
    ...stage,
    count: allActive.filter(wo => wo.status === stage.key).length,
    items: allActive.filter(wo => wo.status === stage.key),
  }));

  // Dedicated sections
  const jobsInProgress = allActive.filter(wo => wo.status === 'in_progress');
  const jobsCompleted  = allActive.filter(wo => wo.status === 'completed');

  // Needs-attention slices
  const overdueQuotes = allActive.filter(
    wo => wo.status === 'inspection_submitted' && wo.quote_due_at && wo.quote_due_at < now
  );
  const unassigned = allActive.filter(
    wo => !wo.assigned_to && !['completed', 'cancelled'].includes(wo.status)
  );
  const stalledQuotes = allActive.filter(wo => {
    if (wo.status !== 'quote_sent' || !wo.quote_sent_at) return false;
    return (Date.now() - new Date(wo.quote_sent_at).getTime()) > 7 * 24 * 60 * 60 * 1000;
  });

  res.json({
    role: req.user.role,
    pipeline,
    jobs_in_progress: jobsInProgress,
    jobs_completed:   jobsCompleted,
    overdue_quotes:   overdueQuotes,
    unassigned,
    stalled_quotes:   stalledQuotes,
    total_active: allActive.filter(wo => !['completed', 'cancelled'].includes(wo.status)).length,
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
