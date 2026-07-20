// server/routes/quotes.js
// Quotes attached to a work order, with line items and an approval workflow.
//
// Two routers are exported:
//   woRouter    → mounted at /api/work-orders  (nested: /:woId/quotes)
//   quoteRouter → mounted at /api/quotes       (flat:   /:id ...)
const express = require('express');
const { db, uuid, n } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');

const VAT_DEFAULT = 15;

function recalc(quoteId) {
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);
  const subtotal = items.reduce((sum, it) => sum + Number(it.line_total || 0), 0);
  const q = db.prepare('SELECT vat_rate FROM quotes WHERE id = ?').get(quoteId);
  const vatRate = q ? Number(q.vat_rate) : VAT_DEFAULT;
  const vatAmount = +(subtotal * vatRate / 100).toFixed(2);
  const total = +(subtotal + vatAmount).toFixed(2);
  db.prepare('UPDATE quotes SET subtotal=?, vat_amount=?, total=?, updated_at=? WHERE id=?')
    .run(+subtotal.toFixed(2), vatAmount, total, new Date().toISOString(), quoteId);
}

function quoteWithItems(id) {
  const quote = db.prepare(`SELECT q.*, u.name AS approver_name, wo.reference AS wo_reference, wo.title AS wo_title
    FROM quotes q
    LEFT JOIN users u ON u.id = q.approver_id
    LEFT JOIN work_orders wo ON wo.id = q.work_order_id
    WHERE q.id = ?`).get(id);
  if (!quote) return null;
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, rowid').all(id);
  return quote;
}

function nextQuoteRef() {
  const row = db.prepare("SELECT reference FROM quotes WHERE reference IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
  let num = 1;
  if (row && row.reference) { const m = row.reference.match(/(\d+)$/); if (m) num = parseInt(m[1], 10) + 1; }
  return 'Q-' + String(num).padStart(5, '0');
}

// ---- Nested router: /api/work-orders/:woId/quotes ----
const woRouter = express.Router({ mergeParams: true });
woRouter.use(authRequired);

woRouter.get('/:woId/quotes', (req, res) => {
  const rows = db.prepare('SELECT * FROM quotes WHERE work_order_id = ? ORDER BY created_at DESC').all(req.params.woId);
  res.json({ quotes: rows });
});

woRouter.post('/:woId/quotes', requireRole('admin', 'operational'), (req, res) => {
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.woId);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });

  const { title, notes, vat_rate, items } = req.body || {};
  const now = new Date().toISOString();
  const id = uuid();
  const ref = nextQuoteRef();
  db.prepare(`INSERT INTO quotes (id,work_order_id,reference,title,notes,status,vat_rate,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,'draft',?,?,?,?)`)
    .run(id, req.params.woId, ref, title || `Quote for ${wo.reference}`, notes || '', vat_rate != null ? Number(vat_rate) : VAT_DEFAULT, req.user.id, now, now);

  if (Array.isArray(items)) {
    const ins = db.prepare(`INSERT INTO quote_items (id,quote_id,kind,name,unit,quantity,unit_price,line_total,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    items.forEach((it, i) => {
      const qty = Number(it.quantity) || 0;
      const price = Number(it.unit_price) || 0;
      ins.run(uuid(), id, it.kind === 'labour' ? 'labour' : 'material', String(it.name || '').trim() || 'Item',
        it.unit || '', qty, price, +(qty * price).toFixed(2), i);
    });
  }
  recalc(id);
  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), req.params.woId, req.user.id, `${req.user.name} created quote ${ref}`, now);

  res.status(201).json({ quote: quoteWithItems(id) });
});

// ---- Flat router: /api/quotes/:id ----
const quoteRouter = express.Router();
quoteRouter.use(authRequired);

quoteRouter.get('/:id', (req, res) => {
  const q = quoteWithItems(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json({ quote: q });
});

// Replace quote fields and/or line items wholesale (simplest reliable editor model).
quoteRouter.put('/:id', requireRole('admin', 'operational'), (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (['approved', 'sent', 'accepted'].includes(q.status)) {
    return res.status(400).json({ error: `This quote is ${q.status} and can no longer be edited.` });
  }

  const { title, notes, vat_rate, items } = req.body || {};
  const now = new Date().toISOString();
  db.prepare('UPDATE quotes SET title=COALESCE(?,title), notes=COALESCE(?,notes), vat_rate=COALESCE(?,vat_rate), updated_at=? WHERE id=?')
    .run(n(title), n(notes), vat_rate != null ? Number(vat_rate) : null, now, req.params.id);

  if (Array.isArray(items)) {
    db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(req.params.id);
    const ins = db.prepare(`INSERT INTO quote_items (id,quote_id,kind,name,unit,quantity,unit_price,line_total,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    items.forEach((it, i) => {
      const qty = Number(it.quantity) || 0;
      const price = Number(it.unit_price) || 0;
      ins.run(uuid(), req.params.id, it.kind === 'labour' ? 'labour' : 'material', String(it.name || '').trim() || 'Item',
        it.unit || '', qty, price, +(qty * price).toFixed(2), i);
    });
  }
  recalc(req.params.id);

  // Editing a quote that was pending approval resets it to draft (approver must re-request).
  if (q.status === 'pending_approval' || q.status === 'rejected') {
    db.prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').run('draft', now, req.params.id);
  }
  res.json({ quote: quoteWithItems(req.params.id) });
});

