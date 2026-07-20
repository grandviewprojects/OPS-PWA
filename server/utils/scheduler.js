// server/utils/scheduler.js
// Lightweight in-process scheduler — no external cron dependency needed.
// Runs two checks every minute:
//   1. Hour-before reminders for any calendar event starting soon (any user,
//      gated by their own "event_reminder" preference).
//   2. A "check your schedule" nudge at EACH user's own preferred time
//      (gated by their own "daily_checkin" preference), once per day.
//
// Design note: unlike the other notification categories (work order assigned,
// calendar event added, etc. — which always log to the in-app bell and only
// gate the *push* delivery), these two are pure scheduled reminders rather
// than a record of something that happened. If someone has switched a
// reminder off, skipping it entirely (no push, no bell entry either) is the
// right behavior — there's nothing useful left to log after the reminder
// window has passed if they didn't want to be reminded in the first place.
const { db } = require('../db');
const { notifyUser } = require('./notify');

// Pulled in from the quotes route so the hourly approval nudge lives with the
// rest of the quote logic but still runs on the shared scheduler tick.
let runQuoteApprovalNudgeCheck = () => {};
try { runQuoteApprovalNudgeCheck = require('../routes/quotes').runQuoteApprovalNudgeCheck; } catch (e) { /* route not loaded yet */ }

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return (row && row.value) || fallback;
}

