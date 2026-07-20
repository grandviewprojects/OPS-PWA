// server/routes/workorders.js
const express = require('express');
const fs = require('fs');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');

const router = express.Router();
router.use(authRequired);

const VALID_STATUSES = ['new', 'assigned', 'in_progress', 'inspection_submitted', 'quote_sent', 'quote_accepted', 'completed', 'cancelled'];

function nextReference() {
  const row = db.prepare(`SELECT reference FROM work_orders ORDER BY created_at DESC LIMIT 1`).get();
  let n = 1;
  if (row && row.reference) {
    const m = row.reference.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return 'WO-' + String(n).padStart(5, '0');
}

function logActivity(workOrderId, userId, message) {
  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), workOrderId, userId, message, new Date().toISOString());
}

function notify(userId, message, link) {
  notifyUser(userId, 'assigned_work_order', message, link || '#/work-orders');
}

function syncCalendarForWorkOrder(wo) {
  // Remove old calendar entry for this work order, then (re)create if assigned + scheduled.
  db.prepare('DELETE FROM calendar_events WHERE work_order_id = ?').run(wo.id);
  if (wo.assigned_to && wo.scheduled_at && !['completed', 'cancelled'].includes(wo.status)) {
    const start = wo.scheduled_at;
    const end = new Date(new Date(start).getTime() + 2 * 60 * 60 * 1000).toISOString(); // default 2hr block
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO calendar_events (id,user_id,title,description,start_at,end_at,type,work_order_id,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), wo.assigned_to, `Work Order ${wo.reference}: ${wo.title}`, wo.description || '', start, end, 'work_order', wo.id, 'system', now, now);
  }
}

// List work orders — onsite team see only their own assignments by default
router.get('/', (req, res) => {
  const { status, assigned_to, overdue_only } = req.query;
  let sql = 'SELECT wo.*, u.name AS assignee_name, u.color AS assignee_color FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to WHERE 1=1';
  const params = [];

  if (req.user.role === 'onsite') {
    sql += ' AND wo.assigned_to = ?';
    params.push(req.user.id);
  } else if (assigned_to) {
    sql += ' AND wo.assigned_to = ?';
    params.push(assigned_to);
  }
  if (status) { sql += ' AND wo.status = ?'; params.push(status); }
  sql += ' ORDER BY wo.created_at DESC';

  let rows = db.prepare(sql).all(...params);
  if (overdue_only === 'true') {
    const now = new Date().toISOString();
    rows = rows.filter(r => r.status === 'inspection_submitted' && r.quote_due_at && r.quote_due_at < now);
  }
  res.json({ work_orders: rows });
});

router.get('/:id', (req, res) => {
  const wo = db.prepare('SELECT wo.*, u.name AS assignee_name, u.color AS assignee_color FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to WHERE wo.id = ?').get(req.params.id);
  if (!wo) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'onsite' && wo.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'This work order is not assigned to you' });
  }
  const activity = db.prepare('SELECT * FROM work_order_activity WHERE work_order_id = ? ORDER BY created_at DESC').all(req.params.id);
  const inspection = wo.inspection_report_id ? db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(wo.inspection_report_id) : null;
  const jobCard = wo.job_card_id ? db.prepare('SELECT * FROM job_cards WHERE id = ?').get(wo.job_card_id) : null;
  res.json({ work_order: wo, activity, inspection_report: inspection, job_card: jobCard });
});

// Create (internal — admin/operational). External portal submissions use /api/portal/work-orders instead.
router.post('/', requireRole('admin', 'operational'), (req, res) => {
  const { title, description, client_name, client_email, client_phone, site_address, priority, assigned_to, scheduled_at } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  const now = new Date().toISOString();
  const id = uuid();
  const reference = nextReference();
  const status = assigned_to ? 'assigned' : 'new';

  db.prepare(`INSERT INTO work_orders (id,reference,title,description,client_name,client_email,client_phone,site_address,priority,status,assigned_to,created_via,scheduled_at,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, reference, title, description || '', client_name || '', client_email || '', client_phone || '', site_address || '',
      priority || 'medium', status, assigned_to || null, 'internal', scheduled_at || null, req.user.id, now, now);

  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
  syncCalendarForWorkOrder(wo);
  logActivity(id, req.user.id, `Work order created${assigned_to ? ' and assigned' : ''} by ${req.user.name}`);
  if (assigned_to) notify(assigned_to, `New work order assigned: ${reference} — ${title}`, `#/work-orders/${id}`);

  res.status(201).json({ work_order: db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) });
});

