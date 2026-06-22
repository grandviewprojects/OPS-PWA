// server/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authRequired, signToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  res.json({
    token,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      phone: user.phone, job_title: user.job_title, photo: user.photo,
      color: user.color, must_change_password: !!user.must_change_password
    }
  });
});

router.get('/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT id,name,email,role,phone,job_title,photo,color,must_change_password FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user });
});

router.post('/change-password', authRequired, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .run(hash, new Date().toISOString(), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
