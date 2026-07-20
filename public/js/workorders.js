// public/js/workorders.js
(() => {
  const { route, navigate, openModal, closeModal, toast, esc, fmtDate, fmtDateTime, statusLabel, slaInfo } = App;

  const STATUS_FLOW = ['new', 'assigned', 'in_progress', 'inspection_submitted', 'quote_sent', 'quote_accepted', 'completed'];

  function genId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---------------- List ----------------
  route('/work-orders', async () => {
    const u = App.state.user;
    const view = document.getElementById('view');
    const isStaff = u.role === 'admin' || u.role === 'operational';

    view.innerHTML = `
      <div class="section-title">
        <h2>Work Orders</h2>
        <div class="flex">
          <select id="statusFilter" class="field" style="width:auto">
            <option value="">All statuses</option>
            ${STATUS_FLOW.concat(['cancelled']).map(s => `<option value="${s}">${statusLabel(s)}</option>`).join('')}
          </select>
          ${isStaff ? `<button class="btn btn-primary" id="newWoBtn">+ New work order</button>` : ''}
        </div>
      </div>
      <div class="card" id="woList"><div class="flex"><div class="spinner"></div> Loading…</div></div>
      ${isStaff ? `<p class="muted">💡 Share your external request portal with clients: <code>${location.origin}/portal</code></p>` : ''}
    `;

    async function load() {
      const status = document.getElementById('statusFilter').value;
      const data = await API.get('/api/work-orders' + (status ? `?status=${status}` : ''));
      const list = document.getElementById('woList');
      list.innerHTML = data.work_orders.length ? data.work_orders.map(wo => woRow(wo)).join('') : `<div class="empty-state">No work orders found.</div>`;
      list.querySelectorAll('[data-wo]').forEach(el => el.addEventListener('click', () => navigate(`/work-orders/${el.dataset.wo}`)));
    }
    function woRow(wo) {
      const sla = slaInfo(wo);
      return `<div class="list-item" data-wo="${wo.id}">
        <div>
          <div class="title">${esc(wo.reference)} — ${esc(wo.title)}</div>
          <div class="meta">${esc(wo.client_name || '')}${wo.assignee_name ? ' · 👤 ' + esc(wo.assignee_name) : ' · Unassigned'} · ${fmtDate(wo.created_at)}</div>
        </div>
        <div class="text-right">
          <span class="badge badge-${wo.priority}">${wo.priority}</span>
          <span class="badge badge-${wo.status}">${statusLabel(wo.status)}</span>
          ${sla ? `<div class="mt8"><span class="sla-chip ${sla.cls}">${sla.label}</span></div>` : ''}
        </div>
      </div>`;
    }

    document.getElementById('statusFilter').addEventListener('change', load);
    if (isStaff) document.getElementById('newWoBtn').addEventListener('click', () => openNewWorkOrderForm(load));
    await load();
  });

  async function openNewWorkOrderForm(onDone) {
    const teamUsers = (await API.get('/api/users')).users.filter(x => x.role === 'onsite' && x.active !== 0);
    openModal('New Work Order', `
      <form id="woForm">
        <div class="field"><label>Title</label><input name="title" required></div>
        <div class="field"><label>Description</label><textarea name="description"></textarea></div>
        <div class="form-row">
          <div class="field"><label>Client name</label><input name="client_name"></div>
          <div class="field"><label>Priority</label><select name="priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Client email</label><input type="email" name="client_email"></div>
          <div class="field"><label>Client phone</label><input name="client_phone"></div>
        </div>
        <div class="field"><label>Site address</label><input name="site_address"></div>
        <div class="form-row">
          <div class="field"><label>Assign to</label><select name="assigned_to"><option value="">Unassigned</option>${teamUsers.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Scheduled date/time</label><input type="datetime-local" name="scheduled_at"></div>
        </div>
        <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Create work order</button></div>
      </form>
    `, (body) => {
      body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
      body.querySelector('#woForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = Object.fromEntries(fd.entries());
        if (payload.scheduled_at) payload.scheduled_at = new Date(payload.scheduled_at).toISOString();
        else delete payload.scheduled_at;
        if (!payload.assigned_to) delete payload.assigned_to;
        try {
          const res = await API.post('/api/work-orders', payload);
          closeModal(); toast('Work order created', 'success');
          if (onDone) onDone(); else navigate(`/work-orders/${res.work_order.id}`);
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ---------------- Detail ----------------
  route('/work-orders/:id', async ({ id }) => {
    const u = App.state.user;
    const isStaff = u.role === 'admin' || u.role === 'operational';
    const view = document.getElementById('view');
    const data = await API.get(`/api/work-orders/${id}`);
    const wo = data.work_order;
    const sla = slaInfo(wo);

    let teamUsers = [];
    if (isStaff) teamUsers = (await API.get('/api/users')).users.filter(x => x.role === 'onsite' && x.active !== 0);

    const isAdmin = u.role === 'admin';
    const back = App.backTarget('/work-orders');
    const backLabel = back === '/dashboard' ? '&larr; Back to dashboard' : '&larr; Back to work orders';
    view.innerHTML = `
      <a href="#${back}" class="muted">${backLabel}</a>
      <div class="section-title mt12">
        <h2>${esc(wo.reference)} — ${esc(wo.title)}</h2>
        <div class="flex">
          <span class="badge badge-${wo.priority}">${wo.priority}</span>
          <span class="badge badge-${wo.status}">${statusLabel(wo.status)}</span>
          ${isAdmin ? `<button class="btn btn-sm btn-danger" id="deleteWoBtn">🗑 Delete</button>` : ''}
        </div>
      </div>
      ${sla ? `<div class="card" style="border-color:${sla.cls === 'sla-overdue' ? 'var(--danger)' : 'var(--border)'}"><span class="sla-chip ${sla.cls}">${sla.label}</span> <span class="muted">— quote SLA started when the inspection report was finalized.</span></div>` : ''}

      <div class="grid grid-2">
        <div class="card">
          <h3>Details</h3>
          <table class="simple">
            <tr><th>Client</th><td>${esc(wo.client_name || '—')}</td></tr>
            <tr><th>Site address</th><td>${esc(wo.site_address || '—')}</td></tr>
            <tr><th>Client email</th><td>${esc(wo.client_email || '—')}</td></tr>
            <tr><th>Client phone</th><td>${esc(wo.client_phone || '—')}</td></tr>
            <tr><th>Created via</th><td>${wo.created_via === 'portal' ? '🌐 External portal' : 'Internal'}</td></tr>
            <tr><th>Scheduled</th><td>${wo.scheduled_at ? fmtDateTime(wo.scheduled_at) : '—'}</td></tr>
          </table>
          ${wo.description ? `<hr class="sep"><p>${esc(wo.description)}</p>` : ''}
          ${isStaff ? `<button class="btn btn-sm mt8" id="editWoBtn">Edit details</button>` : ''}
        </div>

        <div class="card">
          <h3>Assignment &amp; Status</h3>
          <p><strong>Assigned to:</strong> ${wo.assignee_name ? esc(wo.assignee_name) : '<span class="muted">Unassigned</span>'}</p>
          ${isStaff ? `
            ${teamUsers.length === 0 ? `<p class="muted" style="font-size:.85em">No onsite team members yet — <a href="#/team">create one in Team</a> first, then come back to assign this job.</p>` : ''}
            <div class="field">
              <label class="flex-between" style="margin-bottom:5px">Reassign <button class="btn btn-sm" id="suggestAssigneeBtn" type="button" style="padding:3px 8px;font-size:.75em">✨ Suggest</button></label>
              <select id="assignSelect"><option value="">Unassigned</option>${teamUsers.map(t => `<option value="${t.id}" ${t.id === wo.assigned_to ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
            </div>
            <div id="suggestionPanel"></div>
            <div class="field"><label>Scheduled date/time</label><input type="datetime-local" id="scheduledInput" value="${wo.scheduled_at ? wo.scheduled_at.slice(0,16) : ''}"></div>
            <p class="muted" style="font-size:.78em">Reassigning or changing the date saves instantly — calendar syncs automatically.</p>
          ` : ''}
          <hr class="sep">
          <div class="field"><label>Update status</label>
            <select id="statusSelect">
              ${(isStaff ? STATUS_FLOW.concat(['cancelled']) : ['in_progress']).map(s => `<option value="${s}" ${s === wo.status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
            </select>
          </div>
          <p class="muted" style="font-size:.78em">Status updates instantly when you pick a new one — no extra click needed.</p>
        </div>
      </div>

      <div class="card" id="inspectionCard"></div>

      <div class="card" id="jobCardCard"></div>

      <div class="card" id="quotesCard"></div>

      <div class="card">
        <h3>Notes &amp; Activity</h3>
        ${isStaff || wo.assigned_to === u.id ? `
        <div class="field" style="margin-bottom:8px">
          <textarea id="noteInput" placeholder="Add a note or comment…" rows="2" style="width:100%"></textarea>
          <button class="btn btn-sm btn-primary mt8" id="addNoteBtn">Add note</button>
        </div>` : ''}
        <div id="activityList">${data.activity.map(a => `<div class="list-item" style="cursor:default"><div><div>${esc(a.message)}</div><div class="meta">${fmtDateTime(a.created_at)}</div></div></div>`).join('') || '<div class="empty-state">No activity yet.</div>'}</div>
      </div>
    `;

    renderInspectionCard(document.getElementById('inspectionCard'), wo, data.inspection_report, isStaff);
    renderJobCard(document.getElementById('jobCardCard'), wo, data.job_card, isStaff);
    renderQuotesCard(document.getElementById('quotesCard'), wo, isStaff, isAdmin);

    // Add-note handler
    const addNoteBtn = document.getElementById('addNoteBtn');
    if (addNoteBtn) addNoteBtn.addEventListener('click', async () => {
      const input = document.getElementById('noteInput');
      const message = input.value.trim();
      if (!message) return;
      addNoteBtn.disabled = true;
      try {
        const res = await API.post(`/api/work-orders/${id}/notes`, { message });
        input.value = '';
        const list = document.getElementById('activityList');
        list.innerHTML = res.activity.map(a => `<div class="list-item" style="cursor:default"><div><div>${esc(a.message)}</div><div class="meta">${fmtDateTime(a.created_at)}</div></div></div>`).join('');
        toast('Note added', 'success');
      } catch (e) { toast(e.message, 'error'); }
      addNoteBtn.disabled = false;
    });

    if (isAdmin) {
      document.getElementById('deleteWoBtn').addEventListener('click', () => {
        openModal('Delete Work Order', `
          <p>Are you sure you want to permanently delete <strong>${esc(wo.reference)} — ${esc(wo.title)}</strong>?</p>
          <p class="muted">This deletes the work order, its calendar entries, its inspection report, and all uploaded photos and PDFs. <strong>This cannot be undone.</strong></p>
          <div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-danger" id="confirmDeleteWo">Delete permanently</button></div>
        `, (body) => {
          body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
          body.querySelector('#confirmDeleteWo').addEventListener('click', async () => {
            try {
              await API.del(`/api/work-orders/${id}`);
              closeModal();
              toast('Work order deleted', 'success');
              navigate('/work-orders');
            } catch (err) { toast(err.message, 'error'); }
          });
        });
      });
    }
    if (isStaff) {
      document.getElementById('editWoBtn').addEventListener('click', () => openEditWorkOrderForm(wo));

      async function saveAssignment() {
        const assigned_to = document.getElementById('assignSelect').value || null;
        const schedRaw = document.getElementById('scheduledInput').value;
        try {
          await API.put(`/api/work-orders/${id}`, { assigned_to, scheduled_at: schedRaw ? new Date(schedRaw).toISOString() : null });
          toast('Assignment updated — calendar synced', 'success'); App.render();
        } catch (e) { toast(e.message, 'error'); }
      }
      document.getElementById('assignSelect').addEventListener('change', saveAssignment);
      document.getElementById('scheduledInput').addEventListener('change', saveAssignment);
      const suggestBtn = document.getElementById('suggestAssigneeBtn');
      if (suggestBtn) suggestBtn.addEventListener('click', async () => {
        const panel = document.getElementById('suggestionPanel');
        panel.innerHTML = `<p class="muted" style="font-size:.85em"><span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle"></span> Thinking…</p>`;
        try {
          const res = await API.post('/api/ai/suggest-assignee', { work_order_id: id });
          const sug = res.suggestion;
          panel.innerHTML = `<div class="privacy-note" style="background:var(--brand-light);margin-bottom:10px">
            <strong>✨ AI suggests: ${esc(sug.name)}</strong><br>
            <span class="muted">${esc(sug.reasoning)}</span><br>
            <button class="btn btn-sm btn-primary mt8" id="useSuggestionBtn">Use this suggestion</button>
          </div>`;
          document.getElementById('useSuggestionBtn').addEventListener('click', () => {
            const sel = document.getElementById('assignSelect');
            sel.value = sug.user_id;
            sel.dispatchEvent(new Event('change')); // trigger auto-save
            panel.innerHTML = '';
          });
        } catch (e) {
          panel.innerHTML = `<p class="muted" style="font-size:.82em">${esc(e.message)}</p>`;
        }
      });
    }
    document.getElementById('statusSelect').addEventListener('change', async (e) => {
      const status = e.target.value;
      try {
        await API.put(`/api/work-orders/${id}`, { status });
        toast('Status updated to ' + statusLabel(status), 'success');
        App.render();
      } catch (err) {
        toast(err.message, 'error');
        e.target.value = wo.status; // revert the dropdown if the update failed
      }
    });
  });

  function openEditWorkOrderForm(wo) {
    openModal('Edit Work Order', `
      <form id="editForm">
        <div class="field"><label>Title</label><input name="title" value="${esc(wo.title)}" required></div>
        <div class="field"><label>Description</label><textarea name="description">${esc(wo.description || '')}</textarea></div>
        <div class="form-row">
          <div class="field"><label>Client name</label><input name="client_name" value="${esc(wo.client_name || '')}"></div>
          <div class="field"><label>Priority</label><select name="priority">${['low','medium','high','urgent'].map(p => `<option value="${p}" ${p===wo.priority?'selected':''}>${p}</option>`).join('')}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Client email</label><input type="email" name="client_email" value="${esc(wo.client_email || '')}"></div>
          <div class="field"><label>Client phone</label><input name="client_phone" value="${esc(wo.client_phone || '')}"></div>
        </div>
        <div class="field"><label>Site address</label><input name="site_address" value="${esc(wo.site_address || '')}"></div>
        <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
    `, (body) => {
      body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
      body.querySelector('#editForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(e.target).entries());
        try { await API.put(`/api/work-orders/${wo.id}`, payload); closeModal(); toast('Saved', 'success'); App.render(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ---------------- Job card on work order page (operations -> onsite, the mirror of the inspection report) ----------------
  // ---------------- Quotes card on work order page ----------------
  const QUOTE_STATUS_LABEL = {
    draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved',
    rejected: 'Needs changes', sent: 'Sent', accepted: 'Accepted'
  };
  const money = (v) => 'R' + (Number(v) || 0).toFixed(2);

  async function renderQuotesCard(el, wo, isStaff, isAdmin) {
    if (!el) return;
    let quotes = [];
    try { quotes = (await API.get(`/api/work-orders/${wo.id}/quotes`)).quotes; } catch (e) {}

    el.innerHTML = `
      <div class="flex-between">
        <h3>Quotes</h3>
        ${isStaff ? `<button class="btn btn-primary btn-sm" id="newQuoteBtn">+ Create quote</button>` : ''}
      </div>
      ${quotes.length ? `<div id="quoteList">${quotes.map(q => `
        <div class="list-item quote-row" data-quote="${q.id}" style="cursor:pointer">
          <div><div class="title">${esc(q.reference || 'Quote')}${q.title ? ' — ' + esc(q.title) : ''}</div>
          <div class="meta">${money(q.total)} incl. VAT</div></div>
          <span class="badge badge-${q.status === 'approved' || q.status === 'accepted' ? 'completed' : q.status === 'rejected' ? 'cancelled' : q.status === 'pending_approval' ? 'in_progress' : 'new'}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span>
        </div>`).join('')}</div>` : '<p class="muted">No quotes yet for this work order.</p>'}
    `;

    const newBtn = document.getElementById('newQuoteBtn');
    if (newBtn) newBtn.addEventListener('click', () => openQuoteEditor(wo, null, isAdmin));
    el.querySelectorAll('.quote-row').forEach(row =>
      row.addEventListener('click', async () => {
        const full = (await API.get(`/api/quotes/${row.dataset.quote}`)).quote;
        openQuoteEditor(wo, full, isAdmin);
      })
    );
  }

  async function openQuoteEditor(wo, quote, isAdmin) {
    // Pull the rate catalog for quick-add.
    let rateItems = [];
    try { rateItems = (await API.get('/api/rate-items')).rate_items; } catch (e) {}

    const items = quote && quote.items ? quote.items.map(i => ({ ...i })) : [];
    const readOnly = quote && ['approved', 'sent', 'accepted'].includes(quote.status);

    function lineRow(it, idx) {
      return `<tr data-idx="${idx}">
        <td><input class="qi-name" value="${esc(it.name || '')}" ${readOnly ? 'disabled' : ''} style="width:100%"></td>
        <td><select class="qi-kind" ${readOnly ? 'disabled' : ''}><option value="material" ${it.kind !== 'labour' ? 'selected' : ''}>Material</option><option value="labour" ${it.kind === 'labour' ? 'selected' : ''}>Labour</option></select></td>
        <td><input class="qi-qty" type="number" step="0.01" value="${it.quantity != null ? it.quantity : 1}" ${readOnly ? 'disabled' : ''} style="width:70px"></td>
        <td><input class="qi-price" type="number" step="0.01" value="${it.unit_price != null ? it.unit_price : 0}" ${readOnly ? 'disabled' : ''} style="width:90px"></td>
        <td class="qi-total">${money((Number(it.quantity)||0)*(Number(it.unit_price)||0))}</td>
        ${readOnly ? '' : '<td><button type="button" class="btn btn-sm btn-danger qi-del">×</button></td>'}
      </tr>`;
    }

    const teamForApproval = (await API.get('/api/users')).users.filter(x => ['admin','operational'].includes(x.role) && x.active !== 0);

    openModal(quote ? `${quote.reference} — ${QUOTE_STATUS_LABEL[quote.status]}` : 'Create quote', `
      <div class="field"><label>Quote title</label><input id="quoteTitle" value="${quote ? esc(quote.title || '') : esc('Quote for ' + wo.reference)}" ${readOnly ? 'disabled' : ''}></div>
      ${!readOnly ? `<div class="field"><label>Quick-add from rate catalog</label>
        <select id="ratePicker"><option value="">Choose a saved item…</option>
          ${rateItems.map(r => `<option value="${r.id}" data-name="${esc(r.name)}" data-kind="${r.kind}" data-unit="${esc(r.unit||'')}" data-price="${r.unit_price}">${esc(r.name)} — ${money(r.unit_price)}${r.unit ? '/'+esc(r.unit) : ''} (${r.kind})</option>`).join('')}
        </select>
        <p class="muted" style="font-size:.75em">Manage this list in the <a href="#/rate-catalog">Rate Catalog</a> tab.</p>
      </div>` : ''}
      <table class="simple" id="quoteItemsTable" style="font-size:.85em">
        <thead><tr><th>Item</th><th>Type</th><th>Qty</th><th>Unit price</th><th>Total</th>${readOnly ? '' : '<th></th>'}</tr></thead>
        <tbody id="quoteItemsBody">${items.map((it,i)=>lineRow(it,i)).join('')}</tbody>
      </table>
      ${readOnly ? '' : '<button type="button" class="btn btn-sm mt8" id="addLineBtn">+ Add line</button>'}
      <hr class="sep">
      <div class="flex-between"><strong>VAT rate (%)</strong><input id="quoteVat" type="number" step="0.1" value="${quote ? quote.vat_rate : 15}" ${readOnly ? 'disabled' : ''} style="width:70px"></div>
      <div class="flex-between mt8"><span>Subtotal</span><span id="quoteSubtotal">${money(quote ? quote.subtotal : 0)}</span></div>
      <div class="flex-between"><span>VAT</span><span id="quoteVatAmount">${money(quote ? quote.vat_amount : 0)}</span></div>
      <div class="flex-between"><strong>Total</strong><strong id="quoteTotal">${money(quote ? quote.total : 0)}</strong></div>
      <div class="field mt8"><label>Notes</label><textarea id="quoteNotes" ${readOnly ? 'disabled' : ''}>${quote ? esc(quote.notes || '') : ''}</textarea></div>

      ${quote && quote.status === 'pending_approval' ? `<div class="card" style="background:var(--brand-light)"><p style="margin:0">⏳ Awaiting approval from <strong>${esc(quote.approver_name || 'someone')}</strong>. They're reminded hourly until they respond.</p></div>` : ''}
      ${quote && quote.status === 'approved' ? `<div class="card" style="background:var(--success-light)"><p style="margin:0">✅ Approved. This quote is locked.</p></div>` : ''}

      <div class="modal-actions" style="flex-wrap:wrap;gap:8px">
        <button type="button" class="btn" data-close-modal>Close</button>
        ${!readOnly ? `<button type="button" class="btn btn-primary" id="saveQuoteBtn">${quote ? 'Save changes' : 'Create quote'}</button>` : ''}
        ${quote && !readOnly && quote.status !== 'pending_approval' ? `
          <select id="approverSelect" style="max-width:160px"><option value="">Tag approver…</option>${teamForApproval.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
          <button type="button" class="btn btn-primary" id="requestApprovalBtn">Send for approval</button>` : ''}
        ${quote && quote.status === 'pending_approval' && (isAdmin || quote.approver_id === App.state.user.id) ? `
          <button type="button" class="btn btn-primary" id="approveQuoteBtn">✅ Approve</button>
          <button type="button" class="btn btn-danger" id="rejectQuoteBtn">Send back</button>` : ''}
        ${quote && !readOnly ? `<button type="button" class="btn btn-danger" id="deleteQuoteBtn">Delete</button>` : ''}
      </div>
    `, (body) => {
      body.querySelector('[data-close-modal]').addEventListener('click', closeModal);

      function collectItems() {
        return Array.from(body.querySelectorAll('#quoteItemsBody tr')).map(tr => ({
          name: tr.querySelector('.qi-name').value,
          kind: tr.querySelector('.qi-kind').value,
          quantity: parseFloat(tr.querySelector('.qi-qty').value) || 0,
          unit_price: parseFloat(tr.querySelector('.qi-price').value) || 0,
        }));
      }
      function recalcUI() {
        let sub = 0;
        body.querySelectorAll('#quoteItemsBody tr').forEach(tr => {
          const q = parseFloat(tr.querySelector('.qi-qty').value) || 0;
          const p = parseFloat(tr.querySelector('.qi-price').value) || 0;
          const t = q * p; sub += t;
          tr.querySelector('.qi-total').textContent = money(t);
        });
        const vat = parseFloat(body.querySelector('#quoteVat').value) || 0;
        const vatAmt = sub * vat / 100;
        body.querySelector('#quoteSubtotal').textContent = money(sub);
        body.querySelector('#quoteVatAmount').textContent = money(vatAmt);
        body.querySelector('#quoteTotal').textContent = money(sub + vatAmt);
      }
      function wireRow(tr) {
        tr.querySelectorAll('input,select').forEach(inp => inp.addEventListener('input', recalcUI));
        const del = tr.querySelector('.qi-del');
        if (del) del.addEventListener('click', () => { tr.remove(); recalcUI(); });
      }
      body.querySelectorAll('#quoteItemsBody tr').forEach(wireRow);

      const addLineBtn = body.querySelector('#addLineBtn');
      if (addLineBtn) addLineBtn.addEventListener('click', () => {
        const tbody = body.querySelector('#quoteItemsBody');
        const idx = tbody.children.length;
        tbody.insertAdjacentHTML('beforeend', lineRow({ kind: 'material', quantity: 1, unit_price: 0 }, idx));
        wireRow(tbody.lastElementChild);
        recalcUI();
      });

      const picker = body.querySelector('#ratePicker');
      if (picker) picker.addEventListener('change', () => {
        const opt = picker.selectedOptions[0];
        if (!opt || !opt.value) return;
        const tbody = body.querySelector('#quoteItemsBody');
        tbody.insertAdjacentHTML('beforeend', lineRow({
          name: opt.dataset.name, kind: opt.dataset.kind, unit: opt.dataset.unit,
          quantity: 1, unit_price: parseFloat(opt.dataset.price) || 0
        }, tbody.children.length));
        wireRow(tbody.lastElementChild);
        recalcUI();
        picker.value = '';
      });

      const vatInput = body.querySelector('#quoteVat');
      if (vatInput) vatInput.addEventListener('input', recalcUI);

      const saveBtn = body.querySelector('#saveQuoteBtn');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const payload = {
          title: body.querySelector('#quoteTitle').value,
          notes: body.querySelector('#quoteNotes').value,
          vat_rate: parseFloat(body.querySelector('#quoteVat').value) || 15,
          items: collectItems(),
        };
        try {
          if (quote) await API.put(`/api/quotes/${quote.id}`, payload);
          else await API.post(`/api/work-orders/${wo.id}/quotes`, payload);
          closeModal(); toast('Quote saved', 'success'); App.render();
        } catch (e) { toast(e.message, 'error'); }
      });

      const reqBtn = body.querySelector('#requestApprovalBtn');
      if (reqBtn) reqBtn.addEventListener('click', async () => {
        const approverId = body.querySelector('#approverSelect').value;
        if (!approverId) return toast('Pick an approver to tag', 'error');
        try {
          // Save any edits first, then request approval.
          await API.put(`/api/quotes/${quote.id}`, {
            title: body.querySelector('#quoteTitle').value,
            notes: body.querySelector('#quoteNotes').value,
            vat_rate: parseFloat(body.querySelector('#quoteVat').value) || 15,
            items: collectItems(),
          });
          await API.post(`/api/quotes/${quote.id}/request-approval`, { approver_id: approverId });
          closeModal(); toast('Sent for approval — they’ll be reminded hourly', 'success'); App.render();
        } catch (e) { toast(e.message, 'error'); }
      });

      const approveBtn = body.querySelector('#approveQuoteBtn');
      if (approveBtn) approveBtn.addEventListener('click', async () => {
        try { await API.post(`/api/quotes/${quote.id}/approve`, {}); closeModal(); toast('Quote approved', 'success'); App.render(); }
        catch (e) { toast(e.message, 'error'); }
      });
      const rejectBtn = body.querySelector('#rejectQuoteBtn');
      if (rejectBtn) rejectBtn.addEventListener('click', async () => {
        const reason = prompt('Optional: what needs changing?') || '';
        try { await API.post(`/api/quotes/${quote.id}/reject`, { reason }); closeModal(); toast('Sent back for changes', 'success'); App.render(); }
        catch (e) { toast(e.message, 'error'); }
      });
      const delBtn = body.querySelector('#deleteQuoteBtn');
      if (delBtn) delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this quote?')) return;
        try { await API.del(`/api/quotes/${quote.id}`); closeModal(); toast('Quote deleted', 'success'); App.render(); }
        catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  function renderJobCard(el, wo, card, isStaff) {
    if (!card) {
      el.innerHTML = `
        <h3>Job Card</h3>
        <p class="muted">${isStaff ? 'No job card has been created for this work order yet.' : 'No job card yet — check back once operations has prepared one.'}</p>
        ${isStaff ? `<button class="btn btn-primary" id="createJobCardBtn">🧰 Create job card</button>` : ''}
      `;
      const btn = document.getElementById('createJobCardBtn');
      if (btn) btn.addEventListener('click', async () => {
        try {
          const res = await API.post(`/api/work-orders/${wo.id}/job-card`, {});
          navigate(`/job-cards/${res.job_card.id}`);
        } catch (e) { toast(e.message, 'error'); }
      });
      return;
    }
    el.innerHTML = `
      <div class="flex-between">
        <h3>Job Card</h3>
        <span class="badge ${card.status === 'finalized' ? 'badge-quote_sent' : 'badge-in_progress'}">${card.status === 'finalized' ? 'Finalized' : 'Draft'}</span>
      </div>
      <p class="muted">${card.status === 'finalized' ? `Finalized ${App.fmtDateTime(card.finalized_at)}` : (isStaff ? 'In progress — open the editor to add tasks and materials.' : 'Operations is still preparing this job card.')}</p>
      <div class="flex">
        ${isStaff ? `<button class="btn btn-primary btn-sm" id="openJobCardBtn">${card.status === 'finalized' ? 'Open job card' : 'Continue editing'}</button>` : ''}
        ${card.status === 'finalized' ? `<button class="btn btn-sm" id="dlJobCardBtn">⬇ Download PDF</button>` : ''}
      </div>
    `;
    const openBtn = document.getElementById('openJobCardBtn');
    if (openBtn) openBtn.addEventListener('click', () => navigate(`/job-cards/${card.id}`));
    const dl = document.getElementById('dlJobCardBtn');
    if (dl) dl.addEventListener('click', () => downloadJobCardPdf(card.id, wo.reference));
  }

  async function downloadJobCardPdf(cardId, reference) {
    try {
      const res = await fetch(`/api/job-cards/${cardId}/pdf`, { headers: { Authorization: 'Bearer ' + API.token() } });
      if (!res.ok) throw new Error('Could not download PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Job-Card-${reference}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Inspection report card on work order page ----------------
  function renderInspectionCard(el, wo, report, isStaff) {
    if (!report) {
      el.innerHTML = `
        <h3>Inspection Report</h3>
        <p class="muted">No inspection report has been started for this work order yet.</p>
        <button class="btn btn-primary" id="createReportBtn">📋 Create inspection report</button>
      `;
      const btn = document.getElementById('createReportBtn');
      if (btn) btn.addEventListener('click', async () => {
        try {
          const res = await API.post(`/api/work-orders/${wo.id}/inspection-report`, {});
          navigate(`/inspection-reports/${res.inspection_report.id}`);
        } catch (e) { toast(e.message, 'error'); }
      });
      return;
    }
    el.innerHTML = `
      <div class="flex-between">
        <h3>Inspection Report</h3>
        <span class="badge ${report.status === 'finalized' ? 'badge-quote_sent' : 'badge-in_progress'}">${report.status === 'finalized' ? 'Finalized' : 'Draft'}</span>
      </div>
      <p class="muted">${report.status === 'finalized' ? `Finalized ${App.fmtDateTime(report.finalized_at)}` : 'In progress — open the editor to add findings and photos.'}</p>
      <div class="flex">
        <button class="btn btn-primary btn-sm" id="openReportBtn">${report.status === 'finalized' ? 'Open report' : 'Continue editing'}</button>
        ${report.status === 'finalized' ? `<a class="btn btn-sm" href="/api/inspection-reports/${report.id}/pdf?token=${encodeURIComponent(API.token())}" id="dlBtn">⬇ Download PDF</a>` : ''}
      </div>
    `;
    document.getElementById('openReportBtn').addEventListener('click', () => navigate(`/inspection-reports/${report.id}`));
    const dl = document.getElementById('dlBtn');
    if (dl) dl.addEventListener('click', (e) => { e.preventDefault(); downloadPdf(report.id, wo.reference); });
  }

  async function downloadPdf(reportId, reference) {
    try {
      const res = await fetch(`/api/inspection-reports/${reportId}/pdf`, { headers: { Authorization: 'Bearer ' + API.token() } });
      if (!res.ok) throw new Error('Could not download PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Inspection-Report-${reference}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Inspection report editor ----------------
  route('/inspection-reports/:id', async ({ id }) => {
    const view = document.getElementById('view');
    const data = await API.get(`/api/inspection-reports/${id}`);
    const report = data.inspection_report;
    const wasFinalized = report.status === 'finalized'; // editing is always allowed now — this only changes which buttons show
    let sections = [];
    let photos = [];
    try { sections = JSON.parse(report.sections || '[]'); } catch (e) {}
    try { photos = JSON.parse(report.photos || '[]'); } catch (e) {}
    // backfill ids/photos array for sections created before this feature existed
    sections.forEach(s => { if (!s.id) s.id = genId(); if (!Array.isArray(s.photos)) s.photos = []; });

    view.innerHTML = `
      <a href="#/work-orders/${report.work_order_id}" class="muted">&larr; Back to work order</a>

      <div class="card mt12">
        <div class="letterhead">
          ${App.state.settings.company_logo ? `<img src="/uploads/logo/${esc((App.state.settings.company_logo||'').split('/').pop())}">` : '<div></div>'}
          <div class="co-info">
            <div class="co-name">${esc(App.state.settings.company_name || 'Your Company')}</div>
            <div class="co-meta">${esc(App.state.settings.company_address || '')}</div>
            <div class="co-meta">${esc(App.state.settings.company_phone || '')} ${App.state.settings.company_email ? '· ' + esc(App.state.settings.company_email) : ''}</div>
          </div>
        </div>
        <h2 style="margin-top:0">Site Inspection Report</h2>
        ${wasFinalized
          ? `<p class="muted">Finalized ${App.fmtDateTime(report.finalized_at)}. You can still edit this report — click "Update &amp; Regenerate PDF" below to refresh the downloadable PDF with your changes.</p>`
          : '<p class="muted">Fill in your findings below, attach photos, then finalize to generate the branded PDF and send it to the work order.</p>'}

        <div class="field"><label>Report title</label><input id="titleInput" value="${esc(report.title || '')}"></div>
        <div class="field"><label>Summary</label><textarea id="summaryInput">${esc(report.summary || '')}</textarea></div>

        <h3>Findings sections</h3>
        <div id="sectionsWrap"></div>
        <button class="btn btn-sm" id="addSectionBtn">+ Add finding</button>

        <h3 class="mt16">Overview Photos <span class="muted" style="font-size:.7em;font-weight:400">(general site photos not tied to a specific finding)</span></h3>
        <input type="file" id="photoInput" accept="image/*" multiple capture="environment">
        <p class="muted" style="font-size:.8em">Select photos from your camera or photo library.</p>
        <div class="photo-grid" id="photoGrid"></div>

        <hr class="sep">
        <div class="flex" style="flex-wrap:wrap;gap:10px">
          <button class="btn btn-primary" id="saveDraftBtn">Save changes</button>
          <button class="btn ${wasFinalized ? '' : 'btn-danger'}" id="finalizeBtn">${wasFinalized ? '🔄 Update & Regenerate PDF' : '✅ Finalize report'}</button>
          ${wasFinalized ? `<button class="btn btn-sm" id="dlBtn2">⬇ Download PDF</button>` : ''}
        </div>
      </div>
    `;

    function renderSectionPhotos(sectionId) {
      const grid = document.getElementById(`secPhotos-${sectionId}`);
      if (!grid) return;
      const section = sections.find(s => s.id === sectionId);
      const secPhotos = (section && section.photos) || [];
      grid.innerHTML = secPhotos.map(p => `
        <div class="photo-thumb">
          <img src="${esc(p.url)}" alt="">
          <a class="download-photo" href="${esc(p.url)}" download title="Download photo">⬇</a>
          <input data-sec-cap="${esc(p.id)}" data-sec-id="${esc(sectionId)}" value="${esc(p.caption || '')}" placeholder="Caption">
          <button class="remove-photo" data-remove-sec-photo="${esc(p.id)}">&times;</button>
        </div>
      `).join('') || `<p class="muted" style="font-size:.8em">No photos for this finding yet.</p>`;
      grid.querySelectorAll('[data-sec-cap]').forEach(inp => inp.addEventListener('change', async (e) => {
        const sec = sections.find(s => s.id === e.target.dataset.secId);
        const p = sec && sec.photos.find(x => x.id === e.target.dataset.secCap);
        if (p) p.caption = e.target.value;
        await saveDraft(false);
      }));
      grid.querySelectorAll('[data-remove-sec-photo]').forEach(btn => btn.addEventListener('click', async (e) => {
        try {
          await API.del(`/api/inspection-reports/${id}/photos/${e.target.dataset.removeSecPhoto}`);
          if (section) section.photos = section.photos.filter(p => p.id !== e.target.dataset.removeSecPhoto);
          renderSectionPhotos(sectionId);
          toast('Photo removed', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }));
    }

    function renderSections() {
      const wrap = document.getElementById('sectionsWrap');
      wrap.innerHTML = sections.map((s, i) => `
        <div class="section-block">
          <div class="field"><label>Heading</label><input data-sec="${i}" data-f="heading" value="${esc(s.heading || '')}"></div>
          <div class="field"><label>Notes</label><textarea data-sec="${i}" data-f="notes">${esc(s.notes || '')}</textarea></div>
          <label style="display:block;font-size:.8em;font-weight:600;color:var(--muted);margin-bottom:5px">Photos for this finding</label>
          <input type="file" data-sec-photo-input="${esc(s.id)}" accept="image/*" multiple capture="environment">
          <div class="photo-grid" id="secPhotos-${esc(s.id)}" style="margin-top:8px"></div>
          <button class="btn btn-sm btn-danger mt8" data-remove-sec="${i}">Remove finding</button>
        </div>
      `).join('') || `<p class="muted">No findings yet — click "+ Add finding" below to start.</p>`;

      sections.forEach(s => renderSectionPhotos(s.id));

      wrap.querySelectorAll('[data-sec]').forEach(inp => inp.addEventListener('input', (e) => {
        sections[+e.target.dataset.sec][e.target.dataset.f] = e.target.value;
      }));
      wrap.querySelectorAll('[data-remove-sec]').forEach(btn => btn.addEventListener('click', (e) => {
        sections.splice(+e.target.dataset.removeSec, 1); renderSections();
      }));
      wrap.querySelectorAll('[data-sec-photo-input]').forEach(inp => inp.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const sectionId = e.target.dataset.secPhotoInput;
        toast('Uploading photo(s)…');
        try {
          // Make sure this finding actually exists on the server first — if it was
          // just added and never saved, the server has no matching finding yet to
          // attach the photo to, and it would silently end up in the wrong place.
          await saveDraft(false);
          const fd = new FormData();
          files.forEach(f => fd.append('photos', f));
          fd.append('section_id', sectionId);
          const res = await API.post(`/api/inspection-reports/${id}/photos`, fd, true);
          const freshSections = JSON.parse(res.inspection_report.sections);
          const updated = freshSections.find(s => s.id === sectionId);
          const local = sections.find(s => s.id === sectionId);
          if (local && updated) local.photos = updated.photos;
          renderSectionPhotos(sectionId);
          toast('Photo(s) added to finding', 'success');
        } catch (err) { toast(err.message, 'error'); }
        e.target.value = '';
      }));
    }

    function renderPhotos() {
      const grid = document.getElementById('photoGrid');
      grid.innerHTML = photos.map(p => `
        <div class="photo-thumb">
          <img src="${esc(p.url)}" alt="">
          <a class="download-photo" href="${esc(p.url)}" download title="Download photo">⬇</a>
          <input data-cap="${esc(p.id)}" value="${esc(p.caption || '')}" placeholder="Caption">
          <button class="remove-photo" data-remove-photo="${esc(p.id)}">&times;</button>
        </div>
      `).join('') || `<p class="muted">No photos yet.</p>`;
      grid.querySelectorAll('[data-cap]').forEach(inp => inp.addEventListener('change', async (e) => {
        const p = photos.find(x => x.id === e.target.dataset.cap);
        if (p) p.caption = e.target.value;
        await saveDraft(false);
      }));
      grid.querySelectorAll('[data-remove-photo]').forEach(btn => btn.addEventListener('click', async (e) => {
        try {
          await API.del(`/api/inspection-reports/${id}/photos/${e.target.dataset.removePhoto}`);
          photos = photos.filter(p => p.id !== e.target.dataset.removePhoto);
          renderPhotos();
          toast('Photo removed', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }));
    }

    renderSections();
    renderPhotos();

    document.getElementById('addSectionBtn').addEventListener('click', () => { sections.push({ id: genId(), heading: '', notes: '', photos: [] }); renderSections(); });

    document.getElementById('photoInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const fd = new FormData();
      files.forEach(f => fd.append('photos', f));
      toast('Uploading photo(s)…');
      try {
        const res = await API.post(`/api/inspection-reports/${id}/photos`, fd, true);
        photos = JSON.parse(res.inspection_report.photos);
        renderPhotos();
        toast('Photo(s) added', 'success');
      } catch (err) { toast(err.message, 'error'); }
      e.target.value = '';
    });

    async function saveDraft(showToast = true) {
      try {
        await API.put(`/api/inspection-reports/${id}`, {
          title: document.getElementById('titleInput').value,
          summary: document.getElementById('summaryInput').value,
          sections
        });
        if (showToast) toast('Changes saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    }

    document.getElementById('saveDraftBtn').addEventListener('click', () => saveDraft(true));

    document.getElementById('finalizeBtn').addEventListener('click', () => {
      const title = wasFinalized ? 'Update & Regenerate PDF' : 'Finalize Inspection Report';
      const body = wasFinalized
        ? `<p>This will save your latest changes and regenerate the PDF attached to this work order.</p>
           <p class="muted">The quote SLA timer will <strong>not</strong> be affected — it stays based on when the report was first finalized.</p>
           <div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="confirmFinalize">Update PDF now</button></div>`
        : `<p>This generates a branded PDF and attaches it to the work order.</p>
           <p>This also starts the <strong>quote SLA timer</strong> for the operations team. You can still come back and edit this report later if needed.</p>
           <div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-danger" id="confirmFinalize">Finalize now</button></div>`;
      openModal(title, body, (el) => {
        el.querySelector('[data-close-modal]').addEventListener('click', closeModal);
        el.querySelector('#confirmFinalize').addEventListener('click', async () => {
          try {
            await saveDraft(false);
            await API.post(`/api/inspection-reports/${id}/finalize`, {});
            closeModal();
            toast(wasFinalized ? 'PDF updated' : 'Report finalized — PDF generated', 'success');
            navigate(`/work-orders/${report.work_order_id}`);
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    });

    const dl2 = document.getElementById('dlBtn2');
    if (dl2) dl2.addEventListener('click', (e) => { e.preventDefault(); downloadPdf(id, ''); });
  });
})();
