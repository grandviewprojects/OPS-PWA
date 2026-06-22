// server/routes/portal.js
const express = require('express');
const { db, uuid } = require('../db');
const { sendPushToUser } = require('../utils/push');

const router = express.Router();

// Public branding info for the portal page (company name/logo only — nothing sensitive)
router.get('/branding', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('company_name','company_logo','brand_color')").all();
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  res.json(obj);
});

function nextReference() {
  const row = db.prepare(`SELECT reference FROM work_orders ORDER BY created_at DESC LIMIT 1`).get();
  let n = 1;
  if (row && row.reference) {
    const m = row.reference.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return 'WO-' + String(n).padStart(5, '0');
}

// Public work order submission — anyone with the portal link can submit, no login required.
router.post('/work-orders', (req, res) => {
  const { title, description, client_name, client_email, client_phone, site_address, priority,
    requested_by_name, requested_by_email, requested_by_phone } = req.body || {};

  if (!title || !client_name || !site_address) {
    return res.status(400).json({ error: 'title, client_name and site_address are required' });
  }

  const now = new Date().toISOString();
  const id = uuid();
  const reference = nextReference();

  db.prepare(`INSERT INTO work_orders (id,reference,title,description,client_name,client_email,client_phone,site_address,priority,status,created_via,requested_by_name,requested_by_email,requested_by_phone,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'new','portal',?,?,?,?,?)`)
    .run(id, reference, title, description || '', client_name, client_email || '', client_phone || '', site_address,
      priority || 'medium', requested_by_name || client_name, requested_by_email || client_email || '', requested_by_phone || client_phone || '', now, now);

  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), id, null, 'Submitted via external request portal', now);

  // Notify all operational + admin users of the new incoming request
  const staff = db.prepare("SELECT id FROM users WHERE role IN ('admin','operational') AND active = 1").all();
  const notifyStmt = db.prepare('INSERT INTO notifications (id,user_id,message,link,read,created_at) VALUES (?,?,?,?,0,?)');
  const msg = `New request from the portal: ${reference} — ${title}`;
  staff.forEach(s => {
    notifyStmt.run(uuid(), s.id, msg, `#/work-orders/${id}`, now);
    sendPushToUser(s.id, { title: 'New service request', body: msg, link: `#/work-orders/${id}` }).catch(() => {});
  });

  res.status(201).json({ ok: true, reference });
});

module.exports = router;
