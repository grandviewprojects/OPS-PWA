// server/routes/reports.js
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { reportsDir } = require('../paths');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('admin', 'operational'));

const METRIC_LABELS = {
  created: 'New work orders',
  completed: 'Completed',
  quotes_sent: 'Quotes sent',
  cancelled: 'Cancelled',
  avg_time_to_quote_hours: 'Avg. time to quote (hours)',
  sla_breaches: 'Late quotes (missed SLA)'
};
const ALL_METRICS = Object.keys(METRIC_LABELS);

// ---------------- Shared helpers ----------------
function fetchWorkOrders(assignee) {
  let sql = `SELECT wo.id, wo.reference, wo.title, wo.client_name, wo.status, wo.assigned_to, u.name AS assignee_name,
                    wo.created_at, wo.completed_at, wo.cancelled_at, wo.inspection_submitted_at, wo.quote_sent_at, wo.quote_due_at
             FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to WHERE 1=1`;
  const params = [];
  if (assignee) { sql += ' AND wo.assigned_to = ?'; params.push(assignee); }
  return db.prepare(sql).all(...params);
}

function inRange(dateStr, start, end) {
  return !!dateStr && dateStr >= start && dateStr < end;
}

function hoursToQuote(wo) {
  if (!wo.quote_sent_at || !wo.inspection_submitted_at) return null;
  return (new Date(wo.quote_sent_at) - new Date(wo.inspection_submitted_at)) / 3600000;
}

function computeMetrics(rows, start, end) {
  let created = 0, completed = 0, quotesSent = 0, cancelled = 0, slaBreaches = 0;
  const quoteHours = [];
  rows.forEach((wo) => {
    if (inRange(wo.created_at, start, end)) created++;
    if (inRange(wo.completed_at, start, end)) completed++;
    if (inRange(wo.cancelled_at, start, end)) cancelled++;
    if (inRange(wo.quote_sent_at, start, end)) {
      quotesSent++;
      const h = hoursToQuote(wo);
      if (h !== null) {
        quoteHours.push(h);
        if (wo.quote_due_at && wo.quote_sent_at > wo.quote_due_at) slaBreaches++;
      }
    }
  });
  const avg = quoteHours.length ? quoteHours.reduce((a, b) => a + b, 0) / quoteHours.length : null;
  return {
    created, completed, quotes_sent: quotesSent, cancelled, sla_breaches: slaBreaches,
    avg_time_to_quote_hours: avg !== null ? Math.round(avg * 10) / 10 : null
  };
}

// Builds contiguous buckets covering [from, to) at the requested granularity.
function buildBuckets(from, to, granularity) {
  const buckets = [];
  let cursor = new Date(from);
  const end = new Date(to);
  if (granularity === 'month') {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    while (cursor < end) {
      const start = new Date(cursor);
      const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      buckets.push({
        label: start.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        start: start.toISOString(),
        end: next.toISOString()
      });
      cursor = next;
    }
  } else { // week — rolling 7-day buckets starting from `from`
    while (cursor < end) {
      const start = new Date(cursor);
      const next = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
      buckets.push({
        label: start.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
        start: start.toISOString(),
        end: next.toISOString()
      });
      cursor = next;
    }
  }
  return buckets;
}

function parseMetrics(q) {
  if (!q) return ALL_METRICS;
  const requested = String(q).split(',').map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((m) => ALL_METRICS.includes(m));
  return valid.length ? valid : ALL_METRICS;
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 12 * 7 * 24 * 60 * 60 * 1000); // ~12 weeks back
  return { from: from.toISOString(), to: to.toISOString() };
}

// ---------------- Time-series for graphs ----------------
router.get('/timeseries', (req, res) => {
  const def = defaultRange();
  const from = req.query.from ? new Date(req.query.from).toISOString() : def.from;
  const to = req.query.to ? new Date(req.query.to).toISOString() : def.to;
  const granularity = req.query.granularity === 'month' ? 'month' : 'week';
  const metrics = parseMetrics(req.query.metrics);
  const rows = fetchWorkOrders(req.query.assignee || null);

  const buckets = buildBuckets(from, to, granularity);
  const series = {};
  metrics.forEach((m) => (series[m] = []));

  buckets.forEach((b) => {
    const m = computeMetrics(rows, b.start, b.end);
    metrics.forEach((key) => series[key].push(m[key]));
  });

  res.json({
    granularity,
    labels: buckets.map((b) => b.label),
    series,
    metric_labels: Object.fromEntries(metrics.map((m) => [m, METRIC_LABELS[m]]))
  });
});