// Update / assign a work order (admin/operational). Onsite can update status only for their own (e.g. start work).
router.put('/:id', (req, res) => {
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id);
  if (!wo) return res.status(404).json({ error: 'Not found' });

  const isStaff = req.user.role === 'admin' || req.user.role === 'operational';
  if (!isStaff && wo.assigned_to !== req.user.id) return res.status(403).json({ error: 'Not permitted' });

  const body = req.body || {};
  const updates = {};
  const allowedForOnsite = ['status'];
  const allowedForStaff = ['title', 'description', 'client_name', 'client_email', 'client_phone', 'site_address',
    'priority', 'assigned_to', 'scheduled_at', 'status'];
  const allowed = isStaff ? allowedForStaff : allowedForOnsite;

  for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f];

  if (updates.status && !VALID_STATUSES.includes(updates.status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }
  // Onsite users may only move status forward to in_progress (inspection flow handles inspection_submitted automatically)
  if (!isStaff && updates.status && !['in_progress'].includes(updates.status)) {
    return res.status(403).json({ error: 'You can only mark a work order as in progress. Submit an inspection report to advance it further.' });
  }

  const now = new Date().toISOString();
  const wasAssignedTo = wo.assigned_to;

  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).concat('updated_at = ?');
    const values = Object.values(updates).concat(now, req.params.id);
    db.prepare(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // Status side-effects
  if (updates.status === 'quote_sent') {
    db.prepare('UPDATE work_orders SET quote_sent_at = ? WHERE id = ?').run(now, req.params.id);
    logActivity(req.params.id, req.user.id, `Quote marked as sent by ${req.user.name} — SLA timer stopped`);
  }
  if (updates.status === 'quote_accepted') {
    db.prepare('UPDATE work_orders SET quote_accepted_at = ? WHERE id = ?').run(now, req.params.id);
    logActivity(req.params.id, req.user.id, `Quote marked as accepted by the client (recorded by ${req.user.name})`);
  }
  if (updates.status === 'completed') {
    db.prepare('UPDATE work_orders SET completed_at = ? WHERE id = ?').run(now, req.params.id);
    logActivity(req.params.id, req.user.id, `Work order marked completed by ${req.user.name}`);
  }
  if (updates.status === 'cancelled') {
    db.prepare('UPDATE work_orders SET cancelled_at = ? WHERE id = ?').run(now, req.params.id);
    logActivity(req.params.id, req.user.id, `Work order cancelled by ${req.user.name}`);
  }
  if (updates.status === 'in_progress') {
    logActivity(req.params.id, req.user.id, `${req.user.name} started work on site`);
  }

  if (updates.assigned_to !== undefined && updates.assigned_to !== wasAssignedTo) {
    if (updates.status === undefined && wo.status === 'new') {
      db.prepare('UPDATE work_orders SET status = ? WHERE id = ?').run('assigned', req.params.id);
    }
    logActivity(req.params.id, req.user.id, updates.assigned_to ? `Assigned by ${req.user.name}` : `Unassigned by ${req.user.name}`);
    if (updates.assigned_to) notify(updates.assigned_to, `Work order assigned: ${wo.reference} — ${wo.title}`, `#/work-orders/${wo.id}`);
  }

  const fresh = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id);
  syncCalendarForWorkOrder(fresh);

  res.json({ work_order: db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id) });
});

router.get('/:id/activity', (req, res) => {
  res.json({ activity: db.prepare('SELECT * FROM work_order_activity WHERE work_order_id = ? ORDER BY created_at DESC').all(req.params.id) });
});

// Add a note / comment to a work order. Any authenticated staff member, or the
// onsite user the order is assigned to, may add one. Adding a note stamps
// last_note_at, which the dashboard uses to clear "Needs attention" for 2 days.
router.post('/:id/notes', (req, res) => {
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id);
  if (!wo) return res.status(404).json({ error: 'Not found' });
  const isStaff = req.user.role === 'admin' || req.user.role === 'operational';
  if (!isStaff && wo.assigned_to !== req.user.id) return res.status(403).json({ error: 'Not permitted' });

  const message = (req.body && req.body.message ? String(req.body.message) : '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  const now = new Date().toISOString();
  logActivity(req.params.id, req.user.id, `${req.user.name}: ${message}`);
  db.prepare('UPDATE work_orders SET last_note_at = ?, updated_at = ? WHERE id = ?').run(now, now, req.params.id);

  res.status(201).json({ ok: true, activity: db.prepare('SELECT * FROM work_order_activity WHERE work_order_id = ? ORDER BY created_at DESC').all(req.params.id) });
});

// Permanently delete a work order — admin only. Cleans up calendar events,
// the inspection report and job card (and their uploaded photos + generated
// PDFs on disk), and the activity log. This cannot be undone.
router.delete('/:id', requireRole('admin'), (req, res) => {
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id);
  if (!wo) return res.status(404).json({ error: 'Not found' });

  const report = wo.inspection_report_id
    ? db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(wo.inspection_report_id)
    : null;
  const jobCard = wo.job_card_id
    ? db.prepare('SELECT * FROM job_cards WHERE id = ?').get(wo.job_card_id)
    : null;

  const filesToRemove = [];
  [report, jobCard].forEach((doc) => {
    if (!doc) return;
    try { (JSON.parse(doc.photos || '[]')).forEach(p => p.path && filesToRemove.push(p.path)); } catch (e) {}
    try {
      (JSON.parse(doc.sections || '[]')).forEach(s => {
        if (Array.isArray(s.photos)) s.photos.forEach(p => p.path && filesToRemove.push(p.path));
      });
    } catch (e) {}
    if (doc.pdf_path) filesToRemove.push(doc.pdf_path);
  });
  filesToRemove.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });

  // calendar_events.work_order_id has no FK cascade defined, so remove those explicitly.
  db.prepare('DELETE FROM calendar_events WHERE work_order_id = ?').run(req.params.id);

  // Deleting the work order cascades to its inspection_reports, job_cards, and
  // activity log automatically (all declared ON DELETE CASCADE).
  db.prepare('DELETE FROM work_orders WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

module.exports = router;
