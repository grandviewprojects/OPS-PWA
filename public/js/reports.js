// public/js/reports.js
(() => {
  const { route, openModal, closeModal, toast, esc, fmtDateTime } = App;

  route('/reports', async () => {
    const view = document.getElementById('view');
    view.innerHTML = `<div class="card"><div class="flex"><div class="spinner"></div> Loading…</div></div>`;

    let aiStatus = { configured: false };
    try { aiStatus = await API.get('/api/ai/status'); } catch (e) {}

    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const toInput = today.toISOString().slice(0, 10);
    const fromInput = weekAgo.toISOString().slice(0, 10);

    view.innerHTML = `
      <div class="section-title"><h2>Reports</h2></div>

      ${!aiStatus.configured ? `
        <div class="card" style="background:var(--warning-light);border-color:var(--warning)">
          <strong>AI summaries aren't set up yet.</strong>
          <p class="muted" style="margin-bottom:0">Ask whoever manages your hosting to add an <code>ANTHROPIC_API_KEY</code> to enable AI-written weekly summaries. The stats below still work without it.</p>
        </div>` : ''}

      <div class="card">
        <h3>Generate a management summary</h3>
        <div class="form-row">
          <div class="field"><label>From</label><input type="date" id="fromDate" value="${fromInput}"></div>
          <div class="field"><label>To</label><input type="date" id="toDate" value="${toInput}"></div>
        </div>
        <button class="btn btn-primary mt8" id="generateBtn">${aiStatus.configured ? '✨ Generate AI summary' : 'Generate (stats only — AI not configured)'}</button>
      </div>

      <div id="resultCard"></div>

      <div class="section-title mt20"><h2>Past reports</h2></div>
      <div class="card" id="historyList"><div class="empty-state">Loading…</div></div>
    `;

    async function loadHistory() {
      const list = document.getElementById('historyList');
      try {
        const { reports } = await API.get('/api/ai/reports');
        list.innerHTML = reports.length ? reports.map(r => `
          <div class="list-item" data-report="${r.id}">
            <div><div class="title">Weekly Summary</div><div class="meta">${r.period_start.slice(0,10)} to ${r.period_end.slice(0,10)} · generated ${fmtDateTime(r.created_at)}</div></div>
            <div class="muted">View →</div>
          </div>
        `).join('') : `<div class="empty-state">No reports generated yet.</div>`;
        list.querySelectorAll('[data-report]').forEach(el => el.addEventListener('click', () => openReport(el.dataset.report)));
      } catch (e) { list.innerHTML = `<div class="empty-state">Could not load report history.</div>`; }
    }

    function renderReport(report) {
      const s = report.stats || {};
      document.getElementById('resultCard').innerHTML = `
        <div class="card">
          <div class="flex-between">
            <h3>Weekly Summary — ${report.period_start.slice(0,10)} to ${report.period_end.slice(0,10)}</h3>
            <button class="btn btn-sm" id="dlReportPdf">⬇ Download PDF</button>
          </div>
          <div class="grid grid-4 mt12">
            <div class="card stat-card"><div class="num">${s.createdCount ?? '—'}</div><div class="label">New Work Orders</div></div>
            <div class="card stat-card"><div class="num">${s.completedCount ?? '—'}</div><div class="label">Completed</div></div>
            <div class="card stat-card"><div class="num">${s.quotesSentCount ?? '—'}</div><div class="label">Quotes Sent</div></div>
            <div class="card stat-card" style="${(s.overdue||[]).length ? 'border-color:var(--danger);background:var(--danger-light)' : ''}">
              <div class="num" style="${(s.overdue||[]).length ? 'color:var(--danger)' : ''}">${(s.overdue||[]).length}</div><div class="label">Overdue Quotes (now)</div>
            </div>
          </div>
          ${report.content ? `<hr class="sep"><div style="white-space:pre-wrap;line-height:1.6">${esc(report.content)}</div>` : `<p class="muted mt12">AI summary unavailable for this report — showing stats only.</p>`}
        </div>
      `;
      const dlBtn = document.getElementById('dlReportPdf');
      if (dlBtn && report.id) dlBtn.addEventListener('click', async () => {
        try {
          const res = await fetch(`/api/ai/reports/${report.id}/pdf`, { headers: { Authorization: 'Bearer ' + API.token() } });
          if (!res.ok) throw new Error('Could not download PDF');
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `Weekly-Summary-${report.period_start.slice(0,10)}.pdf`;
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(url);
        } catch (e) { toast(e.message, 'error'); }
      });
    }

    async function openReport(reportId) {
      try {
        const { report } = await API.get(`/api/ai/reports/${reportId}`);
        renderReport(report);
        window.scrollTo({ top: document.getElementById('resultCard').offsetTop - 80, behavior: 'smooth' });
      } catch (e) { toast(e.message, 'error'); }
    }

    document.getElementById('generateBtn').addEventListener('click', async () => {
      const from = document.getElementById('fromDate').value;
      const to = document.getElementById('toDate').value;
      if (!from || !to) return toast('Pick a date range first', 'error');
      const btn = document.getElementById('generateBtn');
      btn.disabled = true; btn.textContent = 'Generating…';
      document.getElementById('resultCard').innerHTML = `<div class="card"><div class="flex"><div class="spinner"></div> Pulling your data together…</div></div>`;
      try {
        const res = await API.post('/api/ai/weekly-summary', { from: new Date(from).toISOString(), to: new Date(to + 'T23:59:59').toISOString() });
        renderReport(res.report);
        loadHistory();
      } catch (e) {
        // Even on AI failure, the server may have included raw stats — show what we can.
        renderReport({ period_start: new Date(from).toISOString(), period_end: new Date(to).toISOString(), content: null, stats: (e.data && e.data.stats) || {} });
        toast(e.message, 'error');
      }
      btn.disabled = false; btn.textContent = aiStatus.configured ? '✨ Generate AI summary' : 'Generate (stats only — AI not configured)';
    });

    loadHistory();
  });
})();
