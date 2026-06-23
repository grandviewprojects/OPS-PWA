// server/utils/notify.js
const { db, uuid } = require('../db');
const { sendPushToUser } = require('./push');

const CATEGORIES = [
  'assigned_work_order',
  'calendar_event_added',
  'daily_checkin',
  'event_reminder',
  'inspection_report_ready',
  'new_portal_request'
];

function ensurePrefsRow(userId) {
  let row = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO notification_preferences (user_id, updated_at) VALUES (?, ?)').run(userId, new Date().toISOString());
    row = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  }
  return row;
}

/**
 * Records an in-app notification (always, regardless of preferences — the
 * bell icon stays a complete history) and sends a real push notification
 * only if the recipient has that category switched on.
 */
function notifyUser(userId, category, message, link) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO notifications (id,user_id,message,link,read,created_at) VALUES (?,?,?,?,0,?)')
    .run(uuid(), userId, message, link || '#/dashboard', now);

  const prefs = ensurePrefsRow(userId);
  const col = `push_${category}`;
  const enabled = prefs && col in prefs ? !!prefs[col] : true;
  if (enabled) {
    sendPushToUser(userId, { title: 'Onsite Ops', body: message, link: link || '#/dashboard' }).catch(() => {});
  }
}

module.exports = { notifyUser, ensurePrefsRow, CATEGORIES };
