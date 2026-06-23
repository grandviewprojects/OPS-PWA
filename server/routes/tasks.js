// server/routes/tasks.js
const express = require('express');
const { db, uuid, n } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('admin', 'operational', 'marketing'));

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

function logActivity(taskId, userId, message) {
  db.prepare('INSERT INTO task_activity (id,task_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), taskId, userId, message, new Date().toISOString());
}

function canManage(req, task) {
  return req.user.role === 'admin' || req.user.id === task.assigned_to;
}

// List tasks. Admin sees everything; everyone else sees only tasks assigned to them.
router.get('/', (req, res) => {
  let sql = `SELECT t.*, u.name AS assignee_name, u.color AS assignee_color, c.name AS creator_name
             FROM tasks t
             LEFT JOIN users u ON u.id = t.assigned_to
             LEFT JOIN users c ON c.id = t.created_by
             WHERE 1=1`;
  const params = [];
  if (req.user.role !== 'admin') {
    sql += ' AND t.assigned_to = ?';
    params.push(req.user.id);
  } else if (req.query.assigned_to) {
    sql += ' AND t.assigned_to = ?';
    params.push(req.query.assigned_to);
  }
  if (req.query.status) { sql += ' AND t.status = ?'; params.push(req.query.status); }
  sql += ' ORDER BY (t.due_at IS NULL), t.due_at, t.created_at DESC';
  res.json({ tasks: db.prepare(sql).all(...params) });
});

router.get('/:id', (req, res) => {
  const task = db.prepare(`SELECT t.*, u.name AS assignee_name, u.color AS assignee_color, c.name AS creator_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by WHERE t.id = ?`).get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, task)) return res.status(403).json({ error: 'Not permitted' });
  const activity = db.prepare('SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ task, activity });
});

// Create a task. Admin can delegate to any operational/marketing team member.
// Operational/marketing can only create tasks for themselves.
router.post('/', (req, res) => {
  const { title, description, due_at } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  let assignedTo = req.body.assigned_to;
  if (req.user.role === 'admin') {
    if (!assignedTo) return res.status(400).json({ error: 'assigned_to is required when delegating a task' });
    const assignee = db.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').get(assignedTo);
    if (!assignee || !['operational', 'marketing'].includes(assignee.role)) {
      return res.status(400).json({ error: 'Tasks can only be delegated to operational or marketing team members' });
    }
  } else {
    assignedTo = req.user.id; // operational/marketing can only create tasks for themselves
  }

  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO tasks (id,title,description,assigned_to,created_by,status,due_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',?,?,?)`)
    .run(id, title, description || '', assignedTo, req.user.id, due_at || null, now, now);

  logActivity(id, req.user.id, assignedTo === req.user.id ? `${req.user.name} created this task` : `Delegated by ${req.user.name}`);

  if (assignedTo !== req.user.id) {
    notifyUser(assignedTo, 'assigned_work_order', `${req.user.name} assigned you a task: "${title}"`, `#/tasks/${id}`);
  }

  res.status(201).json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) });
});

// Update a task — the assignee (their own task) or admin (any task). This is
// also how timers/deadlines get set: due_at is just another editable field.
router.put('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, task)) return res.status(403).json({ error: 'Not permitted' });

  const { title, description, due_at, status } = req.body || {};
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  // Reassignment is an admin-only action (delegation power stays with admin).
  let assignedTo;
  if (req.user.role === 'admin' && req.body.assigned_to !== undefined) {
    const assignee = db.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').get(req.body.assigned_to);
    if (!assignee || !['operational', 'marketing'].includes(assignee.role)) {
      return res.status(400).json({ error: 'Tasks can only be delegated to operational or marketing team members' });
    }
    assignedTo = req.body.assigned_to;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE tasks SET
      title = COALESCE(?, title), description = COALESCE(?, description), due_at = COALESCE(?, due_at),
      status = COALESCE(?, status), assigned_to = COALESCE(?, assigned_to),
      completed_at = CASE WHEN ? = 'completed' THEN ? WHEN ? IS NOT NULL THEN NULL ELSE completed_at END,
      updated_at = ?
    WHERE id = ?`)
    .run(n(title), n(description), n(due_at), n(status), n(assignedTo), n(status), now, n(status), now, req.params.id);

  if (status && status !== task.status) logActivity(req.params.id, req.user.id, `${req.user.name} changed status to ${status.replace(/_/g, ' ')}`);
  if (due_at !== undefined && due_at !== task.due_at) logActivity(req.params.id, req.user.id, `${req.user.name} set the deadline to ${due_at ? new Date(due_at).toLocaleString() : 'none'}`);
  if (assignedTo && assignedTo !== task.assigned_to) {
    logActivity(req.params.id, req.user.id, `Reassigned by ${req.user.name}`);
    notifyUser(assignedTo, 'assigned_work_order', `${req.user.name} assigned you a task: "${title || task.title}"`, `#/tasks/${req.params.id}`);
  }

  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
