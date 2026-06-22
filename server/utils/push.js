// server/utils/push.js
const webpush = require('web-push');
const { db } = require('../db');

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const pub = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get();
  const priv = db.prepare("SELECT value FROM settings WHERE key = 'vapid_private_key'").get();
  const email = db.prepare("SELECT value FROM settings WHERE key = 'company_email'").get();
  if (pub && priv && pub.value && priv.value) {
    webpush.setVapidDetails(
      `mailto:${(email && email.value) || 'admin@example.com'}`,
      pub.value,
      priv.value
    );
    configured = true;
  }
}

/**
 * Sends a real push notification to every device a user has subscribed on.
 * Silently does nothing if the user hasn't enabled notifications on any device,
 * and cleans up subscriptions that the browser has revoked/expired.
 */
async function sendPushToUser(userId, { title, body, link }) {
  ensureConfigured();
  if (!configured) return;

  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, link: link || '#/dashboard' });

  await Promise.all(subs.map(async (sub) => {
    try {
      const subscription = JSON.parse(sub.subscription_json);
      await webpush.sendNotification(subscription, payload);
    } catch (err) {
      // 404/410 = the browser/device has revoked this subscription — remove it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('Push notification failed:', err.message);
      }
    }
  }));
}

module.exports = { sendPushToUser };
