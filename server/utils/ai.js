// server/utils/ai.js
// Thin wrapper around the Anthropic API. Uses plain fetch (Node 22 has it
// built in) so no extra SDK dependency is needed.
//
// Requires an ANTHROPIC_API_KEY environment variable to be set. If it's
// missing, every function here throws a clear, friendly error that the
// routes catch and turn into a "not configured yet" response — the app
// keeps working normally, these AI features just stay switched off.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'; // fast + cheap, plenty for admin summaries

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Sends a single prompt to Claude and returns the plain text response.
 */
async function askClaude({ system, prompt, maxTokens = 1024 }) {
  if (!isConfigured()) {
    throw new Error('AI features aren\'t set up yet — add an ANTHROPIC_API_KEY environment variable to enable them.');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('AI returned an empty response.');
  return text;
}

/**
 * Same as askClaude, but expects (and validates) a JSON object back.
 * Strips markdown code fences defensively, since models sometimes wrap
 * JSON in ```json blocks even when told not to.
 */
async function askClaudeForJson({ system, prompt, maxTokens = 1024 }) {
  const raw = await askClaude({ system, prompt, maxTokens });
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('AI response could not be understood — please try again.');
  }
}

module.exports = { isConfigured, askClaude, askClaudeForJson, MODEL };
