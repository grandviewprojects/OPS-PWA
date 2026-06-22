// server/routes/push.js
const express = require('express');
const { db, uuid } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// Public VAPID key the browser needs to create a push subscription
router.get('/public-key', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get();
  res.json({ public_key: row ? row.value : null });
});

router.post('/subscribe', (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id = ?, subscription_json = ? WHERE id = ?')
      .run(req.user.id, JSON.stringify(subscription), existing.id);
  } else {
    db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, subscription_json, created_at) VALUES (?,?,?,?,?)')
      .run(uuid(), req.user.id, subscription.endpoint, JSON.stringify(subscription), new Date().toISOString());
  }
  res.json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
