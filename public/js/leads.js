// public/js/leads.js
(() => {
  const { route, openModal, closeModal, toast, esc, fmtDateTime } = App;

  const PIPELINE = [
    { key: 'new', label: 'New', color: '#6b7280' },
    { key: 'contacted', label: 'Contacted', color: '#1d4ed8' },
    { key: 'qualified', label: 'Qualified', color: '#7c3aed' },
    { key: 'proposal', label: 'Proposal Sent', color: '#d97706' },
    { key: 'won', label: 'Won', color: '#15803d' },
    { key: 'lost', label: 'Lost', color: '#b91c1c' }
  ];

  route('/leads', async () => {
    const u = App.state.user;
    const view = document.getElementById('view');
    view.innerHTML = `<div class="card"><div class="flex"><div class="spinner"></div> Loading…</div></div>`;

    const marketingUsers = (await API.get('/api/users')).users.filter((x) => x.role === 'marketing' && x.active !== 0);

    view.innerHTML = `
      <div class="section-title">
        <h2>🎯 Leads Pipeline</h2>
        <button class="btn btn-primary" id="newLeadBtn">+ New lead</button>
      </div>
      <div id="pipelineBoard" style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;"></div>
    `;

    async function load() {
      const { leads } = await API.get('/api/leads');
      const board = document.getElementById('pipelineBoard');
      board.innerHTML = PIPELINE.map((col) => {
        const colLeads = leads.filter((l) => l.status === col.key);
        const totalValue = colLeads.reduce((sum, l) => sum + (parseFloat(l.value) || 0), 0);
        return `
        <div style="flex:0 0 240px;background:var(--bg);border-radius:10px;padding:10px;">
          <div class="flex-between" style="margin-bottom:8px;padding:0 2px">
            <span style="font-weight:700;font-size:.82em;color:${col.color};text-transform:uppercase;letter-spacing:.03em">${col.label}</span>
            <span class="badge" style="background:${col.color}22;color:${col.color}">${colLeads.length}</span>
          </div>
          ${totalValue ? `<div class="muted" style="font-size:.74em;margin-bottom:8px;padding:0 2px">Total: ${totalValue.toLocaleString()}</div>` : ''}
          <div style="display:flex;flex-direction:column;gap:8px">
            ${colLeads.map((l) => `
              <div class="card" data-lead="${l.id}" style="margin-bottom:0;padding:10px;cursor:pointer;border-top:3px solid ${col.color}">
                <div style="font-weight:600;font-size:.88em">${esc(l.name)}</div>
                ${l.company ? `<div class="muted" style="font-size:.78em">${esc(l.company)}</div>` : ''}
                ${l.value ? `<div style="font-size:.78em;margin-top:4px;font-weight:600;color:${col.color}">${esc(l.value)}</div>` : ''}
                ${l.assignee_name ? `<div class="muted" style="font-size:.72em;margin-top:4px">👤 ${esc(l.assignee_name)}</div>` : ''}
              </div>
            `).join('') || `<div class="muted" style="font-size:.78em;padding:8px 2px">No leads here</div>`}
          </div>
        </div>`;
      }).join('');
      board.querySelectorAll('[data-lead]').forEach((el) => el.addEventListener('click', () => openLeadDetail(el.dataset.lead)));
    }

    function openNewLeadForm() {
      openModal('New Lead', `
        <form id="leadForm">
          <div class="form-row">
            <div class="field"><label>Name</label><input name="name" required></div>
            <div class="field"><label>Company</label><input name="company"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Email</label><input type="email" name="email"></div>
            <div class="field"><label>Phone</label><input name="phone"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Source</label><input name="source" placeholder="e.g. referral, website, cold call"></div>
            <div class="field"><label>Estimated value</label><input name="value" placeholder="e.g. R15,000"></div>
          </div>
          <div class="field"><label>Assign to</label><select name="assigned_to">
            <option value="${u.id}">Me</option>
            ${marketingUsers.filter((m) => m.id !== u.id).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}
          </select></div>
          <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
          <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Add lead</button></div>
        </form>
      `, (body) => {
        body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
        body.querySelector('#leadForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(e.target).entries());
          try {
            await API.post('/api/leads', payload);
            closeModal(); toast('Lead added', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }

    async function openLeadDetail(leadId) {
      const { lead, activity } = await API.get(`/api/leads/${leadId}`);
      openModal(lead.name, `
        <table class="simple">
          <tr><th>Company</th><td>${esc(lead.company || '—')}</td></tr>
          <tr><th>Email</th><td>${esc(lead.email || '—')}</td></tr>
          <tr><th>Phone</th><td>${esc(lead.phone || '—')}</td></tr>
          <tr><th>Source</th><td>${esc(lead.source || '—')}</td></tr>
          <tr><th>Value</th><td>${esc(lead.value || '—')}</td></tr>
          <tr><th>Notes</th><td>${esc(lead.notes || '—')}</td></tr>
        </table>
        <div class="form-row mt12">
          <div class="field"><label>Pipeline stage</label><select id="leadStatusSelect">
            ${PIPELINE.map((c) => `<option value="${c.key}" ${c.key === lead.status ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select></div>
          <div class="field"><label>Assigned to</label><select id="leadAssigneeSelect">
            ${marketingUsers.map((m) => `<option value="${m.id}" ${m.id === lead.assigned_to ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select></div>
        </div>
        <button class="btn btn-primary btn-sm" id="saveLeadBtn">Save changes</button>
        ${App.state.user.role === 'admin' ? `<button class="btn btn-danger btn-sm" id="deleteLeadBtn">Delete lead</button>` : ''}
        <hr class="sep">
        <h3 style="font-size:.9em">Activity / call notes</h3>
        <form id="addNoteForm" class="flex" style="margin-bottom:10px">
          <input name="message" placeholder="Log a call, email, or note…" style="flex:1">
          <button class="btn btn-sm" type="submit">Add</button>
        </form>
        <div>${activity.map((a) => `<div class="list-item" style="cursor:default;padding:8px 0"><div><div style="font-size:.88em">${esc(a.message)}</div><div class="meta">${a.user_name ? esc(a.user_name) + ' · ' : ''}${fmtDateTime(a.created_at)}</div></div></div>`).join('') || '<p class="muted">No activity yet.</p>'}</div>
      `, (body) => {
        body.querySelector('#saveLeadBtn').addEventListener('click', async () => {
          try {
            await API.put(`/api/leads/${leadId}`, {
              status: body.querySelector('#leadStatusSelect').value,
              assigned_to: body.querySelector('#leadAssigneeSelect').value
            });
            closeModal(); toast('Lead updated', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
        const delBtn = body.querySelector('#deleteLeadBtn');
        if (delBtn) delBtn.addEventListener('click', async () => {
          if (!confirm('Delete this lead permanently?')) return;
          try {
            await API.del(`/api/leads/${leadId}`);
            closeModal(); toast('Lead deleted', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
        body.querySelector('#addNoteForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            await API.post(`/api/leads/${leadId}/activity`, { message: fd.get('message') });
            openLeadDetail(leadId); // reopen to show the new note
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }

    document.getElementById('newLeadBtn').addEventListener('click', openNewLeadForm);
    await load();
  });
})();
