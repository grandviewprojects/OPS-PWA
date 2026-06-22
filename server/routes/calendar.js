// server/routes/calendar.js
const express = require('express');
const { db, uuid, n } = require('../db');
const { authRequired } = require('../middleware/auth');
const { sendPushToUser } = require('../utils/push');

const router = express.Router();
router.use(authRequired);

function canManage(req, targetUserId) {
  // Admin & operational can add/edit events on ANY calendar.
  // Onsite team can only manage events on their own calendar.
  if (req.user.role === 'admin' || req.user.role === 'operational') return true;
  return req.user.id === targetUserId;
}

// Get events for a user within an optional date range
router.get('/:userId', (req, res) => {
  if (req.user.role === 'onsite' && req.user.id !== req.params.userId) {
    return res.status(403).json({ error: 'You can only view your own calendar' });
  }
  const { from, to } = req.query;
  let sql = 'SELECT * FROM calendar_events WHERE user_id = ?';
  const params = [req.params.userId];
  if (from) { sql += ' AND end_at >= ?'; params.push(from); }
  if (to) { sql += ' AND start_at <= ?'; params.push(to); }
  sql += ' ORDER BY start_at';
  res.json({ events: db.prepare(sql).all(...params) });
});

// Get all events across all calendars (admin/operational overview)
router.get('/', (req, res) => {
  if (req.user.role === 'onsite') return res.status(403).json({ error: 'Not permitted' });
  const { from, to } = req.query;
  let sql = `SELECT ce.*, u.name AS user_name, u.color AS user_color FROM calendar_events ce
             JOIN users u ON u.id = ce.user_id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND ce.end_at >= ?'; params.push(from); }
  if (to) { sql += ' AND ce.start_at <= ?'; params.push(to); }
  sql += ' ORDER BY ce.start_at';
  res.json({ events: db.prepare(sql).all(...params) });
});

router.post('/', (req, res) => {
  const { user_id, title, description, start_at, end_at, type } = req.body || {};
  if (!user_id || !title || !start_at || !end_at) {
    return res.status(400).json({ error: 'user_id, title, start_at and end_at are required' });
  }
  if (!canManage(req, user_id)) return res.status(403).json({ error: 'Not permitted to add events to this calendar' });

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO calendar_events (id,user_id,title,description,start_at,end_at,type,work_order_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, user_id, title, description || '', start_at, end_at, type || 'manual', null, req.user.id, now, now);

  if (user_id !== req.user.id) {
    const msg = `${req.user.name} added "${title}" to your calendar`;
    db.prepare('INSERT INTO notifications (id,user_id,message,link,read,created_at) VALUES (?,?,?,?,0,?)')
      .run(uuid(), user_id, msg, '#/calendar', now);
    sendPushToUser(user_id, { title: 'New calendar event', body: msg, link: '#/calendar' }).catch(() => {});
  }
  res.status(201).json({ event: db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) });
});

router.put('/:id', (req, res) => {
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, ev.user_id)) return res.status(403).json({ error: 'Not permitted' });
  if (ev.type === 'work_order') return res.status(400).json({ error: 'Work order events update automatically — edit the work order instead.' });

  const { title, description, start_at, end_at } = req.body || {};
  const now = new Date().toISOString();
  db.prepare('UPDATE calendar_events SET title=COALESCE(?,title), description=COALESCE(?,description), start_at=COALESCE(?,start_at), end_at=COALESCE(?,end_at), updated_at=? WHERE id=?')
    .run(n(title), n(description), n(start_at), n(end_at), now, req.params.id);
  res.json({ event: db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, ev.user_id)) return res.status(403).json({ error: 'Not permitted' });
  if (ev.type === 'work_order') return res.status(400).json({ error: 'Cannot delete a work order calendar entry directly — reassign or cancel the work order.' });
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
