// server/routes/jobcards.js
// Job cards are the mirror image of inspection reports: the inspection report
// is onsite briefing operations (to help with quoting); the job card is
// operations briefing onsite (to help with actually doing the work). So the
// edit permissions are deliberately reversed from inspections.js — onsite can
// view their own work order's job card, but only admin/operational can edit it.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, uuid, n } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { generateJobCardPdf } = require('../utils/jobcard-pdf');
const { notifyUser } = require('../utils/notify');
const { photosDir: PHOTOS_DIR, reportsDir: PDFS_DIR } = require('../paths');

const woRouter = express.Router();
const cardRouter = express.Router();
woRouter.use(authRequired);
cardRouter.use(authRequired);

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
  return db.prepare(`SELECT wo.*, u.name AS assignee_name FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to WHERE wo.id = ?`).get(id);
}

// Only admin/operational can create or edit a job card.
function assertCanEdit(req) {
  return req.user.role === 'admin' || req.user.role === 'operational';
}
// Admin/operational can view any job card; the onsite person assigned to the
// work order can view (but not edit) their own.
function assertCanView(req, wo) {
  if (assertCanEdit(req)) return true;
  return wo.assigned_to === req.user.id;
}

// Create (or fetch existing) job card for a work order. If a finalized
// inspection report already exists for this work order, pre-fill the job
// card's tasks from its findings — that's literally "what needs fixing".
woRouter.post('/:woId/job-card', (req, res) => {
  const wo = getWorkOrder(req.params.woId);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  if (!assertCanEdit(req)) return res.status(403).json({ error: 'Only admin/operational can create a job card' });

  if (wo.job_card_id) {
    const existing = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(wo.job_card_id);
    if (existing) return res.json({ job_card: existing });
  }

  let prefilledSections = [];
  if (wo.inspection_report_id) {
    const report = db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(wo.inspection_report_id);
    if (report && report.status === 'finalized') {
      try {
        const findings = JSON.parse(report.sections || '[]');
        prefilledSections = findings.map((f) => ({
          id: uuid(), heading: f.heading || '', notes: f.notes || '', materials: '',
          photos: Array.isArray(f.photos) ? f.photos.map((p) => ({ ...p, id: uuid() })) : []
        }));
      } catch (e) { prefilledSections = []; }
    }
  }

  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO job_cards (id,work_order_id,created_by,title,summary,special_instructions,general_materials,sections,photos,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'[]','draft',?,?)`)
    .run(id, wo.id, req.user.id, `Job Card — ${wo.reference}`, '', '', '', JSON.stringify(prefilledSections), now, now);

  db.prepare('UPDATE work_orders SET job_card_id = ?, updated_at = ? WHERE id = ?').run(id, now, wo.id);
  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), wo.id, req.user.id, `${req.user.name} started a job card${prefilledSections.length ? ' (pre-filled from the inspection report)' : ''}`, now);

  res.status(201).json({ job_card: db.prepare('SELECT * FROM job_cards WHERE id = ?').get(id) });
});

cardRouter.get('/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(card.work_order_id);
  if (!assertCanView(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  res.json({ job_card: card });
});

// Update — admin/operational only. Always editable (no finalize-locks-forever
// behaviour), same philosophy as inspection reports: re-finalize to refresh the PDF.
cardRouter.put('/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (!assertCanEdit(req)) return res.status(403).json({ error: 'Only admin/operational can edit a job card' });

  const { title, summary, special_instructions, general_materials, sections } = req.body || {};
  const now = new Date().toISOString();
  db.prepare(`UPDATE job_cards SET title=COALESCE(?,title), summary=COALESCE(?,summary),
      special_instructions=COALESCE(?,special_instructions), general_materials=COALESCE(?,general_materials),
      sections=COALESCE(?,sections), updated_at=? WHERE id=?`)
    .run(n(title), n(summary), n(special_instructions), n(general_materials),
      sections !== undefined ? JSON.stringify(sections) : null, now, req.params.id);
  res.json({ job_card: db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id) });
});

cardRouter.post('/:id/photos', upload.array('photos', 20), (req, res) => {
  const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (!assertCanEdit(req)) return res.status(403).json({ error: 'Only admin/operational can edit a job card' });

  let photos = [];
  try { photos = JSON.parse(card.photos || '[]'); } catch (e) { photos = []; }
  let sections = [];
  try { sections = JSON.parse(card.sections || '[]'); } catch (e) { sections = []; }

  const sectionId = req.body.section_id || null;
  const targetSection = sectionId ? sections.find((s) => s.id === sectionId) : null;

  const captions = Array.isArray(req.body.captions) ? req.body.captions : (req.body.captions ? [req.body.captions] : []);
  const newPhotos = (req.files || []).map((file, idx) => ({
    id: uuid(), filename: file.filename, path: file.path, url: `/uploads/photos/${file.filename}`,
    caption: captions[idx] || '', uploaded_at: new Date().toISOString()
  }));

  if (targetSection) {
    if (!Array.isArray(targetSection.photos)) targetSection.photos = [];
    targetSection.photos.push(...newPhotos);
  } else {
    photos.push(...newPhotos);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE job_cards SET photos = ?, sections = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(photos), JSON.stringify(sections), now, req.params.id);
  res.json({ job_card: db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id) });
});

cardRouter.delete('/:id/photos/:photoId', (req, res) => {
  const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (!assertCanEdit(req)) return res.status(403).json({ error: 'Only admin/operational can edit a job card' });

  let photos = [];
  try { photos = JSON.parse(card.photos || '[]'); } catch (e) { photos = []; }
  let sections = [];
  try { sections = JSON.parse(card.sections || '[]'); } catch (e) { sections = []; }

  let toRemove = photos.find((p) => p.id === req.params.photoId);
  if (toRemove) {
    photos = photos.filter((p) => p.id !== req.params.photoId);
  } else {
    for (const s of sections) {
      if (Array.isArray(s.photos) && s.photos.some((p) => p.id === req.params.photoId)) {
        toRemove = s.photos.find((p) => p.id === req.params.photoId);
        s.photos = s.photos.filter((p) => p.id !== req.params.photoId);
        break;
      }
    }
  }
  if (toRemove && toRemove.path && fs.existsSync(toRemove.path)) fs.unlink(toRemove.path, () => {});

  db.prepare('UPDATE job_cards SET photos = ?, sections = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(photos), JSON.stringify(sections), new Date().toISOString(), req.params.id);
  res.json({ job_card: db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id) });
});

// Finalize / re-finalize — generates (or refreshes) the PDF. No SLA timer
// implications here, this is purely about producing a clean document for onsite.
cardRouter.post('/:id/finalize', async (req, res) => {
  const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  if (!assertCanEdit(req)) return res.status(403).json({ error: 'Only admin/operational can finalize a job card' });
  const wo = getWorkOrder(card.work_order_id);

  const isFirstFinalize = card.status !== 'finalized';
  const now = new Date().toISOString();
  try { fs.mkdirSync(PDFS_DIR, { recursive: true }); } catch (e) {}
  const pdfPath = path.join(PDFS_DIR, `jobcard-${card.id}.pdf`);

  try {
    await generateJobCardPdf({ db, card: { ...card, finalized_at: isFirstFinalize ? now : (card.finalized_at || now) }, workOrder: wo, outputPath: pdfPath });
  } catch (e) {
    console.error('Job card PDF generation failed', e);
    return res.status(500).json({ error: 'Failed to generate PDF' });
  }

  db.prepare('UPDATE job_cards SET status = ?, finalized_at = COALESCE(finalized_at, ?), pdf_path = ?, updated_at = ? WHERE id = ?')
    .run('finalized', now, pdfPath, now, card.id);

  db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), wo.id, req.user.id, isFirstFinalize ? `${req.user.name} finalized the job card` : `${req.user.name} updated the job card`, now);

  if (wo.assigned_to) {
    const msg = isFirstFinalize
      ? `A job card is ready for ${wo.reference} — check what's needed before you head out.`
      : `The job card for ${wo.reference} was updated.`;
    notifyUser(wo.assigned_to, 'assigned_work_order', msg, `#/work-orders/${wo.id}`);
  }

  res.json({ job_card: db.prepare('SELECT * FROM job_cards WHERE id = ?').get(card.id) });
});

cardRouter.get('/:id/pdf', (req, res) => {
  const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const wo = getWorkOrder(card.work_order_id);
  if (!assertCanView(req, wo)) return res.status(403).json({ error: 'Not permitted' });
  if (card.status !== 'finalized' || !card.pdf_path || !fs.existsSync(card.pdf_path)) {
    return res.status(400).json({ error: 'Job card has not been finalized yet' });
  }
  res.download(card.pdf_path, `Job-Card-${wo.reference}.pdf`);
});

module.exports = { woRouter, cardRouter };
