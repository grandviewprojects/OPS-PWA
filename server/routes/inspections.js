// server/routes/inspections.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, uuid, n } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { generateInspectionPdf } = require('../utils/pdf');
const { sendPushToUser } = require('../utils/push');
const { photosDir: PHOTOS_DIR, reportsDir: PDFS_DIR } = require('../paths');

const woRouter = express.Router();
const reportRouter = express.Router();
woRouter.use(authRequired);
reportRouter.use(authRequired);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); } catch (e) {}
    cb(null, PHOTOS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

function getWorkOrder(id) {
  return db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
}

function assertCanWorkOn(req, wo) {
  if (req.user.role === 'admin' || req.user.role === 'operational') return true;
  return wo.assigned_to === req.user.id;
}

// Create (or fetch existing draft) inspection report for a work order — "Create inspection report" button
woRouter.post('/:woId/inspection-report', (req, res) => {
  const wo = getWorkOrder(req.params.woId);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'This work order is not assigned to you' });

  if (wo.inspection_report_id) {
    const existing = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(wo.inspection_report_id);
    if (existing && existing.status === 'draft') return res.json({ inspection_report: existing });
    if (existing && existing.status === 'finalized') return res.status(400).json({ error: 'An inspection report has already been finalized for this work order' });
  }

  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO inspection_reports (id,work_order_id,created_by,title,summary,sections,photos,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'draft',?,?)`)
    .run(id, wo.id, req.user.id, `Inspection Report — ${wo.reference}`, '', '[]', '[]', now, now);

  db.prepare('UPDATE work_orders SET inspection_report_id = ?, updated_at = ? WHERE id = ?').run(id, now, wo.id);
  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), wo.id, req.user.id, `${req.user.name} started an inspection report`, now);

  res.status(201).json({ inspection_report: db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(id) });
});

reportRouter.get('/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(report.work_order_id);
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  res.json({ inspection_report: report });
});

// Update draft content (title, summary, sections)
reportRouter.put('/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(report.work_order_id);
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  if (report.status === 'finalized') return res.status(400).json({ error: 'This report has already been finalized and is read-only' });

  const { title, summary, sections } = req.body || {};
  const now = new Date().toISOString();
  db.prepare('UPDATE inspection_reports SET title=COALESCE(?,title), summary=COALESCE(?,summary), sections=COALESCE(?,sections), updated_at=? WHERE id=?')
    .run(n(title), n(summary), sections !== undefined ? JSON.stringify(sections) : null, now, req.params.id);
  res.json({ inspection_report: db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id) });
});

// Upload photo(s) from device library — field name "photos", multiple allowed
reportRouter.post('/:id/photos', upload.array('photos', 20), (req, res) => {
  const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(report.work_order_id);
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  if (report.status === 'finalized') return res.status(400).json({ error: 'This report has already been finalized' });

  let photos = [];
  try { photos = JSON.parse(report.photos || '[]'); } catch (e) { photos = []; }
  let sections = [];
  try { sections = JSON.parse(report.sections || '[]'); } catch (e) { sections = []; }

  const sectionId = req.body.section_id || null;
  const targetSection = sectionId ? sections.find(s => s.id === sectionId) : null;

  const captions = Array.isArray(req.body.captions) ? req.body.captions : (req.body.captions ? [req.body.captions] : []);
  const newPhotos = (req.files || []).map((file, idx) => ({
    id: uuid(),
    filename: file.filename,
    path: file.path,
    url: `/uploads/photos/${file.filename}`,
    caption: captions[idx] || '',
    uploaded_at: new Date().toISOString()
  }));

  if (targetSection) {
    if (!Array.isArray(targetSection.photos)) targetSection.photos = [];
    targetSection.photos.push(...newPhotos);
  } else {
    photos.push(...newPhotos);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE inspection_reports SET photos = ?, sections = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(photos), JSON.stringify(sections), now, req.params.id);
  res.json({ inspection_report: db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id) });
});

reportRouter.delete('/:id/photos/:photoId', (req, res) => {
  const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(report.work_order_id);
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  if (report.status === 'finalized') return res.status(400).json({ error: 'This report has already been finalized' });

  let photos = [];
  try { photos = JSON.parse(report.photos || '[]'); } catch (e) { photos = []; }
  let sections = [];
  try { sections = JSON.parse(report.sections || '[]'); } catch (e) { sections = []; }

  let toRemove = photos.find(p => p.id === req.params.photoId);
  if (toRemove) {
    photos = photos.filter(p => p.id !== req.params.photoId);
  } else {
    // search inside each section's own photo gallery
    for (const s of sections) {
      if (Array.isArray(s.photos) && s.photos.some(p => p.id === req.params.photoId)) {
        toRemove = s.photos.find(p => p.id === req.params.photoId);
        s.photos = s.photos.filter(p => p.id !== req.params.photoId);
        break;
      }
    }
  }
  if (toRemove && fs.existsSync(toRemove.path)) fs.unlink(toRemove.path, () => {});

  db.prepare('UPDATE inspection_reports SET photos = ?, sections = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(photos), JSON.stringify(sections), new Date().toISOString(), req.params.id);
  res.json({ inspection_report: db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id) });
});

// Finalize — generates the branded PDF, attaches it to the work order, and starts the 3-day quote SLA timer
reportRouter.post('/:id/finalize', async (req, res) => {
  const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(report.work_order_id);
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  if (report.status === 'finalized') return res.status(400).json({ error: 'Already finalized' });

  const now = new Date().toISOString();
  const inspector = db.prepare('SELECT * FROM users WHERE id = ?').get(report.created_by);
  try { fs.mkdirSync(PDFS_DIR, { recursive: true }); } catch (e) {}
  const pdfPath = path.join(PDFS_DIR, `${report.id}.pdf`);

  try {
    await generateInspectionPdf({ db, report: { ...report, finalized_at: now }, workOrder: wo, inspector, outputPath: pdfPath });
  } catch (e) {
    console.error('PDF generation failed', e);
    return res.status(500).json({ error: 'Failed to generate PDF report' });
  }

  const slaHoursRow = db.prepare("SELECT value FROM settings WHERE key = 'quote_sla_hours'").get();
  const slaHours = parseInt((slaHoursRow && slaHoursRow.value) || '72', 10);
  const quoteDueAt = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

  db.prepare('UPDATE inspection_reports SET status = ?, finalized_at = ?, pdf_path = ?, updated_at = ? WHERE id = ?')
    .run('finalized', now, pdfPath, now, report.id);

  db.prepare('UPDATE work_orders SET status = ?, inspection_submitted_at = ?, quote_due_at = ?, updated_at = ? WHERE id = ?')
    .run('inspection_submitted', now, quoteDueAt, now, wo.id);

  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), wo.id, req.user.id, `Inspection report finalized by ${req.user.name}. Quote due within ${slaHours} hours.`, now);

  const staff = db.prepare("SELECT id FROM users WHERE role IN ('admin','operational') AND active = 1").all();
  const notifyStmt = db.prepare('INSERT INTO notifications (id,user_id,message,link,read,created_at) VALUES (?,?,?,?,0,?)');
  const msg = `${req.user.name} submitted the inspection report for ${wo.reference} — quote due in ${slaHours}h`;
  staff.forEach(s => {
    notifyStmt.run(uuid(), s.id, msg, `#/work-orders/${wo.id}`, now);
    sendPushToUser(s.id, { title: 'Inspection report ready', body: msg, link: `#/work-orders/${wo.id}` }).catch(() => {});
  });

  res.json({
    inspection_report: db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(report.id),
    work_order: db.prepare('SELECT * FROM work_orders WHERE id = ?').get(wo.id)
  });
});

// Download the finalized PDF
reportRouter.get('/:id/pdf', (req, res) => {
  const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(report.work_order_id);
  if (!assertCanWorkOn(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  if (report.status !== 'finalized' || !report.pdf_path || !fs.existsSync(report.pdf_path)) {
    return res.status(400).json({ error: 'Report has not been finalized yet' });
  }
  res.download(report.pdf_path, `Inspection-Report-${wo.reference}.pdf`);
});

module.exports = { woRouter, reportRouter };
