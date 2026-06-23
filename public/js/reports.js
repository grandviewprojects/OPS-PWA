// public/js/reports.js
(() => {
  const { route, toast, esc, fmtDateTime } = App;

  let chartJsLoaded = false;
  function ensureChartJs() {
    return new Promise((resolve, reject) => {
      if (chartJsLoaded || window.Chart) { chartJsLoaded = true; return resolve(); }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
      script.onload = () => { chartJsLoaded = true; resolve(); };
      script.onerror = () => reject(new Error('Could not load the charting library — check your internet connection.'));
      document.head.appendChild(script);
    });
  }

  const METRIC_COLORS = {
    created: '#6b7280',
    completed: '#15803d',
    quotes_sent: '#1d4ed8',
    cancelled: '#b91c1c',
    avg_time_to_quote_hours: '#d97706',
    sla_breaches: '#dc2626'
  };
  const ALL_METRICS = ['created', 'completed', 'quotes_sent', 'cancelled', 'avg_time_to_quote_hours', 'sla_breaches'];
  const DEFAULT_METRICS = ['quotes_sent', 'avg_time_to_quote_hours', 'sla_breaches'];

  let chartInstance = null;

  route('/reports', async () => {
    const view = document.getElementById('view');
    view.innerHTML = `<div class="card"><div class="flex"><div class="spinner"></div> Loading…</div></div>`;

    const [teamRes, savedRes] = await Promise.all([
      API.get('/api/users'),
      API.get('/api/reports/saved')
    ]);
    const onsiteUsers = teamRes.users.filter((u) => u.role === 'onsite' && u.active !== 0);
    let savedReports = savedRes.saved_reports;

    const today = new Date();
    const state = {
      granularity: 'week',
      rangePreset: '12w',
      from: new Date(today.getTime() - 12 * 7 * 24 * 60 * 60 * 1000),
      to: today,
      metrics: [...DEFAULT_METRICS],
      assignee: '',
      compare: true
    };

    function applyPreset(preset) {
      state.rangePreset = preset;
      const now = new Date();
      if (preset === '8w') { state.granularity = 'week'; state.from = new Date(now.getTime() - 8 * 7 * 86400000); }
      else if (preset === '12w') { state.granularity = 'week'; state.from = new Date(now.getTime() - 12 * 7 * 86400000); }
      else if (preset === '6m') { state.granularity = 'month'; state.from = new Date(now.getFullYear(), now.getMonth() - 6, 1); }
      else if (preset === '12m') { state.granularity = 'month'; state.from = new Date(now.getFullYear(), now.getMonth() - 12, 1); }
      state.to = now;
    }

    view.innerHTML = `
      <div class="section-title"><h2>Reports</h2></div>

      <div class="card">
        <h3>Customize this report</h3>
        <div class="form-row">
          <div class="field"><label>Quick range</label>
            <select id="rangePreset">
              <option value="8w">Last 8 weeks</option>
              <option value="12w" selected>Last 12 weeks</option>
              <option value="6m">Last 6 months</option>
              <option value="12m">Last 12 months</option>
              <option value="custom">Custom range</option>
            </select>
          </div>
          <div class="field"><label>Granularity</label>
            <select id="granularitySelect">
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
          </div>
          <div class="field"><label>Onsite team member</label>
            <select id="assigneeSelect">
              <option value="">All team members</option>
              ${onsiteUsers.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row" id="customRangeRow" style="display:none">
          <div class="field"><label>From</label><input type="date" id="fromDate"></div>
          <div class="field"><label>To</label><input type="date" id="toDate"></div>
        </div>
        <div class="field">
          <label>Metrics to show on the graph</label>
          <div class="flex" style="flex-wrap:wrap;gap:14px;margin-top:4px">
            ${ALL_METRICS.map((m) => `
              <label style="display:flex;align-items:center;gap:6px;font-size:.85em;font-weight:400;color:var(--ink)">
                <input type="checkbox" data-metric-toggle value="${m}" ${DEFAULT_METRICS.includes(m) ? 'checked' : ''}>
                <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${METRIC_COLORS[m]}"></span>
                ${metricLabel(m)}
              </label>
            `).join('')}
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:.85em;font-weight:400;color:var(--ink);margin-top:10px">
          <input type="checkbox" id="compareToggle" checked> Compare to the previous equivalent period
        </label>
        <div class="flex mt12" style="flex-wrap:wrap;gap:10px">
          <button class="btn btn-primary" id="runReportBtn">Update report</button>
          <button class="btn btn-sm" id="saveReportBtn">💾 Save this report</button>
          <button class="btn btn-sm" id="exportCsvBtn">⬇ Export CSV</button>
          <button class="btn btn-sm" id="exportPdfBtn">⬇ Export PDF</button>
        </div>
      </div>

      <div id="savedReportsCard"></div>

      <div id="compareCard"></div>

      <div class="card">
        <h3>Trend</h3>
        <canvas id="trendChart" height="90"></canvas>
      </div>

      <div id="ttqCard"></div>
    `;

    function renderSavedReports() {
      const card = document.getElementById('savedReportsCard');
      if (!savedReports.length) { card.innerHTML = ''; return; }
      card.innerHTML = `
        <div class="card">
          <h3>Saved reports</h3>
          ${savedReports.map((r) => `
            <div class="list-item" data-saved="${r.id}">
              <div><div class="title">${esc(r.name)}</div><div class="meta">Saved ${fmtDateTime(r.updated_at)}</div></div>
              <button class="btn btn-sm btn-danger" data-delete-saved="${r.id}" type="button">Delete</button>
            </div>
          `).join('')}
        </div>
      `;
      card.querySelectorAll('[data-saved]').forEach((el) => el.addEventListener('click', (e) => {
        if (e.target.closest('[data-delete-saved]')) return;
        const saved = savedReports.find((r) => r.id === el.dataset.saved);
        if (saved) loadConfig(JSON.parse(saved.config_json));
      }));
      card.querySelectorAll('[data-delete-saved]').forEach((btn) => btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await API.del(`/api/reports/saved/${btn.dataset.deleteSaved}`);
          savedReports = savedReports.filter((r) => r.id !== btn.dataset.deleteSaved);
          renderSavedReports();
          toast('Saved report deleted', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }));
    }
    renderSavedReports();

    function loadConfig(cfg) {
      state.rangePreset = cfg.rangePreset || 'custom';
      state.granularity = cfg.granularity || 'week';
      state.metrics = cfg.metrics && cfg.metrics.length ? cfg.metrics : [...DEFAULT_METRICS];
      state.assignee = cfg.assignee || '';
      state.compare = cfg.compare !== false;
      if (cfg.rangePreset && cfg.rangePreset !== 'custom') {
        applyPreset(cfg.rangePreset);
      } else {
        state.from = new Date(cfg.from);
        state.to = new Date(cfg.to);
      }
      syncControlsFromState();
      runReport();
    }

    function syncControlsFromState() {
      document.getElementById('rangePreset').value = state.rangePreset;
      document.getElementById('granularitySelect').value = state.granularity;
      document.getElementById('assigneeSelect').value = state.assignee;
      document.getElementById('compareToggle').checked = state.compare;
      document.querySelectorAll('[data-metric-toggle]').forEach((cb) => { cb.checked = state.metrics.includes(cb.value); });
      const customRow = document.getElementById('customRangeRow');
      if (state.rangePreset === 'custom') {
        customRow.style.display = '';
        document.getElementById('fromDate').value = state.from.toISOString().slice(0, 10);
        document.getElementById('toDate').value = state.to.toISOString().slice(0, 10);
      } else {
        customRow.style.display = 'none';
      }
    }

    document.getElementById('rangePreset').addEventListener('change', (e) => {
      state.rangePreset = e.target.value;
      document.getElementById('customRangeRow').style.display = state.rangePreset === 'custom' ? '' : 'none';
      if (state.rangePreset !== 'custom') {
        applyPreset(state.rangePreset);
        document.getElementById('granularitySelect').value = state.granularity;
      }
    });
    document.getElementById('granularitySelect').addEventListener('change', (e) => { state.granularity = e.target.value; });
    document.getElementById('assigneeSelect').addEventListener('change', (e) => { state.assignee = e.target.value; });
    document.getElementById('compareToggle').addEventListener('change', (e) => { state.compare = e.target.checked; });
    document.querySelectorAll('[data-metric-toggle]').forEach((cb) => cb.addEventListener('change', () => {
      state.metrics = Array.from(document.querySelectorAll('[data-metric-toggle]:checked')).map((c) => c.value);
    }));
    document.getElementById('runReportBtn').addEventListener('click', runReport);

    document.getElementById('saveReportBtn').addEventListener('click', () => {
      App.openModal('Save This Report', `
        <form id="saveReportForm">
          <div class="field"><label>Report name</label><input name="name" required placeholder="e.g. Monthly quote turnaround"></div>
          <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
        </form>
      `, (body) => {
        body.querySelector('[data-close-modal]').addEventListener('click', App.closeModal);
        body.querySelector('#saveReportForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const name = new FormData(e.target).get('name');
          const config = collectConfig();
          try {
            const res = await API.post('/api/reports/saved', { name, config });
            savedReports.unshift(res.saved_report);
            renderSavedReports();
            App.closeModal();
            toast('Report saved', 'success');
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    });

    function collectConfig() {
      return {
        rangePreset: state.rangePreset,
        granularity: state.granularity,
        metrics: state.metrics,
        assignee: state.assignee,
        compare: state.compare,
        from: state.from.toISOString(),
        to: state.to.toISOString()
      };
    }

    function buildQuery(extra) {
      if (state.rangePreset === 'custom') {
        state.from = new Date(document.getElementById('fromDate').value);
        state.to = new Date(document.getElementById('toDate').value + 'T23:59:59');
      }
      const params = new URLSearchParams({
        from: state.from.toISOString(),
        to: state.to.toISOString(),
        granularity: state.granularity,
        ...(state.assignee ? { assignee: state.assignee } : {}),
        ...extra
      });
      return params.toString();
    }

    document.getElementById('exportCsvBtn').addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/reports/export.csv?${buildQuery()}`, { headers: { Authorization: 'Bearer ' + API.token() } });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'report.csv';
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('exportPdfBtn').addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/reports/pdf?${buildQuery()}`, { headers: { Authorization: 'Bearer ' + API.token() } });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'operations-report.pdf';
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch (err) { toast(err.message, 'error'); }
    });

    function metricLabel(m) {
      return ({
        created: 'New work orders', completed: 'Completed', quotes_sent: 'Quotes sent',
        cancelled: 'Cancelled', avg_time_to_quote_hours: 'Avg. time to quote (hrs)', sla_breaches: 'Late quotes (missed SLA)'
      })[m] || m;
    }

    function renderCompareCard(data) {
      const card = document.getElementById('compareCard');
      if (!state.compare) { card.innerHTML = ''; return; }
      const fmtChange = (m) => {
        const v = data.change[m];
        if (v === null || v === undefined) return '<span class="muted">—</span>';
        const goodDirection = (m === 'avg_time_to_quote_hours' || m === 'sla_breaches' || m === 'cancelled') ? v < 0 : v > 0;
        const color = v === 0 ? 'var(--muted)' : (goodDirection ? 'var(--success)' : 'var(--danger)');
        const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '–';
        return `<span style="color:${color};font-weight:600">${arrow} ${Math.abs(v)}%</span>`;
      };
      card.innerHTML = `
        <div class="card">
          <h3>This period vs. previous period</h3>
          <div class="grid grid-3">
            ${ALL_METRICS.map((m) => `
              <div class="card stat-card">
                <div class="num">${data.current[m] === null ? '—' : data.current[m]}</div>
                <div class="label">${metricLabel(m)}</div>
                <div class="mt8">${fmtChange(m)} <span class="muted" style="font-size:.8em">vs ${data.previous[m] === null ? '—' : data.previous[m]}</span></div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    async function renderChart(query) {
      await ensureChartJs();
      const res = await API.get(`/api/reports/timeseries?${query}&metrics=${state.metrics.join(',')}`);
      const canvas = document.getElementById('trendChart');
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

      const countMetrics = state.metrics.filter((m) => m !== 'avg_time_to_quote_hours');
      const hasTimeMetric = state.metrics.includes('avg_time_to_quote_hours');

      const datasets = state.metrics.map((m) => ({
        label: metricLabel(m),
        data: res.series[m],
        backgroundColor: METRIC_COLORS[m],
        borderColor: METRIC_COLORS[m],
        type: m === 'avg_time_to_quote_hours' ? 'line' : 'bar',
        yAxisID: m === 'avg_time_to_quote_hours' ? 'y1' : 'y',
        tension: 0.3,
        order: m === 'avg_time_to_quote_hours' ? 0 : 1
      }));

      chartInstance = new Chart(canvas, {
        data: { labels: res.labels, datasets },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: { beginAtZero: true, position: 'left', title: { display: countMetrics.length > 0, text: 'Count' } },
            y1: { beginAtZero: true, position: 'right', display: hasTimeMetric, grid: { drawOnChartArea: false }, title: { display: true, text: 'Hours' } }
          }
        }
      });
    }

    async function renderTimeToQuote(query) {
      const card = document.getElementById('ttqCard');
      const res = await API.get(`/api/reports/time-to-quote?${query}`);
      const s = res.summary;
      card.innerHTML = `
        <div class="card">
          <h3>Time to quote — detail</h3>
          ${s.count === 0 ? '<div class="empty-state">No quotes were sent in this period.</div>' : `
            <div class="grid grid-4">
              <div class="card stat-card"><div class="num">${s.avg}h</div><div class="label">Average</div></div>
              <div class="card stat-card"><div class="num">${s.median}h</div><div class="label">Median</div></div>
              <div class="card stat-card"><div class="num">${s.min}h</div><div class="label">Fastest</div></div>
              <div class="card stat-card" style="${s.max > 72 ? 'border-color:var(--danger);background:var(--danger-light)' : ''}"><div class="num" style="${s.max > 72 ? 'color:var(--danger)' : ''}">${s.max}h</div><div class="label">Slowest</div></div>
            </div>
            <h3 class="mt16">Slowest quotes this period</h3>
            <div class="card" style="margin-bottom:0">
              ${res.slowest.map((w) => `
                <div class="list-item" style="cursor:default">
                  <div><div class="title">${esc(w.reference)} — ${esc(w.title)}</div><div class="meta">${esc(w.client_name || '')}${w.assignee_name ? ' · ' + esc(w.assignee_name) : ''}</div></div>
                  <span class="badge ${w.breached_sla ? 'badge-cancelled' : 'badge-completed'}">${w.hours}h${w.breached_sla ? ' · SLA missed' : ''}</span>
                </div>
              `).join('') || '<div class="empty-state">Nothing to show.</div>'}
            </div>
          `}
        </div>
      `;
    }

    async function runReport() {
      const query = buildQuery();
      try {
        const compareData = state.compare ? await API.get(`/api/reports/compare?${query}`) : null;
        await Promise.all([renderChart(query), renderTimeToQuote(query)]);
        if (state.compare && compareData) renderCompareCard(compareData);
        else document.getElementById('compareCard').innerHTML = '';
      } catch (err) { toast(err.message, 'error'); }
    }

    runReport();
  });
})();
