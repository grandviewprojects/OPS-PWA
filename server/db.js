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

// ---- Migration: relax the users.role CHECK constraint to allow new roles ----
// SQLite can't ALTER a CHECK constraint directly. A naive rebuild using
// "ALTER TABLE users RENAME TO users_old" silently breaks every foreign key
// that points at users(id) — SQLite auto-rewrites those FK definitions to
// point at the renamed table, and once the old table is dropped they're left
// dangling (cascading deletes quietly stop working). Tested fix: build the
// replacement table under a new name, copy data in, DROP the original (which
// does NOT trigger that FK rewrite), then rename the replacement into place.
(function migrateUsersRoleConstraint() {
  const usersSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!usersSchema || !usersSchema.sql || !usersSchema.sql.includes("CHECK(role IN")) return; // already migrated, or fresh install

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec(`CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      phone TEXT,
      job_title TEXT,
      photo TEXT,
      color TEXT DEFAULT '#2563eb',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    db.exec(`INSERT INTO users_new (id,name,email,password_hash,role,phone,job_title,photo,color,active,must_change_password,created_at,updated_at)
      SELECT id,name,email,password_hash,role,phone,job_title,photo,color,active,must_change_password,created_at,updated_at FROM users;`);
    db.exec('DROP TABLE users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
    db.exec('COMMIT;');
    console.log('Migrated users table: role can now be admin, operational, onsite, or marketing.');
  } catch (e) {
    db.exec('ROLLBACK;');
    console.error('users.role migration failed, leaving old schema in place:', e.message);
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
})();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS job_cards (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  special_instructions TEXT,
  general_materials TEXT,
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

CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_assigned_work_order INTEGER NOT NULL DEFAULT 1,
  push_calendar_event_added INTEGER NOT NULL DEFAULT 1,
  push_daily_checkin INTEGER NOT NULL DEFAULT 1,
  push_event_reminder INTEGER NOT NULL DEFAULT 1,
  push_inspection_report_ready INTEGER NOT NULL DEFAULT 1,
  push_new_portal_request INTEGER NOT NULL DEFAULT 1,
  daily_checkin_time TEXT NOT NULL DEFAULT '07:00',
  last_daily_checkin_date TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_activity (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  value TEXT,
  notes TEXT,
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_activity (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Rate catalog: reusable material & labour line items with unit prices.
CREATE TABLE IF NOT EXISTS rate_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'material',   -- 'material' | 'labour'
  name TEXT NOT NULL,
  unit TEXT,                                -- e.g. 'each', 'bag', 'm', 'hour'
  unit_price REAL NOT NULL DEFAULT 0,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Quotes attached to a work order.
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  reference TEXT,
  title TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',     -- draft | pending_approval | approved | rejected | sent | accepted
  subtotal REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 15,
  vat_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  approver_id TEXT REFERENCES users(id),
  approval_requested_at TEXT,
  approved_at TEXT,
  approved_by TEXT,
  rejected_at TEXT,
  last_approval_nudge_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Individual line items on a quote (snapshotted, so later rate changes don't alter sent quotes).
CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'material',
  name TEXT NOT NULL,
  unit TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
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
    quote_sla_hours: '72',
    notification_timezone: 'Africa/Johannesburg'
  };
  const insertIfMissing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) insertIfMissing.run(k, v);

  // Migration: add reminder_sent to calendar_events if it doesn't exist yet
  // (safe to run on every boot — silently no-ops once the column is there).
  try { db.exec('ALTER TABLE calendar_events ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE work_orders ADD COLUMN job_card_id TEXT'); } catch (e) { /* already exists */ }
  // Timestamp of the most recent note/activity, used to reset "Needs attention" after 2 days.
  try { db.exec('ALTER TABLE work_orders ADD COLUMN last_note_at TEXT'); } catch (e) { /* already exists */ }
  // When a quote is accepted by the client.
  try { db.exec('ALTER TABLE work_orders ADD COLUMN quote_accepted_at TEXT'); } catch (e) { /* already exists */ }
  // Add 'quote_accepted' as a valid status is handled in the route layer (VALID_STATUSES).
  try { db.exec("ALTER TABLE quotes ADD COLUMN last_approval_nudge_at TEXT"); } catch (e) { /* already exists */ }

  // Make sure every existing user has a notification_preferences row (new users
  // get one created at signup time; this backfills anyone created before this
  // feature existed).
  const usersWithoutPrefs = db.prepare(`
    SELECT u.id FROM users u LEFT JOIN notification_preferences np ON np.user_id = u.id WHERE np.user_id IS NULL
  `).all();
  const insertPrefs = db.prepare('INSERT INTO notification_preferences (user_id, updated_at) VALUES (?, ?)');
  usersWithoutPrefs.forEach((u) => insertPrefs.run(u.id, new Date().toISOString()));

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
