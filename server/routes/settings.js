// server/routes/settings.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { logoDir: LOGO_DIR } = require('../paths');

const router = express.Router();
router.use(authRequired);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (e) {}
      cb(null, LOGO_DIR);
    },
    filename: (req, file, cb) => cb(null, `logo-${uuid()}${path.extname(file.originalname) || '.png'}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files allowed'))
});

// Settings keys that must never be sent to the browser, no matter who's asking.
const SECRET_KEYS = new Set(['vapid_private_key']);

function publicSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { if (!SECRET_KEYS.has(r.key)) obj[r.key] = r.value; });
  return obj;
}

router.get('/', (req, res) => {
  res.json({ settings: publicSettings() });
});

router.put('/', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  Object.entries(body).forEach(([k, v]) => {
    if (SECRET_KEYS.has(k)) return; // ignore any attempt to overwrite secret keys via this endpoint
    stmt.run(k, String(v));
  });
  res.json({ settings: publicSettings() });
});

router.post('/logo', requireRole('admin'), upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('company_logo', req.file.path);
  res.json({ company_logo: `/uploads/logo/${req.file.filename}` });
});

module.exports = router;