// ---------------- 1. Hour-before event reminders ----------------
function runHourlyReminderCheck() {
  const now = Date.now();
  const windowStart = new Date(now + 55 * 60 * 1000).toISOString();
  const windowEnd = new Date(now + 65 * 60 * 1000).toISOString();

  const events = db.prepare(`
    SELECT ce.*, np.push_event_reminder
    FROM calendar_events ce
    JOIN users u ON u.id = ce.user_id
    LEFT JOIN notification_preferences np ON np.user_id = ce.user_id
    WHERE ce.reminder_sent = 0 AND ce.start_at >= ? AND ce.start_at < ? AND u.active = 1
  `).all(windowStart, windowEnd);

  events.forEach((ev) => {
    // Mark as handled either way, so we never re-check it again.
    db.prepare('UPDATE calendar_events SET reminder_sent = 1 WHERE id = ?').run(ev.id);

    const enabled = ev.push_event_reminder === null || ev.push_event_reminder === undefined ? true : !!ev.push_event_reminder;
    if (!enabled) return;

    // Use the configured timezone so the time in the message matches what the
    // user sees on their device, rather than the server's clock (which is UTC).
    const tz = getSetting('notification_timezone', 'Africa/Johannesburg');
    const startTime = new Date(ev.start_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    notifyUser(ev.user_id, 'event_reminder', `Reminder: "${ev.title}" starts at ${startTime} — about an hour from now.`, '#/calendar');
  });
}

// ---------------- 2. Daily "check your schedule" nudge (per-user time) ----------------
function localDateString(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}
function localTimeString(tz) {
  return new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

function dayBoundsUtc(todayStr, tz) {
  const offsetProbe = new Date();
  const utcStr = offsetProbe.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = offsetProbe.toLocaleString('en-US', { timeZone: tz });
  const offsetMs = new Date(tzStr) - new Date(utcStr); // how far ahead of UTC `tz` currently is

  const localMidnightAsUtc = new Date(`${todayStr}T00:00:00Z`);
  const dayStartUtc = new Date(localMidnightAsUtc.getTime() - offsetMs).toISOString();
  const dayEndUtc = new Date(localMidnightAsUtc.getTime() - offsetMs + 24 * 60 * 60 * 1000).toISOString();
  return { dayStartUtc, dayEndUtc };
}

function runDailySummaryCheck() {
  const tz = getSetting('notification_timezone', 'Africa/Johannesburg');
  const todayStr = localDateString(tz);
  const nowStr = localTimeString(tz);

  const candidates = db.prepare(`
    SELECT u.id, u.name, np.daily_checkin_time, np.last_daily_checkin_date, np.push_daily_checkin
    FROM users u
    LEFT JOIN notification_preferences np ON np.user_id = u.id
    WHERE u.active = 1
  `).all();

  candidates.forEach((u) => {
    const enabled = u.push_daily_checkin === null || u.push_daily_checkin === undefined ? true : !!u.push_daily_checkin;
    if (!enabled) return;

    const targetTime = u.daily_checkin_time || '07:00';
    if (nowStr !== targetTime) return; // only fire in the exact minute that matches their preferred time
    if (u.last_daily_checkin_date === todayStr) return; // already sent today

    const { dayStartUtc, dayEndUtc } = dayBoundsUtc(todayStr, tz);
    const events = db.prepare('SELECT title FROM calendar_events WHERE user_id = ? AND start_at >= ? AND start_at < ? ORDER BY start_at')
      .all(u.id, dayStartUtc, dayEndUtc);

    let message;
    if (events.length === 0) {
      message = 'Good morning! Nothing scheduled on your calendar today — check the app in case anything new comes in.';
    } else if (events.length === 1) {
      message = `Good morning! You have 1 item today: "${events[0].title}". Check the app for details.`;
    } else {
      message = `Good morning! You have ${events.length} items today, starting with "${events[0].title}". Check the app for your full schedule.`;
    }
    notifyUser(u.id, 'daily_checkin', message, '#/calendar');

    db.prepare('UPDATE notification_preferences SET last_daily_checkin_date = ? WHERE user_id = ?').run(todayStr, u.id);
  });
}

let intervalHandle = null;

// ---------------- 3. "Quote still needs sending" reminder (ops + admin) ----------------
// Work orders sitting in inspection_submitted (report in, quote not sent) are
// the ones that need a quote. Once per day per work order, remind every active
// admin + operational user so a ready-to-quote job doesn't get forgotten.
function runQuoteNeedsSendingCheck() {
  const woNeedingQuote = db.prepare(
    "SELECT * FROM work_orders WHERE status = 'inspection_submitted'"
  ).all();
  if (!woNeedingQuote.length) return;

  const staff = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin','operational')").all();
  if (!staff.length) return;

  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  woNeedingQuote.forEach((wo) => {
    // Throttle to once per day per work order using a marker in the activity log.
    const marker = `quote-reminder:${today}`;
    const already = db.prepare(
      'SELECT 1 FROM work_order_activity WHERE work_order_id = ? AND message = ? LIMIT 1'
    ).get(wo.id, marker);
    if (already) return;

    const now = new Date().toISOString();
    // record marker (uses the same activity table, hidden-ish system message)
    db.prepare('INSERT INTO work_order_activity (id,work_order_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
      .run(require('../db').uuid(), wo.id, 'system', marker, now);

    staff.forEach((s) => {
      notifyUser(s.id, 'quote_needs_sending', `Quote still needs sending: ${wo.reference} — ${wo.title}`, `#/work-orders/${wo.id}`);
    });
  });
}

function startScheduler() {
  if (intervalHandle) return; // already running
  const tick = () => {
    try { runHourlyReminderCheck(); } catch (e) { console.error('Hourly reminder check failed:', e.message); }
    try { runDailySummaryCheck(); } catch (e) { console.error('Daily summary check failed:', e.message); }
    try { runQuoteNeedsSendingCheck(); } catch (e) { console.error('Quote-needs-sending check failed:', e.message); }
    try { runQuoteApprovalNudgeCheck(); } catch (e) { console.error('Quote approval nudge check failed:', e.message); }
  };
  tick(); // run once immediately on boot too
  intervalHandle = setInterval(tick, 60 * 1000);
  console.log('Notification scheduler started (checks every minute).');
}

module.exports = { startScheduler, runHourlyReminderCheck, runDailySummaryCheck, runQuoteNeedsSendingCheck };
