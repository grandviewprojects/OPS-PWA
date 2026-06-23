// server/routes/leads.js
const express = require('express');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('admin', 'marketing'));

const VALID_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];

function logActivity(leadId, userId, message) {
  db.prepare('INSERT INTO lead_activity (id,lead_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), leadId, userId, message, new Date().toISOString());
}

// CRM pipeline is shared across the whole marketing team — everyone sees every lead.
router.get('/', (req, res) => {
  let sql = `SELECT l.*, u.name AS assignee_name, u.color AS assignee_color
             FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE 1=1`;
  const params = [];
  if (req.query.status) { sql += ' AND l.status = ?'; params.push(req.query.status); }
  if (req.query.assigned_to) { sql += ' AND l.assigned_to = ?'; params.push(req.query.assigned_to); }
  sql += ' ORDER BY l.updated_at DESC';
  res.json({ leads: db.prepare(sql).all(...params) });
});

router.get('/:id', (req, res) => {
  const lead = db.prepare(`SELECT l.*, u.name AS assignee_name, u.color AS assignee_color FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const activity = db.prepare('SELECT la.*, u.name AS user_name FROM lead_activity la LEFT JOIN users u ON u.id = la.user_id WHERE lead_id = ? ORDER BY la.created_at DESC').all(req.params.id);
  res.json({ lead, activity });
});

router.post('/', (req, res) => {
  const { name, company, email, phone, source, value, notes, assigned_to } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO leads (id,name,company,email,phone,source,status,value,notes,assigned_to,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'new',?,?,?,?,?,?)`)
    .run(id, name, company || '', email || '', phone || '', source || '', value || '', notes || '', assigned_to || req.user.id, req.user.id, now, now);

  logActivity(id, req.user.id, `Lead added by ${req.user.name}`);
  if (assigned_to && assigned_to !== req.user.id) {
    notifyUser(assigned_to, 'assigned_work_order', `${req.user.name} assigned you a lead: "${name}"`, `#/leads/${id}`);
  }

  res.status(201).json({ lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(id) });
});

router.put('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const { name, company, email, phone, source, status, value, notes, assigned_to } = req.body || {};
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const now = new Date().toISOString();
  const sets = [];
  const vals = [];
  const fieldMap = { name, company, email, phone, source, status, value, notes, assigned_to };
  Object.entries(fieldMap).forEach(([k, v]) => { if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); } });
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now, req.params.id);
    db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  if (status && status !== lead.status) logActivity(req.params.id, req.user.id, `${req.user.name} moved this lead to "${status}"`);
  if (assigned_to && assigned_to !== lead.assigned_to) {
    logActivity(req.params.id, req.user.id, `Reassigned by ${req.user.name}`);
    if (assigned_to !== req.user.id) notifyUser(assigned_to, 'assigned_work_order', `${req.user.name} assigned you a lead: "${name || lead.name}"`, `#/leads/${req.params.id}`);
  }

  res.json({ lead: db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id) });
});

router.post('/:id/activity', (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  logActivity(req.params.id, req.user.id, message);
  db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
  res.status(201).json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
