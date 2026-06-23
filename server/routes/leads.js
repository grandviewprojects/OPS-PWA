// server/routes/leads.js
const express = require('express');
const multer = require('multer');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notify');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('admin', 'marketing'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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

// ---------------- Import from Google Sheets (or a plain CSV upload) ----------------
// Required columns (case-insensitive, any order): Name (required), Company, Email,
// Phone, Source, Value, Notes, Assigned To Email (optional — must match an existing
// admin/marketing user's email, otherwise the lead defaults to whoever ran the import).

function parseCsv(text) {
  // Minimal but correct CSV parser: handles quoted fields, escaped quotes (""),
  // and commas/newlines inside quotes. Good enough for a simple leads sheet.
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function extractGoogleSheetExportUrl(sheetUrl) {
  let parsed;
  try { parsed = new URL(sheetUrl); } catch (e) { throw new Error('That doesn\'t look like a valid URL.'); }
  if (parsed.hostname !== 'docs.google.com') {
    throw new Error('Only Google Sheets links (docs.google.com) are supported.');
  }
  const idMatch = parsed.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) throw new Error('Could not find a spreadsheet ID in that link.');
  const gidMatch = sheetUrl.match(/[?#&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  // We build the export URL ourselves from just the extracted ID/gid — we never
  // fetch the URL the user actually typed, so this can't be used to make the
  // server fetch arbitrary attacker-controlled URLs.
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

function importRows(rows, importerId) {
  if (!rows.length) return { imported: 0, skipped: 0, errors: ['The sheet appears to be empty.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    name: col('name'), company: col('company'), email: col('email'), phone: col('phone'),
    source: col('source'), value: col('value'), notes: col('notes'),
    assignedEmail: header.findIndex((h) => h.includes('assigned'))
  };
  if (idx.name === -1) {
    return { imported: 0, skipped: 0, errors: ['No "Name" column found — check the sheet matches the template format.'] };
  }

  const allUsers = db.prepare("SELECT id, email FROM users WHERE role IN ('admin','marketing') AND active = 1").all();
  const userByEmail = Object.fromEntries(allUsers.map((u) => [u.email.toLowerCase(), u.id]));

  let imported = 0, skipped = 0;
  const errors = [];
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO leads (id,name,company,email,phone,source,status,value,notes,assigned_to,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'new',?,?,?,?,?,?)`);

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => !c || !c.trim())) continue; // skip blank rows
    const name = (r[idx.name] || '').trim();
    if (!name) { skipped++; errors.push(`Row ${i + 1}: missing a name, skipped.`); continue; }

    let assignedTo = importerId;
    if (idx.assignedEmail !== -1) {
      const emailVal = (r[idx.assignedEmail] || '').trim().toLowerCase();
      if (emailVal && userByEmail[emailVal]) assignedTo = userByEmail[emailVal];
      else if (emailVal) errors.push(`Row ${i + 1}: "${emailVal}" doesn't match any admin/marketing profile — assigned to you instead.`);
    }

    insert.run(
      uuid(), name,
      idx.company !== -1 ? (r[idx.company] || '').trim() : '',
      idx.email !== -1 ? (r[idx.email] || '').trim() : '',
      idx.phone !== -1 ? (r[idx.phone] || '').trim() : '',
      idx.source !== -1 ? (r[idx.source] || '').trim() : 'Google Sheets import',
      idx.value !== -1 ? (r[idx.value] || '').trim() : '',
      idx.notes !== -1 ? (r[idx.notes] || '').trim() : '',
      assignedTo, importerId, now, now
    );
    imported++;
  }
  return { imported, skipped, errors };
}

router.post('/import', upload.single('file'), async (req, res) => {
  try {
    let csvText;
    if (req.file) {
      csvText = req.file.buffer.toString('utf-8');
    } else if (req.body && req.body.sheet_url) {
      const exportUrl = extractGoogleSheetExportUrl(req.body.sheet_url);
      let resp;
      try {
        resp = await fetch(exportUrl, { redirect: 'follow' });
      } catch (fetchErr) {
        return res.status(400).json({ error: `Could not reach Google Sheets (${fetchErr.message}). Try the CSV upload option instead.` });
      }
      const contentType = resp.headers.get('content-type') || '';
      const text = await resp.text();
      const landedOnLoginPage = /accounts\.google\.com/.test(resp.url) || /ServiceLogin/.test(resp.url);
      const looksLikeHtml = contentType.includes('text/html') || text.trim().startsWith('<');

      if (landedOnLoginPage) {
        return res.status(400).json({
          error: 'Google redirected this to a sign-in page instead of the sheet, which means it isn\'t actually public yet. ' +
            'If this is a Google Workspace / business account, "Anyone with the link" sometimes only means "anyone in your organization" ' +
            'unless an admin has allowed external sharing. Try: Share → General access → make sure it says "Anyone with the link" (not ' +
            'a company/organization name) → Viewer. If your Workspace blocks this, use "Upload a CSV file" below instead — download the ' +
            'sheet as CSV (File → Download → Comma Separated Values) and upload that file directly.'
        });
      }
      if (!resp.ok) {
        return res.status(400).json({ error: `Google returned an error (HTTP ${resp.status}) for that link. Double-check the link is correct, or use the CSV upload option instead.` });
      }
      if (looksLikeHtml) {
        return res.status(400).json({
          error: 'Got a webpage back instead of your sheet\'s data — usually means the sharing link doesn\'t point at a real spreadsheet, ' +
            'or the specific tab (gid) in the link doesn\'t exist. Try copying the link again while the "Leads" tab is open and active, ' +
            'or use the CSV upload option instead, which always works regardless of sharing settings.'
        });
      }
      csvText = text;
    } else {
      return res.status(400).json({ error: 'Provide either a Google Sheets link or upload a CSV file.' });
    }

    const rows = parseCsv(csvText);
    if (rows.length > 501) return res.status(400).json({ error: 'That sheet has more than 500 rows — please split it into smaller batches.' });
    const result = importRows(rows, req.user.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
