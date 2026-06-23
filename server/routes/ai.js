// server/routes/ai.js
// AI features here are limited to dispatch assistance. The reporting system
// no longer uses AI at all — see server/routes/reports.js for real,
// data-driven analytics that work with zero external dependencies.
const express = require('express');
const { db } = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { isConfigured, askClaudeForJson } = require('../utils/ai');

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

module.exports = router;
