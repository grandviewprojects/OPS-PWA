# Onsite Ops — Operational Management PWA

A self-hosted, installable web app (PWA) for running an onsite field team and an
operational/back-office team from one system: team profiles, calendars, work
orders, an external client request portal, and branded inspection reports with
a built-in quote-SLA timer.

It's a normal Node.js web app + SQLite database — install it on any server or
small VPS, point a domain at it with HTTPS, and your whole team (and your
clients, via the public portal link) can use it from their phone or desktop.

---

## 1. What's included

**For the onsite team**
- Personal profile + calendar (auto-updated whenever they're assigned a job)
- A "My Work Orders" view of everything assigned to them
- One-tap **"Create inspection report"** on any work order → add findings,
  attach photos straight from their phone's camera/library, and **Finalize**
  to generate a branded PDF (with your company letterhead/logo) that attaches
  itself to the work order automatically
- Read-only access to their own private HR info (see below)

**For the operational/admin team**
- Separate "operational" and "admin" profile types
- Create work orders manually, or receive them automatically from the
  **public request portal** (a shareable link, no login required, for clients)
- Assign work orders to onsite staff — this instantly creates/updates an event
  on that person's calendar
- Add events to **anyone's** calendar (leave, meetings, reminders, etc.)
- Download finalized inspection report PDFs
- A **3-day quote SLA timer** starts the moment an inspection report is
  finalized, and is visible as a colour-coded chip (green → amber → red/
  "overdue") everywhere that work order appears, until someone marks the
  work order **Quote Sent**. The dashboard has a dedicated "Overdue quotes"
  section so nothing slips through.
- Admin-only: edit private/HR information on any profile, manage company
  branding (logo/letterhead, address, contact details used on PDFs) and the
  SLA window (default 72 hours)

**Extra features included for convenience**
- In-app notifications (assigned a job, new portal request, report ready,
  overdue quote) with a bell icon + unread badge
- Full activity log on every work order (who did what, when)
- Soft-deactivation of profiles (keeps history, blocks login) instead of
  destructive deletes
- Forced password change on first login for new accounts
- Installable as a Progressive Web App (works full-screen on a phone home
  screen, basic offline app-shell caching)

---

## 2. Profiles & privacy model

Every person gets one profile with a role: `onsite`, `operational`, or `admin`.

- **Public profile fields** (name, phone, job title, calendar colour, role) —
  editable by admin; a couple of self-service fields (phone/colour) can be
  edited by the person themself if you wire that up in the UI further.
- **Private information** (ID number, date of birth, address, emergency
  contact, contract type, start date, bank details, salary/rate, admin notes)
  — **the person can view their own private info but only an admin can edit
  it.** This is enforced on the server (not just hidden in the UI), so it
  can't be bypassed by calling the API directly. Operational and onsite users
  can never see another person's private info.

---

## 3. Requirements

- **Node.js 22.5 or newer** (the app uses Node's built-in `node:sqlite`
  module, so there's no native database driver to compile — this makes
  deployment far simpler than typical SQLite-based apps).
- That's it. No external database server, no Redis, nothing else required.

Check your version:
```bash
node -v   # must be v22.5.0 or higher
```

---

## 4. Local setup

```bash
cd onsite-ops-pwa
npm install
cp .env.example .env
# edit .env and set a real, random JWT_SECRET
npm start
```

The server prints a default admin login on first boot (only when the
database is empty):
```
Seeded default admin -> email: admin@example.com / password: Admin123!
```

Open **http://localhost:3000**, log in, and you'll be forced to set a new
password immediately. From there:

1. Go to **Team → + New profile** to create your onsite and operational
   accounts.
2. Go to **Settings** (admin only) to upload your company logo, set your
   company name/address/contact details (this becomes the inspection report
   letterhead), and confirm the quote SLA window (default 72 hours).
3. Share `http://your-domain.com/portal` with clients — it needs no login
   and lets them submit a work request straight into your system.

---

---

## 5a. AI dispatch suggestions (optional)

On any work order's assignment panel, admin/operational accounts see a small **✨ Suggest**
button. It looks at each onsite team member's current workload and calendar availability and
suggests who to assign — you always review and click "Save assignment" yourself, it never
assigns automatically. This is the only AI feature left in the app (the reporting system below
is 100% real data, no AI involved).

It's switched off by default and the rest of the app works completely normally without it. To
turn it on:

1. Get an API key from **console.anthropic.com** (pay-as-you-go, a few cents per suggestion)
2. Add it as an environment variable called `ANTHROPIC_API_KEY` the same way you added
   `JWT_SECRET` and `DATA_DIR` (on Render: Environment tab → Add Environment Variable)
3. Redeploy — no code changes needed, it's detected automatically

If the key isn't set, clicking "Suggest" just shows a friendly message instead of breaking.

---

## 5b. Reports — customizable analytics (no AI, no setup needed)

The **Reports** tab (admin/operational only) is a real analytics dashboard built entirely from
your own work order data — there's nothing to configure or pay for, it just works:

- **Trend graphs** — weekly or monthly charts of new work orders, completed jobs, quotes sent,
  cancellations, average time-to-quote, and SLA breaches. Pick any combination to plot together.
- **Time-to-quote tracking** — exactly how long it takes from inspection report to quote being
  sent: average, median, fastest, slowest, and a list of the slowest individual jobs so you can
  see exactly where the delays are.
- **Period comparison** — "this period vs. the previous equivalent period" with a clear
  up/down/percentage indicator on every metric.
- **Filter by onsite team member** — see the same breakdown for one person instead of the whole
  team.
- **Custom date ranges** — quick presets (last 8 weeks, last 12 weeks, last 6/12 months) or pick
  your own exact start and end dates.
- **Save your favorite report setups** — name a particular combination of filters/metrics/range
  and reload it with one click next time, instead of re-configuring it.
- **Export** — download the underlying data as CSV (for your own spreadsheets), or a formatted
  PDF snapshot (comparison table, a bar chart, and the slowest quotes) to share or file away.

---

## 5c. Notifications — in-depth, personal to each profile

Every person controls their own notifications from **My Account**, no admin setup required:

- Toggle on/off, per category: work order assigned to me, someone adds a calendar event for
  me, an inspection report is submitted/updated, a new portal request comes in, the daily
  schedule reminder, and the 1-hour-before-event reminder.
- Pick their own preferred time for the daily reminder (e.g. 6:30am instead of 7am).
- Turning off the daily reminder or the 1-hour reminder stops it completely. Turning off any
  of the other categories (work order assigned, calendar event added, etc.) only stops the
  push to their phone — it still shows up in their in-app notification bell, since those
  represent something that actually happened and are worth keeping a record of.

The two scheduled ones (daily reminder + 1-hour-before reminder) run automatically in the
background every minute the server is running — nothing to configure beyond each person's own
preferences above. The only shared setting is the company's timezone, stored as
`notification_timezone` (defaults to `Africa/Johannesburg`), used to work out what "today"
and each person's chosen time-of-day actually mean.

---

## 5. Deploying it for real (so your team can use it on their phones)

Any host that can run a long-lived Node.js process works: a small VPS
(DigitalOcean/Linode/Hetzner), Render, Railway, Fly.io, a spare office PC, etc.
Two things matter for it to behave like a proper PWA:

1. **HTTPS** — browsers only allow "Add to Home Screen" / full PWA install
   behaviour over HTTPS (localhost is exempt, for testing only). Put it
   behind a reverse proxy like Caddy or nginx with a free Let's Encrypt
   certificate, or use a platform that provides HTTPS automatically.
2. **A persistent disk** for `server/data/app.db` and `server/uploads/` —
   these hold your database and uploaded photos/PDFs/logo. If your host uses
   ephemeral containers, attach a persistent volume mounted at
   `server/data` and `server/uploads` (or point those paths at your volume).

Minimal example with Caddy as a reverse proxy on a VPS:
```
# Caddyfile
ops.yourcompany.com {
  reverse_proxy localhost:3000
}
```
Run the app under a process manager so it restarts on crash/reboot, e.g.:
```bash
npm install -g pm2
pm2 start server/index.js --name onsite-ops
pm2 save
pm2 startup
```

### Environment variables (`.env`)
| Variable     | Purpose                                                                 |
|--------------|--------------------------------------------------------------------------|
| `PORT`       | Port the app listens on (default 3000)                                  |
| `JWT_SECRET` | Long random string used to sign login sessions — **must** be set in production, or anyone could forge a login. Generate one with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

---

## 6. Backups

Everything lives in two places — back these up regularly:
- `server/data/app.db` (+ the `-wal`/`-shm` files if present) — the database
- `server/uploads/` — uploaded photos, logos, and generated PDF reports

A simple nightly cron of `tar`/`rsync` of the whole `onsite-ops-pwa/server`
folder (excluding `node_modules`) is enough for most small teams.

---

## 7. Project structure

```
onsite-ops-pwa/
├── package.json
├── .env.example
├── server/
│   ├── index.js            # Express app entry point
│   ├── db.js                # SQLite schema + seed data (node:sqlite, no native deps)
│   ├── middleware/auth.js   # JWT auth + role-check middleware
│   ├── routes/
│   │   ├── auth.js          # login, /me, change-password
│   │   ├── users.js         # profiles + admin-only private info
│   │   ├── calendar.js      # calendar events, role-based write rules
│   │   ├── workorders.js    # work order CRUD, assignment -> calendar sync
│   │   ├── inspections.js   # inspection report draft/photos/finalize/PDF
│   │   ├── portal.js        # public, unauthenticated work-order submission
│   │   ├── settings.js      # company branding + SLA config (admin only)
│   │   └── dashboard.js     # role-specific dashboard summaries + notifications
│   ├── utils/pdf.js          # branded inspection-report PDF generator (pdfkit)
│   ├── data/                 # app.db lives here (gitignored)
│   └── uploads/               # photos/, logo/, reports/ (gitignored)
└── public/                    # the PWA frontend (static, vanilla JS)
    ├── index.html, manifest.json, service-worker.js
    ├── portal.html             # public client-facing request form
    ├── css/styles.css
    └── js/ (api.js, app.js, calendar.js, workorders.js, team.js, portal.js)
```

The frontend is plain HTML/CSS/JS (no build step) so you can host the
`public/` folder anywhere — but it's served directly by the Express app by
default, which is the simplest option.

---

## 8. Notes & next steps you may want to add later

- Email/SMS notifications (currently notifications are in-app only)
- File-size/type limits on photo uploads are set generously (15MB/image) —
  tune in `server/routes/inspections.js` if needed
- The SLA timer is calculated live in the browser from `quote_due_at`; for
  email/SMS escalation reminders you'd add a small scheduled job (e.g.
  `node-cron`) that scans for overdue work orders
- Multi-company / multi-branch support is not built in — this is designed
  for a single operating company with one set of branding/settings