// ---------------- Period-over-period comparison ----------------
router.get('/compare', (req, res) => {
  const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = req.query.to ? new Date(req.query.to).toISOString() : new Date().toISOString();
  const rows = fetchWorkOrders(req.query.assignee || null);

  const spanMs = new Date(to) - new Date(from);
  const prevTo = from;
  const prevFrom = new Date(new Date(from).getTime() - spanMs).toISOString();

  const current = computeMetrics(rows, from, to);
  const previous = computeMetrics(rows, prevFrom, prevTo);

  const change = {};
  ALL_METRICS.forEach((m) => {
    const c = current[m], p = previous[m];
    if (c === null || p === null || p === 0) change[m] = null;
    else change[m] = Math.round(((c - p) / p) * 1000) / 10; // % change, 1 decimal
  });

  res.json({ current, previous, change, current_range: { from, to }, previous_range: { from: prevFrom, to: prevTo }, metric_labels: METRIC_LABELS });
});

// ---------------- Time-to-quote detail ----------------
router.get('/time-to-quote', (req, res) => {
  const def = defaultRange();
  const from = req.query.from ? new Date(req.query.from).toISOString() : def.from;
  const to = req.query.to ? new Date(req.query.to).toISOString() : def.to;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const rows = fetchWorkOrders(req.query.assignee || null);

  const withHours = rows
    .filter((wo) => inRange(wo.quote_sent_at, from, to) && wo.inspection_submitted_at)
    .map((wo) => ({
      reference: wo.reference, title: wo.title, client_name: wo.client_name, assignee_name: wo.assignee_name,
      hours: Math.round(hoursToQuote(wo) * 10) / 10,
      breached_sla: !!(wo.quote_due_at && wo.quote_sent_at > wo.quote_due_at)
    }))
    .sort((a, b) => b.hours - a.hours);

  const hours = withHours.map((w) => w.hours);
  const summary = hours.length ? {
    count: hours.length,
    avg: Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10,
    median: Math.round(([...hours].sort((a, b) => a - b)[Math.floor(hours.length / 2)]) * 10) / 10,
    min: Math.round(Math.min(...hours) * 10) / 10,
    max: Math.round(Math.max(...hours) * 10) / 10
  } : { count: 0, avg: null, median: null, min: null, max: null };

  res.json({ summary, slowest: withHours.slice(0, limit) });
});

// ---------------- Saved custom report configs ----------------
router.get('/saved', (req, res) => {
  res.json({ saved_reports: db.prepare('SELECT id, name, config_json, created_at, updated_at FROM saved_reports ORDER BY updated_at DESC').all() });
});

router.post('/saved', (req, res) => {
  const { name, config } = req.body || {};
  if (!name || !config) return res.status(400).json({ error: 'name and config are required' });
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO saved_reports (id,name,config_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, name, JSON.stringify(config), req.user.id, now, now);
  res.status(201).json({ saved_report: { id, name, config_json: JSON.stringify(config), created_at: now, updated_at: now } });
});

