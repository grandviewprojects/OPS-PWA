// server/routes/rateitems.js
// The "Rate Catalog" — reusable material & labour line items with unit prices.
// These are pulled in when building a quote so you don't retype prices.
const express = require('express');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const VALID_KINDS = ['material', 'labour'];

// List — staff only (admin/operational). Optional ?kind= and ?q= filters.
router.get('/', requireRole('admin', 'operational'), (req, res) => {
  let sql = 'SELECT * FROM rate_items WHERE active = 1';
  const params = [];
  if (req.query.kind && VALID_KINDS.includes(req.query.kind)) { sql += ' AND kind = ?'; params.push(req.query.kind); }
  if (req.query.q) { sql += ' AND name LIKE ?'; params.push('%' + req.query.q + '%'); }
  sql += ' ORDER BY kind, name COLLATE NOCASE';
  res.json({ rate_items: db.prepare(sql).all(...params) });
});

router.post('/', requireRole('admin', 'operational'), (req, res) => {
  const { kind, name, unit, unit_price, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const k = VALID_KINDS.includes(kind) ? kind : 'material';
  const price = Number(unit_price);
  if (Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'unit_price must be a non-negative number' });

  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO rate_items (id,kind,name,unit,unit_price,notes,active,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,?,?,?)`)
    .run(id, k, String(name).trim(), unit || '', price, notes || '', req.user.id, now, now);
  res.status(201).json({ rate_item: db.prepare('SELECT * FROM rate_items WHERE id = ?').get(id) });
});

router.put('/:id', requireRole('admin', 'operational'), (req, res) => {
  const item = db.prepare('SELECT * FROM rate_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { kind, name, unit, unit_price, notes } = req.body || {};
  const k = VALID_KINDS.includes(kind) ? kind : item.kind;
  let price = item.unit_price;
  if (unit_price !== undefined) {
    price = Number(unit_price);
    if (Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'unit_price must be a non-negative number' });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE rate_items SET kind=?, name=?, unit=?, unit_price=?, notes=?, updated_at=? WHERE id=?')
    .run(k, name !== undefined ? String(name).trim() : item.name, unit !== undefined ? unit : item.unit,
      price, notes !== undefined ? notes : item.notes, now, req.params.id);
  res.json({ rate_item: db.prepare('SELECT * FROM rate_items WHERE id = ?').get(req.params.id) });
});

// Soft-delete (keep for historical quote references).
router.delete('/:id', requireRole('admin', 'operational'), (req, res) => {
  const item = db.prepare('SELECT id FROM rate_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE rate_items SET active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

module.exports = router;
