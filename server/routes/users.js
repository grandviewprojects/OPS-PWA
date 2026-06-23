// server/routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uuid, n } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function publicUserRow(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

// List users. Admin & operational see everyone (need this to assign work/calendar).
// Onsite team sees a lightweight directory only (no private info, no email needed).
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  if (req.user.role === 'onsite') {
    return res.json({ users: rows.map(u => ({ id: u.id, name: u.name, role: u.role, photo: u.photo, color: u.color, job_title: u.job_title, active: u.active })) });
  }
  res.json({ users: rows.map(publicUserRow) });
});

// Get single profile. Private info included only for admin, or the user viewing themself (read-only on client).
router.get('/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'onsite' && req.user.id !== u.id) {
    // limited view of colleagues
    return res.json({ user: { id: u.id, name: u.name, role: u.role, photo: u.photo, color: u.color, job_title: u.job_title } });
  }

  const profile = publicUserRow(u);
  if (req.user.role === 'admin' || req.user.id === u.id) {
    profile.private_info = db.prepare('SELECT * FROM private_info WHERE user_id = ?').get(u.id) || null;
  }
  res.json({ user: profile });
});

// Create a profile (admin only)
router.post('/', requireRole('admin'), (req, res) => {
  const { name, email, password, role, phone, job_title, color } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password and role are required' });
  }
  if (!['admin', 'operational', 'onsite'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, operational or onsite' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
  if (existing) return res.status(409).json({ error: 'A user with that email already exists' });

  const now = new Date().toISOString();
  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id,name,email,password_hash,role,phone,job_title,color,active,must_change_password,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,1,?,?)`)
    .run(id, name.trim(), email.trim(), hash, role, phone || '', job_title || '', color || '#2563eb', now, now);
  db.prepare('INSERT INTO private_info (user_id, updated_at) VALUES (?,?)').run(id, now);
  db.prepare('INSERT INTO notification_preferences (user_id, updated_at) VALUES (?,?)').run(id, now);

  res.status(201).json({ user: publicUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

// Update core profile fields (admin only)
router.put('/:id', requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const fields = ['name', 'email', 'role', 'phone', 'job_title', 'color', 'active'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
  const now = new Date().toISOString();
  const sets = Object.keys(updates).map(k => `${k} = ?`).concat('updated_at = ?');
  const values = Object.values(updates).concat(now, req.params.id);
  if (Object.keys(updates).length === 0) return res.json({ user: publicUserRow(u) });
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  if (req.body.password) {
    const hash = bcrypt.hashSync(req.body.password, 10);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, req.params.id);
  }
  res.json({ user: publicUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
});

// Self-service: limited edits to your own profile (phone + color only — not name/role/email)
router.put('/me/self', (req, res) => {
  const { phone, color } = req.body || {};
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET phone = COALESCE(?, phone), color = COALESCE(?, color), updated_at = ? WHERE id = ?')
    .run(n(phone), n(color), now, req.user.id);
  res.json({ user: publicUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// Private info — view (admin or self), edit (admin only)
router.get('/:id/private', (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
    return res.status(403).json({ error: 'You cannot view this information' });
  }
  const info = db.prepare('SELECT * FROM private_info WHERE user_id = ?').get(req.params.id);
  res.json({ private_info: info || null });
});

router.put('/:id/private', requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const fields = ['id_number', 'date_of_birth', 'address', 'emergency_contact_name', 'emergency_contact_phone',
    'bank_details', 'salary_rate', 'contract_type', 'start_date', 'admin_notes'];
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT user_id FROM private_info WHERE user_id = ?').get(req.params.id);
  const vals = fields.map(f => req.body[f] ?? null);
  if (existing) {
    db.prepare(`UPDATE private_info SET ${fields.map(f => f + ' = ?').join(', ')}, updated_at = ?, updated_by = ? WHERE user_id = ?`)
      .run(...vals, now, req.user.id, req.params.id);
  } else {
    db.prepare(`INSERT INTO private_info (user_id, ${fields.join(', ')}, updated_at, updated_by) VALUES (?, ${fields.map(() => '?').join(', ')}, ?, ?)`)
      .run(req.params.id, ...vals, now, req.user.id);
  }
  res.json({ private_info: db.prepare('SELECT * FROM private_info WHERE user_id = ?').get(req.params.id) });
});

// Deactivate (soft delete) — admin only
router.delete('/:id', requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

// ---------------- Notification preferences (self-managed only — each person controls their own) ----------------
const { ensurePrefsRow } = require('../utils/notify');

router.get('/me/notification-preferences', (req, res) => {
  res.json({ preferences: ensurePrefsRow(req.user.id) });
});

router.put('/me/notification-preferences', (req, res) => {
  const fields = [
    'push_assigned_work_order', 'push_calendar_event_added', 'push_daily_checkin',
    'push_event_reminder', 'push_inspection_report_ready', 'push_new_portal_request'
  ];
  ensurePrefsRow(req.user.id); // make sure a row exists before updating
  const body = req.body || {};
  const now = new Date().toISOString();

  const sets = [];
  const vals = [];
  fields.forEach((f) => {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(body[f] ? 1 : 0); }
  });
  if (body.daily_checkin_time !== undefined && /^\d{2}:\d{2}$/.test(body.daily_checkin_time)) {
    sets.push('daily_checkin_time = ?');
    vals.push(body.daily_checkin_time);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now, req.user.id);
    db.prepare(`UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
  }
  res.json({ preferences: db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(req.user.id) });
});

module.exports = router;