router.put('/saved/:id', (req, res) => {
  const { name, config } = req.body || {};
  const existing = db.prepare('SELECT id FROM saved_reports WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const now = new Date().toISOString();
  db.prepare('UPDATE saved_reports SET name = COALESCE(?,name), config_json = COALESCE(?,config_json), updated_at = ? WHERE id = ?')
    .run(name || null, config ? JSON.stringify(config) : null, now, req.params.id);
  res.json({ saved_report: db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(req.params.id) });
});

router.delete('/saved/:id', (req, res) => {
  db.prepare('DELETE FROM saved_reports WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------- CSV export (raw data, for their own pivot tables etc.) ----------------
router.get('/export.csv', (req, res) => {
  const def = defaultRange();
  const from = req.query.from ? new Date(req.query.from).toISOString() : def.from;
  const to = req.query.to ? new Date(req.query.to).toISOString() : def.to;
  const rows = fetchWorkOrders(req.query.assignee || null)
    .filter((wo) => inRange(wo.created_at, from, to) || inRange(wo.quote_sent_at, from, to) || inRange(wo.completed_at, from, to));

  const header = ['Reference', 'Title', 'Client', 'Assignee', 'Status', 'Created', 'Inspection Submitted', 'Quote Sent', 'Hours To Quote', 'Completed', 'Cancelled'];
  const escCsv = (v) => v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = [header.map(escCsv).join(',')];
  rows.forEach((wo) => {
    const h = hoursToQuote(wo);
    lines.push([
      wo.reference, wo.title, wo.client_name, wo.assignee_name, wo.status,
      wo.created_at, wo.inspection_submitted_at, wo.quote_sent_at,
      h !== null ? Math.round(h * 10) / 10 : '', wo.completed_at, wo.cancelled_at
    ].map(escCsv).join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="report-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

// ---------------- PDF export (summary + simple bar chart + comparison table) ----------------
router.get('/pdf', (req, res) => {
  const def = defaultRange();
  const from = req.query.from ? new Date(req.query.from).toISOString() : def.from;
  const to = req.query.to ? new Date(req.query.to).toISOString() : def.to;
  const granularity = req.query.granularity === 'month' ? 'month' : 'week';
  const assignee = req.query.assignee || null;
  const rows = fetchWorkOrders(assignee);

  const buckets = buildBuckets(from, to, granularity);
  const series = buckets.map((b) => computeMetrics(rows, b.start, b.end));

  const spanMs = new Date(to) - new Date(from);
  const prevFrom = new Date(new Date(from).getTime() - spanMs).toISOString();
  const current = computeMetrics(rows, from, to);
  const previous = computeMetrics(rows, prevFrom, from);

  const companyNameRow = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  const brandColorRow = db.prepare("SELECT value FROM settings WHERE key = 'brand_color'").get();
  const companyName = (companyNameRow && companyNameRow.value) || 'Your Company';
  const brandColor = (brandColorRow && brandColorRow.value) || '#1d4ed8';

  try { fs.mkdirSync(reportsDir, { recursive: true }); } catch (e) {}
  const pdfPath = path.join(reportsDir, `report-${uuid()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);
  const pageWidth = doc.page.width - 100;

  doc.fontSize(16).font('Helvetica-Bold').fillColor(brandColor).text(companyName);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#111').text('Operations Report');
  doc.fontSize(9).font('Helvetica').fillColor('#666').text(`${from.slice(0, 10)} to ${to.slice(0, 10)}  ·  generated ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text('This period vs. previous period');
  doc.moveDown(0.3);
  const colW = pageWidth / 4;
  const headerY = doc.y;
  ['Metric', 'This period', 'Previous', 'Change'].forEach((h, i) => {
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#666').text(h, doc.page.margins.left + i * colW, headerY, { width: colW });
  });
  doc.y = headerY + 14;
  ALL_METRICS.forEach((m) => {
    const rowY = doc.y;
    const c = current[m], p = previous[m];
    const pct = (c === null || p === null || p === 0) ? '—' : `${Math.round(((c - p) / p) * 1000) / 10}%`;
    doc.fontSize(9).font('Helvetica').fillColor('#222').text(METRIC_LABELS[m], doc.page.margins.left, rowY, { width: colW });
    doc.text(c === null ? '—' : String(c), doc.page.margins.left + colW, rowY, { width: colW });
    doc.text(p === null ? '—' : String(p), doc.page.margins.left + colW * 2, rowY, { width: colW });
    doc.text(pct, doc.page.margins.left + colW * 3, rowY, { width: colW });
    doc.y = rowY + 16;
  });

  doc.moveDown(1);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text(`Quotes sent per ${granularity}`);
  doc.moveDown(0.5);
  const chartTop = doc.y;
  const chartHeight = 110;
  const chartWidth = pageWidth;
  const maxVal = Math.max(1, ...series.map((s) => s.quotes_sent));
  const barGap = 6;
  const barWidth = Math.max(4, (chartWidth - barGap * (series.length - 1)) / series.length);
  series.forEach((s, i) => {
    const barHeight = (s.quotes_sent / maxVal) * chartHeight;
    const x = doc.page.margins.left + i * (barWidth + barGap);
    doc.rect(x, chartTop + (chartHeight - barHeight), barWidth, barHeight).fill(brandColor);
    if (series.length <= 16) {
      doc.fontSize(6).fillColor('#666').text(buckets[i].label, x - 2, chartTop + chartHeight + 4, { width: barWidth + 4, align: 'center' });
    }
  });
  doc.y = chartTop + chartHeight + 20;
  doc.x = doc.page.margins.left;

  const slowest = rows
    .filter((wo) => inRange(wo.quote_sent_at, from, to) && wo.inspection_submitted_at)
    .map((wo) => ({ reference: wo.reference, client: wo.client_name, hours: Math.round(hoursToQuote(wo) * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 8);

  if (slowest.length) {
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text('Slowest quotes this period');
    doc.moveDown(0.3);
    slowest.forEach((s) => {
      doc.fontSize(9).font('Helvetica').fillColor('#222').text(`${s.reference} — ${s.client || 'Unknown client'}: ${s.hours} hours`);
    });
  }

  doc.end();
  stream.on('finish', () => res.download(pdfPath, `Operations-Report-${from.slice(0, 10)}.pdf`));
  stream.on('error', () => res.status(500).json({ error: 'Failed to generate PDF' }));
});

module.exports = router;
