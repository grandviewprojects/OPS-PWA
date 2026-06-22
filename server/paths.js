// server/paths.js
// Central place that decides where the database and uploaded files live.
//
// On hosts that only allow ONE persistent disk per service (e.g. Render),
// set the environment variable DATA_DIR to the disk's mount path
// (e.g. /var/data) and everything below — the database AND all uploads —
// will live inside that single disk, organised into subfolders.
//
// If DATA_DIR is not set (e.g. running locally), everything defaults to
// the server/data and server/uploads folders as before.
const path = require('path');
const fs = require('fs');

const base = process.env.DATA_DIR || null;

const dataDir = base ? path.join(base, 'db') : path.join(__dirname, 'data');
const uploadsDir = base ? path.join(base, 'uploads') : path.join(__dirname, 'uploads');
const photosDir = path.join(uploadsDir, 'photos');
const logoDir = path.join(uploadsDir, 'logo');
const reportsDir = path.join(uploadsDir, 'reports');

[dataDir, uploadsDir, photosDir, logoDir, reportsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

module.exports = { dataDir, uploadsDir, photosDir, logoDir, reportsDir };