// Send a quote for approval — tag a specific approver, who gets notified now
// and then hourly (via the scheduler) until they approve or edit it.
quoteRouter.post('/:id/request-approval', requireRole('admin', 'operational'), (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const approverId = req.body && req.body.approver_id;
  if (!approverId) return res.status(400).json({ error: 'approver_id is required' });
  const approver = db.prepare("SELECT id,name,role FROM users WHERE id = ? AND active = 1").get(approverId);
  if (!approver) return res.status(400).json({ error: 'Approver not found' });
  if (!['admin', 'operational'].includes(approver.role)) {
    return res.status(400).json({ error: 'Quotes can only be sent to an admin or operational team member for approval.' });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE quotes SET status='pending_approval', approver_id=?, approval_requested_at=?, last_approval_nudge_at=?, updated_at=? WHERE id=?`)
    .run(approverId, now, now, now, req.params.id);

  notifyUser(approverId, 'quote_approval_requested',
    `A quote (${q.reference}) has been sent for your approval.`, `#/work-orders/${q.work_order_id}`);

  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), q.work_order_id, req.user.id, `${req.user.name} sent quote ${q.reference} to ${approver.name} for approval`, now);

  res.json({ quote: quoteWithItems(req.params.id) });
});

quoteRouter.post('/:id/approve', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  // Only the tagged approver or an admin may approve.
  if (req.user.role !== 'admin' && q.approver_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the tagged approver can approve this quote.' });
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE quotes SET status='approved', approved_at=?, approved_by=?, updated_at=? WHERE id=?")
    .run(now, req.user.id, now, req.params.id);
  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), q.work_order_id, req.user.id, `${req.user.name} approved quote ${q.reference}`, now);
  res.json({ quote: quoteWithItems(req.params.id) });
});

quoteRouter.post('/:id/reject', (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && q.approver_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the tagged approver can reject this quote.' });
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE quotes SET status='rejected', rejected_at=?, updated_at=? WHERE id=?").run(now, now, req.params.id);
  const reason = (req.body && req.body.reason) ? ` — "${String(req.body.reason).slice(0, 200)}"` : '';
  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), q.work_order_id, req.user.id, `${req.user.name} sent quote ${q.reference} back for changes${reason}`, now);
  if (q.created_by) notifyUser(q.created_by, 'quote_rejected', `Quote ${q.reference} needs changes before it can be sent.`, `#/work-orders/${q.work_order_id}`);
  res.json({ quote: quoteWithItems(req.params.id) });
});

quoteRouter.delete('/:id', requireRole('admin', 'operational'), (req, res) => {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Hourly approval nudge (called by scheduler) ----
// Any quote still pending_approval gets a reminder to its approver about once
// an hour until they approve or it's edited (which flips it back to draft).
function runQuoteApprovalNudgeCheck() {
  const pending = db.prepare("SELECT * FROM quotes WHERE status = 'pending_approval' AND approver_id IS NOT NULL").all();
  const now = Date.now();
  pending.forEach((q) => {
    const last = q.last_approval_nudge_at ? new Date(q.last_approval_nudge_at).getTime() : 0;
    if (now - last < 60 * 60 * 1000) return; // less than an hour since last nudge
    notifyUser(q.approver_id, 'quote_approval_requested',
      `Reminder: quote ${q.reference} is still waiting for your approval.`, `#/work-orders/${q.work_order_id}`);
    db.prepare('UPDATE quotes SET last_approval_nudge_at = ? WHERE id = ?').run(new Date().toISOString(), q.id);
  });
}

module.exports = { woRouter, quoteRouter, runQuoteApprovalNudgeCheck };
