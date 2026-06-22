// server/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const calendarRoutes = require('./routes/calendar');
const workOrderRoutes = require('./routes/workorders');
const inspectionRoutes = require('./routes/inspections');
const portalRoutes = require('./routes/portal');
const settingsRoutes = require('./routes/settings');
const dashboardRoutes = require('./routes/dashboard');
const pushRoutes = require('./routes/push');
const { photosDir, logoDir } = require('./paths');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded photos / logos statically (reports PDFs are served via authenticated download route)
app.use('/uploads/photos', express.static(photosDir));
app.use('/uploads/logo', express.static(logoDir));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/work-orders', inspectionRoutes.woRouter); // /api/work-orders/:woId/inspection-report
app.use('/api/inspection-reports', inspectionRoutes.reportRouter);
app.use('/api/portal', portalRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/push', pushRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Frontend static files (PWA)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Portal page is its own standalone entry (no login)
app.get('/portal', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'portal.html')));

// SPA fallback for everything else (so client-side hash routing works on refresh)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error handler (e.g. multer file errors)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Onsite Ops PWA server running at http://localhost:${PORT}`);
});
