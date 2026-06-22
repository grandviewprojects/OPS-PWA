// server/db.js
// Uses Node's built-in node:sqlite (no native compilation required).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { dataDir } = require('./paths');

const DB_PATH = path.join(dataDir, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','operational','onsite')),
  phone TEXT,
  job_title TEXT,
  photo TEXT,
  color TEXT DEFAULT '#2563eb',
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS private_info (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id_number TEXT,
  date_of_birth TEXT,
  address TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  bank_details TEXT,
  salary_rate TEXT,
  contract_type TEXT,
  start_date TEXT,
  admin_notes TEXT,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'manual',
  work_order_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  client_name TEXT,
  client_email TEXT,
  client_phone TEXT,
  site_address TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'new',
  assigned_to TEXT REFERENCES users(id),
  created_via TEXT NOT NULL DEFAULT 'internal',
  requested_by_name TEXT,
  requested_by_email TEXT,
  requested_by_phone TEXT,
  scheduled_at TEXT,
  inspection_report_id TEXT,
  inspection_submitted_at TEXT,
  quote_due_at TEXT,
  quote_sent_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inspection_reports (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  sections TEXT NOT NULL DEFAULT '[]',
  photos TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  finalized_at TEXT,
  pdf_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS work_order_activity (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  user_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'weekly_summary',
  period_start TEXT,
  period_end TEXT,
  content TEXT NOT NULL,
  stats_json TEXT,
  generated_by TEXT,
  created_at TEXT NOT NULL
);
`);

// ---- Seed default admin + settings on first run ----
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const now = new Date().toISOString();
    const id = uuid();
    const hash = bcrypt.hashSync('Admin123!', 10);
    db.prepare(`INSERT INTO users (id,name,email,password_hash,role,phone,job_title,color,active,must_change_password,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,1,?,?)`)
      .run(id, 'System Admin', 'admin@example.com', hash, 'admin', '', 'Administrator', '#1d4ed8', now, now);
    db.prepare('INSERT INTO private_info (user_id, updated_at) VALUES (?,?)').run(id, now);
    console.log('Seeded default admin -> email: admin@example.com / password: Admin123! (please change this immediately)');
  }
  const defaults = {
    company_name: 'Your Company Name',
    company_address: '123 Main Street, Your City',
    company_phone: '+27 00 000 0000',
    company_email: 'info@yourcompany.com',
    company_website: '',
    registration_number: '',
    vat_number: '',
    company_logo: '',
    brand_color: '#1d4ed8',
    quote_sla_hours: '72'
  };
  const insertIfMissing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) insertIfMissing.run(k, v);

  // Auto-generate VAPID keys for push notifications, once, so no manual setup is needed.
  const hasVapid = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get();
  if (!hasVapid || !hasVapid.value) {
    const webpush = require('web-push');
    const keys = webpush.generateVAPIDKeys();
    insertIfMissing.run('vapid_public_key', keys.publicKey);
    insertIfMissing.run('vapid_private_key', keys.privateKey);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(keys.publicKey, 'vapid_public_key');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(keys.privateKey, 'vapid_private_key');
  }
}
seed();

module.exports = { db, uuid, n: v => (v === undefined ? null : v) };
