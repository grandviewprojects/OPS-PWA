// public/js/team.js
(() => {
  const { route, navigate, openModal, closeModal, toast, esc, fmtDate } = App;

  // ---------------- Team list ----------------
  route('/team', async () => {
    const u = App.state.user;
    const isAdmin = u.role === 'admin';
    const view = document.getElementById('view');
    const data = await API.get('/api/users');

    view.innerHTML = `
      <div class="section-title">
        <h2>Team</h2>
        ${isAdmin ? `<button class="btn btn-primary" id="newUserBtn">+ New profile</button>` : ''}
      </div>
      <div class="grid grid-3" id="teamGrid"></div>
    `;
    const grid = document.getElementById('teamGrid');
    grid.innerHTML = data.users.map(p => `
      <div class="card" data-user="${p.id}" style="cursor:pointer">
        <div class="flex">
          <div class="avatar" style="background:${esc(p.color || '#2563eb')}">${App.initials(p.name)}</div>
          <div>
            <div style="font-weight:700">${esc(p.name)}${p.active === 0 ? ' <span class="muted">(inactive)</span>' : ''}</div>
            <div class="meta muted">${esc(p.job_title || '')}</div>
          </div>
        </div>
        <div class="mt8"><span class="badge badge-role-${p.role}">${p.role}</span></div>
      </div>
    `).join('');
    grid.querySelectorAll('[data-user]').forEach(el => el.addEventListener('click', () => navigate(`/profile/${el.dataset.user}`)));

    if (isAdmin) document.getElementById('newUserBtn').addEventListener('click', () => openNewUserForm());
  });

  function openNewUserForm() {
    openModal('Create Profile', `
      <form id="newUserForm">
        <div class="form-row">
          <div class="field"><label>Full name</label><input name="name" required></div>
          <div class="field"><label>Role</label><select name="role" required>
            <option value="onsite">Onsite team</option>
            <option value="operational">Operational team</option>
            <option value="marketing">Marketing/Sales</option>
            <option value="admin">Admin</option>
          </select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Email (used to log in)</label><input type="email" name="email" required></div>
          <div class="field"><label>Temporary password</label><input name="password" required minlength="8" placeholder="At least 8 characters"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Job title</label><input name="job_title"></div>
          <div class="field"><label>Phone</label><input name="phone"></div>
        </div>
        <p class="privacy-note">The person will be asked to set their own password on first login. You can add private HR details (ID number, emergency contact, etc.) afterwards from their profile — only admins can edit those.</p>
        <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Create profile</button></div>
      </form>
    `, (body) => {
      body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
      body.querySelector('#newUserForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(e.target).entries());
        try {
          const res = await API.post('/api/users', payload);
          closeModal(); toast('Profile created', 'success');
          navigate(`/profile/${res.user.id}`);
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ---------------- Profile ----------------
  route('/profile/:id', async ({ id }) => {
    const me = App.state.user;
    const isAdmin = me.role === 'admin';
    const isSelf = me.id === id;
    const view = document.getElementById('view');
    const data = await API.get(`/api/users/${id}`);
    const p = data.user;
    const priv = p.private_info || null;
    const canSeePrivate = isAdmin || isSelf;

    view.innerHTML = `
      <a href="#/team" class="muted">&larr; Back to team</a>
      <div class="card mt12">
        <div class="flex">
          <div class="avatar" style="background:${esc(p.color || '#2563eb')};width:52px;height:52px;font-size:1.1em">${App.initials(p.name)}</div>
          <div>
            <h2 style="margin:0">${esc(p.name)}</h2>
            <span class="badge badge-role-${p.role}">${p.role}</span> ${p.active === 0 ? '<span class="badge" style="background:#f3f4f6;color:#6b7280">Inactive</span>' : ''}
          </div>
        </div>
        <table class="simple mt12">
          <tr><th>Job title</th><td>${esc(p.job_title || '—')}</td></tr>
          ${p.email ? `<tr><th>Email</th><td>${esc(p.email)}</td></tr>` : ''}
          <tr><th>Phone</th><td>${esc(p.phone || '—')}</td></tr>
        </table>
        ${isAdmin ? `<button class="btn btn-sm mt8" id="editProfileBtn">Edit profile</button>
        ${!isSelf ? `<button class="btn btn-sm mt8" id="deactivateBtn">${p.active === 0 ? 'Reactivate' : 'Deactivate'}</button>` : ''}` : ''}
        ${isSelf ? `<a href="#/account" class="btn btn-sm mt8">Change my password</a>` : ''}
        <a href="#/calendar" class="btn btn-sm mt8">View calendar</a>
      </div>

      ${canSeePrivate ? `
      <div class="card" id="privateCard">
        <div class="flex-between">
          <h3>Private Information</h3>
          ${isAdmin ? `<button class="btn btn-sm" id="editPrivateBtn">${priv && priv.id_number ? 'Edit' : 'Add details'}</button>` : ''}
        </div>
        <p class="privacy-note">${isAdmin ? 'Only admins can edit this information. The team member can view but not change it.' : 'This information is managed by your admin and cannot be edited by you.'}</p>
        <table class="simple">
          <tr><th>ID number</th><td>${esc(priv?.id_number || '—')}</td></tr>
          <tr><th>Date of birth</th><td>${priv?.date_of_birth ? fmtDate(priv.date_of_birth) : '—'}</td></tr>
          <tr><th>Address</th><td>${esc(priv?.address || '—')}</td></tr>
          <tr><th>Emergency contact</th><td>${esc(priv?.emergency_contact_name || '—')} ${priv?.emergency_contact_phone ? '(' + esc(priv.emergency_contact_phone) + ')' : ''}</td></tr>
          <tr><th>Contract type</th><td>${esc(priv?.contract_type || '—')}</td></tr>
          <tr><th>Start date</th><td>${priv?.start_date ? fmtDate(priv.start_date) : '—'}</td></tr>
          ${isAdmin ? `<tr><th>Bank details</th><td>${esc(priv?.bank_details || '—')}</td></tr>
          <tr><th>Salary / rate</th><td>${esc(priv?.salary_rate || '—')}</td></tr>
          <tr><th>Admin notes</th><td>${esc(priv?.admin_notes || '—')}</td></tr>` : ''}
        </table>
      </div>` : ''}
    `;

    if (isAdmin) {
      document.getElementById('editProfileBtn').addEventListener('click', () => openEditProfileForm(p));
      const editPriv = document.getElementById('editPrivateBtn');
      if (editPriv) editPriv.addEventListener('click', () => openEditPrivateForm(p.id, priv));
      const deactivateBtn = document.getElementById('deactivateBtn');
      if (deactivateBtn) deactivateBtn.addEventListener('click', async () => {
        if (p.active === 0) {
          await API.put(`/api/users/${p.id}`, { active: 1 });
        } else {
          if (!confirm(`Deactivate ${p.name}? They will no longer be able to log in.`)) return;
          await API.del(`/api/users/${p.id}`);
        }
        App.render();
      });
    }
  });

  function openEditProfileForm(p) {
    openModal('Edit Profile', `
      <form id="editProfileForm">
        <div class="form-row">
          <div class="field"><label>Full name</label><input name="name" value="${esc(p.name)}" required></div>
          <div class="field"><label>Role</label><select name="role">
            ${['onsite','operational','marketing','admin'].map(r => `<option value="${r}" ${r===p.role?'selected':''}>${r}</option>`).join('')}
          </select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Email</label><input type="email" name="email" value="${esc(p.email)}" required></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(p.phone || '')}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Job title</label><input name="job_title" value="${esc(p.job_title || '')}"></div>
          <div class="field"><label>Calendar color</label><input type="color" name="color" value="${esc(p.color || '#2563eb')}"></div>
        </div>
        <div class="field"><label>Reset password (optional)</label><input name="password" placeholder="Leave blank to keep current password" minlength="8"></div>
        <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
    `, (body) => {
      body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
      body.querySelector('#editProfileForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(e.target).entries());
        if (!payload.password) delete payload.password;
        try { await API.put(`/api/users/${p.id}`, payload); closeModal(); toast('Profile updated', 'success'); App.render(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  function openEditPrivateForm(userId, priv) {
    priv = priv || {};
    openModal('Private Information (admin only)', `
      <form id="privForm">
        <div class="form-row">
          <div class="field"><label>ID number</label><input name="id_number" value="${esc(priv.id_number || '')}"></div>
          <div class="field"><label>Date of birth</label><input type="date" name="date_of_birth" value="${priv.date_of_birth ? priv.date_of_birth.slice(0,10) : ''}"></div>
        </div>
        <div class="field"><label>Address</label><input name="address" value="${esc(priv.address || '')}"></div>
        <div class="form-row">
          <div class="field"><label>Emergency contact name</label><input name="emergency_contact_name" value="${esc(priv.emergency_contact_name || '')}"></div>
          <div class="field"><label>Emergency contact phone</label><input name="emergency_contact_phone" value="${esc(priv.emergency_contact_phone || '')}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Contract type</label><input name="contract_type" value="${esc(priv.contract_type || '')}" placeholder="e.g. Full-time, Contractor"></div>
          <div class="field"><label>Start date</label><input type="date" name="start_date" value="${priv.start_date ? priv.start_date.slice(0,10) : ''}"></div>
        </div>
        <div class="field"><label>Bank details</label><input name="bank_details" value="${esc(priv.bank_details || '')}"></div>
        <div class="field"><label>Salary / rate</label><input name="salary_rate" value="${esc(priv.salary_rate || '')}"></div>
        <div class="field"><label>Admin notes</label><textarea name="admin_notes">${esc(priv.admin_notes || '')}</textarea></div>
        <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
    `, (body) => {
      body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
      body.querySelector('#privForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = Object.fromEntries(new FormData(e.target).entries());
        try { await API.put(`/api/users/${userId}/private`, payload); closeModal(); toast('Private info saved', 'success'); App.render(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ---------------- Settings (admin) ----------------
  route('/settings', async () => {
    const view = document.getElementById('view');
    const data = await API.get('/api/settings');
    const s = data.settings;
    const teamRes = await API.get('/api/users');
    const allProfiles = teamRes.users.filter((u) => u.active !== 0);

    view.innerHTML = `
      <div class="card" style="max-width:560px">
        <h2>Company Branding (used on inspection report letterhead)</h2>
        <div class="field"><label>Company name</label><input id="company_name" value="${esc(s.company_name || '')}"></div>
        <div class="field"><label>Address</label><input id="company_address" value="${esc(s.company_address || '')}"></div>
        <div class="form-row">
          <div class="field"><label>Phone</label><input id="company_phone" value="${esc(s.company_phone || '')}"></div>
          <div class="field"><label>Email</label><input id="company_email" value="${esc(s.company_email || '')}"></div>
        </div>
        <div class="field"><label>Website <span class="muted">(optional)</span></label><input id="company_website" value="${esc(s.company_website || '')}" placeholder="www.yourcompany.com"></div>
        <div class="form-row">
          <div class="field"><label>Registration number <span class="muted">(optional)</span></label><input id="registration_number" value="${esc(s.registration_number || '')}" placeholder="Leave blank if not applicable"></div>
          <div class="field"><label>VAT number <span class="muted">(optional)</span></label><input id="vat_number" value="${esc(s.vat_number || '')}" placeholder="Leave blank if not applicable"></div>
        </div>
        <div class="field"><label>Brand color</label><input type="color" id="brand_color" value="${esc(s.brand_color || '#1d4ed8')}"></div>
        <div class="field">
          <label>Logo / letterhead image</label>
          ${s.company_logo ? `<img src="/uploads/logo/${esc(s.company_logo.split('/').pop())}" style="max-height:50px;display:block;margin-bottom:8px">` : ''}
          <input type="file" id="logoInput" accept="image/*">
        </div>
        <button class="btn btn-primary mt8" id="saveSettingsBtn">Save branding</button>
      </div>
      <div class="card" style="max-width:560px">
        <h2>Quote SLA</h2>
        <div class="field"><label>Hours allowed to send a quote after inspection report is finalized</label><input type="number" id="sla_hours" value="${esc(s.quote_sla_hours || '72')}" min="1"></div>
        <button class="btn btn-primary mt8" id="saveSlaBtn">Save SLA</button>
      </div>
      <div class="card" style="max-width:560px">
        <h2>External Request Portal</h2>
        <p class="muted">Share this link with clients so they can submit work order requests directly — no login required:</p>
        <input readonly value="${location.origin}/portal" onclick="this.select()">
      </div>

      <div class="card" style="max-width:560px">
        <h2>Notification Settings</h2>
        <p class="muted">Notification preferences are managed centrally here — pick a profile to view or change exactly what they get notified about.</p>
        <div class="field"><label>Profile</label>
          <select id="notifProfileSelect">
            <option value="">Select a profile…</option>
            ${allProfiles.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.role})</option>`).join('')}
          </select>
        </div>
        <div id="notifPrefsPanel"></div>
      </div>
    `;

    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
      try {
        await API.put('/api/settings', {
          company_name: document.getElementById('company_name').value,
          company_address: document.getElementById('company_address').value,
          company_phone: document.getElementById('company_phone').value,
          company_email: document.getElementById('company_email').value,
          company_website: document.getElementById('company_website').value,
          registration_number: document.getElementById('registration_number').value,
          vat_number: document.getElementById('vat_number').value,
          brand_color: document.getElementById('brand_color').value
        });
        const file = document.getElementById('logoInput').files[0];
        if (file) {
          const fd = new FormData(); fd.append('logo', file);
          await API.post('/api/settings/logo', fd, true);
        }
        toast('Branding saved', 'success');
        App.state.settings = (await API.get('/api/settings')).settings;
        App.render();
      } catch (err) { toast(err.message, 'error'); }
    });

    document.getElementById('saveSlaBtn').addEventListener('click', async () => {
      try {
        await API.put('/api/settings', { quote_sla_hours: document.getElementById('sla_hours').value });
        toast('SLA updated', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    document.getElementById('notifProfileSelect').addEventListener('change', async (e) => {
      const panel = document.getElementById('notifPrefsPanel');
      const userId = e.target.value;
      if (!userId) { panel.innerHTML = ''; return; }
      panel.innerHTML = `<div class="flex mt12"><div class="spinner"></div> Loading…</div>`;
      let prefs;
      try {
        prefs = (await API.get(`/api/users/${userId}/notification-preferences`)).preferences;
      } catch (err) { panel.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }

      panel.innerHTML = `
        <form id="notifForm" class="mt12">
          ${App.NOTIF_CATEGORIES.map((c) => `
            <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;font-weight:400">
              <input type="checkbox" name="push_${c.key}" ${prefs['push_' + c.key] ? 'checked' : ''} style="margin-top:3px">
              <span>
                <span style="display:block;font-size:.92em">${c.label}</span>
                <span class="muted" style="font-size:.78em">${c.hint}</span>
              </span>
            </label>
          `).join('')}
          <div class="field" style="max-width:160px">
            <label>Daily reminder time</label>
            <input type="time" name="daily_checkin_time" value="${esc(prefs.daily_checkin_time || '07:00')}">
          </div>
          <button class="btn btn-primary mt8" type="submit">Save for this profile</button>
        </form>
      `;
      document.getElementById('notifForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.target);
        const payload = { daily_checkin_time: fd.get('daily_checkin_time') };
        App.NOTIF_CATEGORIES.forEach((c) => { payload['push_' + c.key] = fd.get('push_' + c.key) === 'on'; });
        try {
          await API.put(`/api/users/${userId}/notification-preferences`, payload);
          toast('Notification settings saved', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  });
})();
