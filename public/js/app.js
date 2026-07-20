// public/js/app.js
const App = (() => {
  const state = { user: null, notifications: [], settings: {} };

  // ---------- Toast ----------
  function toast(message, type = '') {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  }

  function fmtDate(iso, opts) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, opts || { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function statusLabel(s) { return (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

  function slaInfo(workOrder) {
    if (workOrder.status !== 'inspection_submitted' || !workOrder.quote_due_at) return null;
    const due = new Date(workOrder.quote_due_at).getTime();
    const now = Date.now();
    const diffMs = due - now;
    const hrs = Math.round(diffMs / 3600000);
    if (diffMs < 0) {
      return { cls: 'sla-overdue', label: `Overdue by ${Math.abs(hrs)}h — quote needed now` };
    } else if (hrs <= 24) {
      return { cls: 'sla-warning', label: `Due in ${hrs}h — send quote soon` };
    }
    return { cls: 'sla-ok', label: `Quote due in ${Math.round(hrs / 24)}d ${hrs % 24}h` };
  }

  // ---------- Modal ----------
  function openModal(title, bodyHtml, onMount) {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'activeModal';
    backdrop.innerHTML = `<div class="modal">
      <button class="modal-close" data-close-modal>&times;</button>
      <h2>${esc(title)}</h2>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    backdrop.querySelector('[data-close-modal]').addEventListener('click', closeModal);
    document.body.appendChild(backdrop);
    if (onMount) onMount(backdrop.querySelector('.modal-body'));
  }
  function closeModal() {
    const m = document.getElementById('activeModal');
    if (m) m.remove();
  }

  // ---------- Router ----------
  const routes = [];
  function route(pattern, handler) { routes.push({ pattern, handler }); }
  function navigate(hash) { location.hash = hash; }

  // Track the previous "list" location so detail pages can offer a Back link
  // that returns where the user actually came from (e.g. dashboard vs work
  // orders list), rather than a hardcoded destination.
  let previousHash = '/dashboard';
  let currentHash = '/dashboard';
  function backTarget(fallback) {
    // Only treat it as a valid back target if it isn't the same detail page.
    if (previousHash && previousHash !== currentHash) return previousHash;
    return fallback || '/dashboard';
  }

  async function render() {
    const hash = location.hash.replace(/^#/, '') || '/dashboard';
    const [pathPart] = hash.split('?');
    const segments = pathPart.split('/').filter(Boolean);

    // Maintain previous/current for smart back navigation.
    if (pathPart !== currentHash) { previousHash = currentHash; currentHash = pathPart; }

    if (!state.user) {
      renderLogin();
      return;
    }

    for (const r of routes) {
      const m = matchRoute(r.pattern, segments);
      if (m) {
        await renderShell(pathPart);
        try {
          await r.handler(m);
        } catch (e) {
          if (e.status === 401) return logout();
          document.getElementById('view').innerHTML = `<div class="card"><p class="error-box" style="color:var(--danger)">${esc(e.message)}</p></div>`;
        }
        return;
      }
    }
    navigate('/dashboard');
  }

  function matchRoute(pattern, segments) {
    const pSegs = pattern.split('/').filter(Boolean);
    if (pSegs.length !== segments.length) return null;
    const params = {};
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(':')) params[pSegs[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (pSegs[i] !== segments[i]) return null;
    }
    return params;
  }

  // ---------- Auth ----------
  function renderLogin() {
    document.getElementById('app').innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="loginForm">
        <img id="loginLogo" style="display:none;max-height:52px;margin:0 auto 12px;display:block">
        <h1 id="loginTitle">🛠️ Onsite Ops</h1>
        <p class="sub">Sign in to your team account</p>
        <div id="loginError"></div>
        <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username"></div>
        <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        <p class="hint">Need a request handled externally? Use the <a href="/portal" target="_blank">public request portal</a> instead — no login required.</p>
      </form>
    </div>`;
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const res = await API.post('/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
        API.setToken(res.token);
        state.user = res.user;
        await afterLogin();
      } catch (err) {
        document.getElementById('loginError').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    });

    // Progressively apply the real company branding once it loads — the form
    // itself is already usable immediately, this just fills in the identity.
    API.get('/api/portal/branding').then((branding) => {
      const titleEl = document.getElementById('loginTitle');
      if (!titleEl) return; // user may have already navigated away
      if (branding.brand_color) document.documentElement.style.setProperty('--brand', branding.brand_color);

      const companyName = branding.company_name && branding.company_name !== 'Your Company Name' ? branding.company_name : null;
      titleEl.textContent = companyName ? `${companyName} Company Portal` : 'Onsite Ops';

      if (branding.company_logo) {
        const logoEl = document.getElementById('loginLogo');
        logoEl.src = `/uploads/logo/${esc(branding.company_logo.split('/').pop())}`;
        logoEl.alt = companyName || 'Company logo';
        logoEl.style.display = 'block';
      }
    }).catch(() => {});
  }

  async function afterLogin() {
    await loadNotifications();
    try { state.settings = (await API.get('/api/settings')).settings; } catch (e) {}
    setupPushNotifications();
    if (state.user.must_change_password) navigate('/account?force=1');
    else render();
  }

  const logoutHooks = [];
  function onLogout(fn) { logoutHooks.push(fn); }

  function logout() {
    API.setToken(null);
    state.user = null;
    logoutHooks.forEach((fn) => { try { fn(); } catch (e) {} });
    render();
  }

  async function tryRestoreSession() {
    if (!API.token()) return;
    try {
      const res = await API.get('/api/auth/me');
      state.user = res.user;
      await loadNotifications();
      try { state.settings = (await API.get('/api/settings')).settings; } catch (e) {}
      setupPushNotifications();
    } catch (e) {
      API.setToken(null);
    }
  }

  async function loadNotifications() {
    try { state.notifications = (await API.get('/api/dashboard/notifications')).notifications; } catch (e) {}
  }

  // ---------- Push notifications (real phone/desktop notifications) ----------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  async function subscribeToPush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const { public_key } = await API.get('/api/push/public-key');
      if (!public_key) return;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(public_key)
        });
      }
      await API.post('/api/push/subscribe', { subscription: sub.toJSON ? sub.toJSON() : sub });
    } catch (e) { /* push not available/blocked — silently skip, in-app notifications still work */ }
  }

  function setupPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      subscribeToPush();
    } else if (Notification.permission === 'default' && !sessionStorage.getItem('push_banner_dismissed')) {
      showPushBanner();
    }
  }

  function showPushBanner() {
    if (document.getElementById('pushBanner')) return;
    const bar = document.createElement('div');
    bar.id = 'pushBanner';
    bar.style.cssText = 'position:sticky;top:0;z-index:60;background:#111827;color:white;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:0.88em';
    bar.innerHTML = `<span>📱 Turn on notifications to get alerted about new work orders and updates instantly.</span>
      <span style="display:flex;gap:8px;flex-shrink:0">
        <button id="pushEnableBtn" style="background:white;color:#111827;border:none;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer">Enable</button>
        <button id="pushDismissBtn" style="background:none;color:white;border:1px solid rgba(255,255,255,.4);padding:6px 12px;border-radius:6px;cursor:pointer">Not now</button>
      </span>`;
    document.body.prepend(bar);
    document.getElementById('pushEnableBtn').addEventListener('click', async () => {
      const perm = await Notification.requestPermission();
      bar.remove();
      if (perm === 'granted') { await subscribeToPush(); toast('Notifications enabled', 'success'); }
    });
    document.getElementById('pushDismissBtn').addEventListener('click', () => {
      sessionStorage.setItem('push_banner_dismissed', '1');
      bar.remove();
    });
  }

  // ---------- Shell (top bar + tabs) ----------
  async function renderShell(currentPath) {
    const u = state.user;
    const unread = state.notifications.filter(n => !n.read).length;

    const tabs = [];
    if (u.role === 'marketing') {
      tabs.push({ href: '#/dashboard', label: 'Dashboard', match: '/dashboard' });
      tabs.push({ href: '#/leads', label: 'Leads', match: '/leads' });
      tabs.push({ href: '#/tasks', label: 'Tasks', match: '/tasks' });
    } else {
      tabs.push({ href: '#/dashboard', label: 'Dashboard', match: '/dashboard' });
      tabs.push({ href: '#/calendar', label: 'Calendar', match: '/calendar' });
      tabs.push({ href: '#/work-orders', label: 'Work Orders', match: '/work-orders' });
      if (u.role === 'admin' || u.role === 'operational') tabs.push({ href: '#/team', label: 'Team', match: '/team' });
      if (u.role === 'admin' || u.role === 'operational') tabs.push({ href: '#/reports', label: 'Reports', match: '/reports' });
      if (u.role === 'admin' || u.role === 'operational') tabs.push({ href: '#/tasks', label: 'Tasks', match: '/tasks' });
      if (u.role === 'admin' || u.role === 'operational') tabs.push({ href: '#/rate-catalog', label: 'Rate Catalog', match: '/rate-catalog' });
    }
    if (u.role === 'admin') tabs.push({ href: '#/leads', label: 'Leads', match: '/leads' });
    if (u.role === 'admin') tabs.push({ href: '#/settings', label: 'Settings', match: '/settings' });

    document.getElementById('app').innerHTML = `
      <header class="topbar">
        <div class="brand">${state.settings.company_logo ? `<img src="/uploads/logo/${esc((state.settings.company_logo||'').split('/').pop())}">` : '🛠️'} <span>${esc(state.settings.company_name || 'Onsite Ops')}</span></div>
        <div class="actions">
          <button class="icon-btn" id="notifBtn" title="Notifications">🔔${unread ? '<span class="badge-dot"></span>' : ''}</button>
          <a href="#/account" class="avatar" title="${esc(u.name)}" style="background:${esc(u.color || '#2563eb')}">${initials(u.name)}</a>
        </div>
      </header>
      <nav class="tabbar">
        ${tabs.map(t => `<a href="${t.href}" class="${currentPath.startsWith(t.match) ? 'active' : ''}">${t.label}</a>`).join('')}
      </nav>
      <main class="content" id="view"><div class="card"><div class="flex"><div class="spinner"></div> Loading…</div></div></main>
    `;
    document.getElementById('notifBtn').addEventListener('click', showNotificationsPanel);
  }

  function showNotificationsPanel() {
    const html = state.notifications.length
      ? state.notifications.map(n => `
        <div class="list-item" data-notif="${n.id}" data-link="${esc(n.link || '')}" style="${n.read ? 'opacity:.6' : ''}">
          <div><div>${esc(n.message)}</div><div class="meta">${fmtDateTime(n.created_at)}</div></div>
        </div>`).join('')
      : `<div class="empty-state">No notifications yet.</div>`;
    openModal('Notifications', `<div>${html}</div><div class="modal-actions"><button class="btn btn-sm" id="markAllRead">Mark all read</button></div>`, (body) => {
      body.querySelectorAll('[data-notif]').forEach(el => el.addEventListener('click', async () => {
        await API.put(`/api/dashboard/notifications/${el.dataset.notif}/read`);
        const link = el.dataset.link;
        closeModal();
        if (link) navigate(link.replace(/^#/, ''));
        await loadNotifications();
      }));
      document.getElementById('markAllRead').addEventListener('click', async () => {
        await API.put('/api/dashboard/notifications/read-all');
        await loadNotifications();
        closeModal();
      });
    });
  }

  // ---------- Dashboard ----------
  route('/dashboard', async () => {
    const view = document.getElementById('view');

    // ── Marketing role: unchanged ────────────────────────────────────────────
    if (state.user.role === 'marketing') {
      const [{ leads }, { tasks }] = await Promise.all([API.get('/api/leads'), API.get('/api/tasks')]);
      const stageCounts = {};
      ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'].forEach((s) => stageCounts[s] = 0);
      leads.forEach((l) => { stageCounts[l.status] = (stageCounts[l.status] || 0) + 1; });
      const openTasks = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
      const recentLeads = [...leads].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 6);
      view.innerHTML = `
        <div class="section-title"><h2>🎯 Sales Overview</h2><a href="#/leads" class="btn btn-sm">Open pipeline</a></div>
        <div class="grid grid-4">
          <div class="card stat-card"><div class="num">${stageCounts.new}</div><div class="label">New leads</div></div>
          <div class="card stat-card"><div class="num">${stageCounts.contacted + stageCounts.qualified}</div><div class="label">In progress</div></div>
          <div class="card stat-card"><div class="num">${stageCounts.proposal}</div><div class="label">Proposal sent</div></div>
          <div class="card stat-card" style="border-color:var(--success);background:var(--success-light)"><div class="num" style="color:var(--success)">${stageCounts.won}</div><div class="label">Won</div></div>
        </div>
        <div class="section-title mt20"><h2>My open tasks</h2><a href="#/tasks" class="btn btn-sm">View all</a></div>
        <div class="card">${openTasks.length ? openTasks.slice(0, 5).map((t) => `
          <div class="list-item" style="cursor:default"><div><div class="title">${esc(t.title)}</div><div class="meta">${t.due_at ? 'Due ' + fmtDateTime(t.due_at) : 'No deadline'}</div></div></div>
        `).join('') : '<div class="empty-state">No open tasks. 🎉</div>'}</div>
        <div class="section-title mt20"><h2>Recently updated leads</h2></div>
        <div class="card">${recentLeads.length ? recentLeads.map((l) => `
          <div class="list-item" style="cursor:default"><div><div class="title">${esc(l.name)}</div><div class="meta">${esc(l.company || '')}${l.assignee_name ? ' · ' + esc(l.assignee_name) : ''}</div></div><span class="badge" style="background:#eee">${l.status}</span></div>
        `).join('') : '<div class="empty-state">No leads yet — add your first one.</div>'}</div>
      `;
      return;
    }

    const data = await API.get('/api/dashboard');

    // ── Onsite role: unchanged ───────────────────────────────────────────────
    if (data.role === 'onsite') {
      view.innerHTML = `
        <div class="section-title"><h2>My upcoming work</h2></div>
        <div id="myOrders"></div>
        <div class="section-title mt20"><h2>Upcoming on my calendar</h2><a href="#/calendar" class="btn btn-sm">Open calendar</a></div>
        <div class="card">${data.upcoming_events.length ? data.upcoming_events.map(ev => `
          <div class="list-item"><div><div class="title">${esc(ev.title)}</div><div class="meta">${fmtDateTime(ev.start_at)}</div></div></div>
        `).join('') : '<div class="empty-state">Nothing scheduled yet.</div>'}</div>
      `;
      const ordersEl = document.getElementById('myOrders');
      ordersEl.innerHTML = data.my_work_orders.length
        ? data.my_work_orders.map(wo => woListItem(wo)).join('')
        : `<div class="card empty-state">🎉 No active work orders assigned to you.</div>`;
      attachWoClicks(ordersEl);
      return;
    }

    // ── Admin / Operational: pipeline dashboard ──────────────────────────────
    const { pipeline, jobs_in_progress, jobs_completed, jobs_accepted, overdue_quotes, unassigned, stalled_quotes, total_active } = data;

    const STAGES = [
      { key: 'new',                  label: 'New',               emoji: '📥', color: '#6c757d', next: 'Assign someone' },
      { key: 'assigned',             label: 'Assessment Pending', emoji: '📋', color: '#0d6efd', next: 'Complete assessment' },
      { key: 'in_progress',          label: 'In Progress',        emoji: '🔧', color: '#fd7e14', next: '' },
      { key: 'inspection_submitted', label: 'Quote Needed',       emoji: '💰', color: '#dc3545', next: 'Send quote to client' },
      { key: 'quote_sent',           label: 'Quote Sent',         emoji: '⏳', color: '#6f42c1', next: 'Awaiting client approval' },
      { key: 'quote_accepted',       label: 'Quote Accepted',     emoji: '🤝', color: '#20c997', next: 'Schedule the work' },
      { key: 'completed',            label: 'Completed',          emoji: '✅', color: '#198754', next: '' },
    ];

    function stageFor(key) { return STAGES.find(s => s.key === key) || {}; }

    function daysLabel(n) {
      if (n === null || n === undefined) return '';
      if (n === 0) return 'today';
      if (n === 1) return '1 day';
      return `${n} days`;
    }

    function pipelineWoRow(wo) {
      const st = stageFor(wo.status);
      const days = wo.days_in_stage;
      const daysStr = daysLabel(days);
      const isOverdue = wo.status === 'inspection_submitted' && wo.quote_due_at && wo.quote_due_at < new Date().toISOString();
      const isStalled = wo.status === 'quote_sent' && days > 7;
      const urgency = isOverdue ? 'color:var(--danger);font-weight:600' : isStalled ? 'color:#fd7e14;font-weight:600' : 'color:var(--muted)';
      return `<div class="list-item pipeline-row" data-wo="${wo.id}" style="border-left:3px solid ${st.color || '#ddd'};padding-left:12px;margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <div class="title" style="margin-bottom:2px">${esc(wo.reference)} — ${esc(wo.title)}</div>
          <div class="meta">${esc(wo.client_name || 'No client')}${wo.site_address ? ' · ' + esc(wo.site_address) : ''}</div>
          ${wo.assignee_name ? `<div class="meta">👤 ${esc(wo.assignee_name)}</div>` : '<div class="meta" style="color:var(--danger)">⚠️ Unassigned</div>'}
        </div>
        <div class="text-right" style="flex-shrink:0;margin-left:12px">
          ${wo.scheduled_at ? `<div style="color:var(--brand);font-size:.78em;font-weight:600">📅 ${fmtDateTime(wo.scheduled_at)}</div>` : ''}
          ${daysStr ? `<div style="${urgency};font-size:.8em">${daysStr} at this stage</div>` : ''}
          ${isOverdue ? `<div style="color:var(--danger);font-size:.75em;font-weight:600">QUOTE OVERDUE</div>` : ''}
          ${isStalled ? `<div style="color:#fd7e14;font-size:.75em;font-weight:600">NO RESPONSE YET</div>` : ''}
          ${wo.quote_due_at && wo.status === 'inspection_submitted' && !isOverdue
            ? `<div style="color:var(--muted);font-size:.75em">Due ${fmtDate(wo.quote_due_at)}</div>` : ''}
        </div>
      </div>`;
    }

    // Needs-attention alerts
    const attentionItems = [
      ...overdue_quotes.map(wo => ({
        wo, label: 'Quote overdue', bg: 'var(--danger-light)', border: 'var(--danger)',
        sub: `Since ${fmtDate(wo.quote_due_at)} · ${wo.assignee_name || 'Unassigned'}`
      })),
      ...unassigned.map(wo => ({
        wo, label: 'Unassigned', bg: '#fff3cd', border: '#ffc107',
        sub: `Received ${fmtDate(wo.created_at)} · ${statusLabel(wo.status)}`
      })),
      ...stalled_quotes.map(wo => ({
        wo, label: 'No client response', bg: '#fff0e6', border: '#fd7e14',
        sub: `Quote sent ${fmtDate(wo.quote_sent_at)} · ${wo.assignee_name || 'Unassigned'}`
      })),
    ];
    const seen = new Set();
    const dedupedAlerts = attentionItems.filter(a => { if (seen.has(a.wo.id)) return false; seen.add(a.wo.id); return true; });

    // Summary bar
    const summaryBar = STAGES.map(st => {
      const bucket = pipeline.find(p => p.key === st.key) || { count: 0 };
      return `<div class="pipeline-summary-cell" title="${st.label}">
        <div class="pipeline-summary-count" style="color:${st.color}">${bucket.count}</div>
        <div class="pipeline-summary-label">${st.emoji} ${st.label}</div>
      </div>`;
    }).join('<div class="pipeline-summary-arrow">›</div>');

    view.innerHTML = `
      <div class="section-title" style="margin-bottom:8px">
        <h2>Operations Pipeline</h2>
        <a href="#/work-orders" class="btn btn-sm">All work orders</a>
      </div>

      <div class="card pipeline-summary-bar">${summaryBar}</div>

      ${dedupedAlerts.length ? `
      <div class="section-title mt20"><h2 style="color:var(--danger)">⚠️ Needs attention (${dedupedAlerts.length})</h2></div>
      <div class="card" id="alertsList">
        ${dedupedAlerts.map(({ wo, label, bg, border, sub }) => `
          <div class="list-item pipeline-row" data-wo="${wo.id}"
               style="border-left:4px solid ${border};background:${bg};padding-left:12px;margin-bottom:4px">
            <div style="flex:1;min-width:0">
              <div class="title">${esc(wo.reference)} — ${esc(wo.title)}</div>
              <div class="meta">${esc(wo.client_name || '')}${wo.site_address ? ' · ' + esc(wo.site_address) : ''}</div>
              <div class="meta">${sub}</div>
            </div>
            <div class="text-right" style="flex-shrink:0;margin-left:12px">
              <span class="badge" style="background:${border};color:#fff">${label}</span>
            </div>
          </div>
        `).join('')}
      </div>` : ''}

      <div class="section-title mt20"><h2>Quote pipeline — ${total_active} active</h2></div>
      <div id="pipelineStages"></div>

      <div class="section-title mt20"><h2>🤝 Quote accepted — ready to schedule (${(jobs_accepted||[]).length})</h2></div>
      <div class="card" id="acceptedList" style="padding:8px">
        ${(jobs_accepted && jobs_accepted.length)
          ? jobs_accepted.map(wo => pipelineWoRow(wo)).join('')
          : '<div class="empty-state" style="padding:8px 0;font-size:.85em">No accepted quotes waiting to be scheduled.</div>'}
      </div>

      <div class="section-title mt20"><h2>🔧 Jobs in progress (${jobs_in_progress.length})</h2></div>
      <div class="card" id="inProgressList" style="padding:8px">
        ${jobs_in_progress.length
          ? jobs_in_progress.map(wo => pipelineWoRow(wo)).join('')
          : '<div class="empty-state" style="padding:8px 0;font-size:.85em">No jobs currently in progress.</div>'}
      </div>

      <div class="section-title mt20"><h2>✅ Jobs completed (${jobs_completed.length})</h2></div>
      <div class="card" id="completedList" style="padding:8px">
        ${jobs_completed.length
          ? jobs_completed.map(wo => pipelineWoRow(wo)).join('')
          : '<div class="empty-state" style="padding:8px 0;font-size:.85em">No completed jobs yet.</div>'}
      </div>
    `;

    // Quote pipeline stages only (in_progress, quote_accepted and completed have their own sections)
    const QUOTE_STAGES = STAGES.filter(s => !['in_progress', 'quote_accepted', 'completed'].includes(s.key));
    const stagesEl = document.getElementById('pipelineStages');
    QUOTE_STAGES.forEach(st => {
      const bucket = pipeline.find(p => p.key === st.key) || { count: 0, items: [] };
      const sectionEl = document.createElement('div');
      sectionEl.style.marginBottom = '16px';
      sectionEl.innerHTML = `
        <div class="section-title" style="margin-bottom:6px;margin-top:0">
          <h3 style="color:${st.color};font-size:1em;margin:0">
            ${st.emoji} ${st.label}
            <span style="font-weight:400;color:var(--muted);font-size:.9em">(${bucket.count})</span>
          </h3>
          ${st.next ? `<span style="font-size:.78em;color:var(--muted);font-style:italic">Next step: ${st.next}</span>` : ''}
        </div>
        <div class="card stage-bucket" style="padding:8px">
          ${bucket.items.length
            ? bucket.items.map(wo => pipelineWoRow(wo)).join('')
            : `<div class="empty-state" style="padding:8px 0;font-size:.85em">Nothing here right now</div>`}
        </div>
      `;
      stagesEl.appendChild(sectionEl);
    });

    view.querySelectorAll('.pipeline-row[data-wo]').forEach(el =>
      el.addEventListener('click', () => navigate(`/work-orders/${el.dataset.wo}`))
    );
    if (document.getElementById('alertsList')) attachWoClicks(document.getElementById('alertsList'));
  });

    function woListItem(wo) {
    const sla = slaInfo(wo);
    return `<div class="list-item" data-wo="${wo.id}">
      <div>
        <div class="title">${esc(wo.reference)} — ${esc(wo.title)}</div>
        <div class="meta">${esc(wo.client_name || '')}${wo.site_address ? ' · ' + esc(wo.site_address) : ''}${wo.assignee_name ? ' · 👤 ' + esc(wo.assignee_name) : ''}</div>
      </div>
      <div class="text-right">
        <div><span class="badge badge-${wo.status}">${statusLabel(wo.status)}</span></div>
        ${sla ? `<div class="mt8"><span class="sla-chip ${sla.cls}">${sla.label}</span></div>` : ''}
      </div>
    </div>`;
  }
  function attachWoClicks(container) {
    if (!container) return;
    container.querySelectorAll('[data-wo]').forEach(el => el.addEventListener('click', () => navigate(`/work-orders/${el.dataset.wo}`)));
  }

    // ---------- Account / change password ----------
  // Notification categories are shared with the admin-only Settings page,
  // which is where notification preferences now live (per-profile, admin-managed).
  const NOTIF_CATEGORIES = [
    { key: 'assigned_work_order', label: 'A new work order is assigned to them', hint: 'Always logged either way — this just controls whether their phone buzzes.' },
    { key: 'calendar_event_added', label: 'Someone adds an event to their calendar', hint: 'Always logged either way — this just controls whether their phone buzzes.' },
    { key: 'inspection_report_ready', label: 'An inspection report is submitted or updated', hint: 'Relevant for admin/operational — always logged either way.' },
    { key: 'new_portal_request', label: 'A new request comes in from the client portal', hint: 'Relevant for admin/operational — always logged either way.' },
    { key: 'daily_checkin', label: 'Daily "check your schedule" reminder', hint: 'A once-a-day nudge at the time chosen below. Turning this off stops it completely.' },
    { key: 'event_reminder', label: '1 hour before a calendar event starts', hint: 'Turning this off stops it completely — there is nothing useful to log after the moment has passed.' }
  ];

  route('/account', async () => {
    const forced = location.hash.includes('force=1');
    const view = document.getElementById('view');
    view.innerHTML = `
      <div class="card" style="max-width:480px">
        <h2>My Account</h2>
        ${forced ? `<div class="error-box" style="background:var(--warning-light);color:var(--warning);padding:10px;border-radius:8px;margin-bottom:12px">You're using a temporary password. Please set a new one to continue.</div>` : ''}
        <p class="muted">${esc(state.user.name)} · ${esc(state.user.email)}</p>
        <form id="pwForm">
          <div class="field"><label>Current password</label><input type="password" name="current_password" required></div>
          <div class="field"><label>New password (min 8 characters)</label><input type="password" name="new_password" required minlength="8"></div>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
        <hr class="sep">
        <button class="btn" id="logoutBtn">Log out</button>
        ${state.user.role !== 'admin' ? `<p class="muted mt12" style="font-size:.8em">Notification preferences are managed by your admin under Settings.</p>` : ''}
      </div>
    `;
    document.getElementById('pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/api/auth/change-password', { current_password: fd.get('current_password'), new_password: fd.get('new_password') });
        toast('Password updated', 'success');
        state.user.must_change_password = false;
        navigate('/dashboard');
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('logoutBtn').addEventListener('click', logout);
  });

  window.addEventListener('hashchange', render);
  window.addEventListener('DOMContentLoaded', async () => {
    await tryRestoreSession();
    render();
  });

  return { state, route, navigate, backTarget, render, toast, esc, initials, fmtDate, fmtDateTime, statusLabel, slaInfo, openModal, closeModal, logout, loadNotifications, NOTIF_CATEGORIES, onLogout };
})();
