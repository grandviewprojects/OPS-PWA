// server/routes/ai.js
const express = require('express');
const { db, uuid } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { isConfigured, askClaude, askClaudeForJson } = require('../utils/ai');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { reportsDir } = require('../paths');

const router = express.Router();
router.use(authRequired);
router.use(requireRole('admin', 'operational'));

router.get('/status', (req, res) => {
  res.json({ configured: isConfigured() });
});

// ---------------- Dispatch / assignment suggestion ----------------
router.post('/suggest-assignee', async (req, res) => {
  const { work_order_id } = req.body || {};
  const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(work_order_id);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });

  const candidates = db.prepare("SELECT id, name FROM users WHERE role = 'onsite' AND active = 1").all();
  if (!candidates.length) {
    return res.status(400).json({ error: 'There are no active onsite team members to suggest yet — create one in Team first.' });
  }

  const enriched = candidates.map((c) => {
    const workload = db.prepare("SELECT COUNT(*) AS c FROM work_orders WHERE assigned_to = ? AND status NOT IN ('completed','cancelled')").get(c.id).c;
    let busy = false;
    if (wo.scheduled_at) {
      const windowEnd = new Date(new Date(wo.scheduled_at).getTime() + 2 * 60 * 60 * 1000).toISOString();
      const overlap = db.prepare('SELECT COUNT(*) AS c FROM calendar_events WHERE user_id = ? AND start_at < ? AND end_at > ?')
        .get(c.id, windowEnd, wo.scheduled_at).c;
      busy = overlap > 0;
    }
    return { id: c.id, name: c.name, active_jobs: workload, busy_at_scheduled_time: busy };
  });

  const prompt = `You are helping a small field-services company dispatch a job to the best available team member.

Work order: "${wo.title}" (${wo.reference})
Priority: ${wo.priority}
Site address: ${wo.site_address || 'not specified'}
Scheduled for: ${wo.scheduled_at || 'not yet scheduled'}

Candidates (onsite team members):
${enriched.map((c) => `- id: ${c.id} | name: ${c.name} | currently has ${c.active_jobs} active job(s) | ${c.busy_at_scheduled_time ? 'BUSY at that scheduled time' : 'free at that scheduled time'}`).join('\n')}

Pick the single best candidate to assign this job to, all else being equal favour whoever has the lightest current workload and is free at the scheduled time. Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{"suggested_user_id": "<id from the list above>", "reasoning": "<one short, plain-English sentence explaining why>"}`;

  try {
    const result = await askClaudeForJson({
      system: 'You are a concise dispatch assistant for a field-services company. Always respond with strict JSON only.',
      prompt,
      maxTokens: 300
    });

    const match = enriched.find((c) => c.id === result.suggested_user_id);
    if (!match) {
      // Don't trust a hallucinated id — fall back to the lightest-workload candidate and say so.
      const fallback = [...enriched].sort((a, b) => a.active_jobs - b.active_jobs)[0];
      return res.json({
        suggestion: { user_id: fallback.id, name: fallback.name, reasoning: 'Suggested based on lowest current workload (AI response could not be matched to a candidate).' }
      });
    }
    res.json({ suggestion: { user_id: match.id, name: match.name, reasoning: result.reasoning || '' } });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ---------------- Weekly / custom-range management summary ----------------
function gatherStats(from, to) {
  const createdCount = db.prepare('SELECT COUNT(*) AS c FROM work_orders WHERE created_at BETWEEN ? AND ?').get(from, to).c;
  const portalCount = db.prepare("SELECT COUNT(*) AS c FROM work_orders WHERE created_via = 'portal' AND created_at BETWEEN ? AND ?").get(from, to).c;
  const completedCount = db.prepare('SELECT COUNT(*) AS c FROM work_orders WHERE completed_at BETWEEN ? AND ?').get(from, to).c;
  const quotesSentCount = db.prepare('SELECT COUNT(*) AS c FROM work_orders WHERE quote_sent_at BETWEEN ? AND ?').get(from, to).c;
  const cancelledCount = db.prepare('SELECT COUNT(*) AS c FROM work_orders WHERE cancelled_at BETWEEN ? AND ?').get(from, to).c;

  const avgRow = db.prepare(`SELECT AVG((julianday(quote_sent_at) - julianday(inspection_submitted_at)) * 24) AS avg_hours
    FROM work_orders WHERE quote_sent_at BETWEEN ? AND ? AND inspection_submitted_at IS NOT NULL`).get(from, to);
  const avgHoursToQuote = avgRow && avgRow.avg_hours ? Math.round(avgRow.avg_hours * 10) / 10 : null;

  const now = new Date().toISOString();
  const overdue = db.prepare(`SELECT wo.reference, wo.title, wo.client_name, u.name AS assignee_name, wo.quote_due_at
    FROM work_orders wo LEFT JOIN users u ON u.id = wo.assigned_to
    WHERE wo.status = 'inspection_submitted' AND wo.quote_due_at < ? ORDER BY wo.quote_due_at`).all(now);

  const leaderboard = db.prepare(`SELECT u.name, COUNT(*) AS completed
    FROM work_orders wo JOIN users u ON u.id = wo.assigned_to
    WHERE wo.completed_at BETWEEN ? AND ? GROUP BY u.id ORDER BY completed DESC LIMIT 5`).all(from, to);

  return { createdCount, portalCount, completedCount, quotesSentCount, cancelledCount, avgHoursToQuote, overdue, leaderboard };
}

router.post('/weekly-summary', async (req, res) => {
  const now = new Date();
  const to = (req.body && req.body.to) ? new Date(req.body.to).toISOString() : now.toISOString();
  const from = (req.body && req.body.from) ? new Date(req.body.from).toISOString() : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const stats = gatherStats(from, to);

  const prompt = `Write a concise weekly management summary for a field-services company, based on this data for the period ${from.slice(0, 10)} to ${to.slice(0, 10)}:

- New work orders created: ${stats.createdCount} (${stats.portalCount} came from the public client portal)
- Jobs completed: ${stats.completedCount}
- Quotes sent: ${stats.quotesSentCount}
- Jobs cancelled: ${stats.cancelledCount}
- Average time from inspection report to quote being sent: ${stats.avgHoursToQuote !== null ? stats.avgHoursToQuote + ' hours' : 'no quotes sent in this period'}
- Currently overdue quotes (past the SLA deadline, right now): ${stats.overdue.length}
${stats.overdue.slice(0, 10).map((o) => `   - ${o.reference} (${o.client_name || 'unknown client'}), assigned to ${o.assignee_name || 'unassigned'}`).join('\n')}
- Jobs completed per onsite team member this period: ${stats.leaderboard.map((l) => `${l.name}: ${l.completed}`).join(', ') || 'none completed this period'}

Write it as plain text with three short sections: "Highlights", "Concerns", and "Recommendations". Keep it factual and concise — a business owner should be able to read it in under a minute. Do not invent any numbers not given above. If there are no overdue quotes, say so positively in Highlights instead of Concerns.`;

  try {
    const content = await askClaude({
      system: 'You write clear, concise, factual management summaries for a small business owner. No fluff, no markdown headers, just plain readable text with the three labeled sections requested.',
      prompt,
      maxTokens: 700
    });

    const id = uuid();
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO ai_reports (id,type,period_start,period_end,content,stats_json,generated_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, 'weekly_summary', from, to, content, JSON.stringify(stats), req.user.id, createdAt);

    res.json({ report: { id, type: 'weekly_summary', period_start: from, period_end: to, content, stats, created_at: createdAt } });
  } catch (e) {
    res.status(503).json({ error: e.message, stats }); // still return the raw stats so the page isn't empty even if AI is down
  }
});

router.get('/reports', (req, res) => {
  const rows = db.prepare('SELECT id, type, period_start, period_end, generated_by, created_at FROM ai_reports ORDER BY created_at DESC LIMIT 50').all();
  res.json({ reports: rows });
});

router.get('/reports/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ai_reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ report: { ...row, stats: JSON.parse(row.stats_json || '{}') } });
});

router.get('/reports/:id/pdf', (req, res) => {
  const row = db.prepare('SELECT * FROM ai_reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const companyNameRow = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  const companyName = (companyNameRow && companyNameRow.value) || 'Your Company';

  try { fs.mkdirSync(reportsDir, { recursive: true }); } catch (e) {}
  const pdfPath = path.join(reportsDir, `ai-report-${row.id}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  doc.fontSize(16).font('Helvetica-Bold').fillColor('#1d4ed8').text(companyName);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#111').text('Weekly Management Summary', { paragraphGap: 4 });
  doc.fontSize(9).font('Helvetica').fillColor('#666').text(`${row.period_start.slice(0, 10)} to ${row.period_end.slice(0, 10)} — generated ${new Date(row.created_at).toLocaleString()}`);
  doc.moveDown(1);
  doc.fontSize(10).font('Helvetica').fillColor('#222').text(row.content, { width: doc.page.width - 100 });
  doc.end();

  stream.on('finish', () => res.download(pdfPath, `Weekly-Summary-${row.period_start.slice(0, 10)}.pdf`));
  stream.on('error', () => res.status(500).json({ error: 'Failed to generate PDF' }));
});

module.exports = router;
