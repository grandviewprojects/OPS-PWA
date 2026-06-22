// public/js/calendar.js
(() => {
  const { route, navigate, openModal, closeModal, toast, esc, fmtDateTime } = App;

  let viewMonth = new Date(); viewMonth.setDate(1);
  let selectedUserId = null;
  let teamUsers = [];

  function monthBounds(d) {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    return { start, end };
  }

  route('/calendar', async () => {
    const view = document.getElementById('view');
    const u = App.state.user;
    const isStaff = u.role === 'admin' || u.role === 'operational';

    if (isStaff && teamUsers.length === 0) {
      teamUsers = (await API.get('/api/users')).users.filter(x => x.active !== 0);
    }
    if (!selectedUserId) selectedUserId = u.id;

    view.innerHTML = `
      <div class="cal-header">
        <div class="flex">
          <button class="btn btn-sm" id="prevMonth">←</button>
          <strong id="monthLabel" style="min-width:160px;text-align:center;display:inline-block"></strong>
          <button class="btn btn-sm" id="nextMonth">→</button>
        </div>
        <div class="flex">
          ${isStaff ? `<select id="userSelect" class="field" style="width:auto">
            <option value="ALL">All team (overview)</option>
            ${teamUsers.map(tu => `<option value="${tu.id}" ${tu.id === selectedUserId ? 'selected' : ''}>${esc(tu.name)} (${tu.role})</option>`).join('')}
          </select>` : ''}
          <button class="btn btn-primary btn-sm" id="addEventBtn">+ Add event</button>
        </div>
      </div>
      <div class="cal-grid" id="calGrid"></div>
    `;
    if (isStaff) document.getElementById('userSelect').value = selectedUserId;

    async function load() {
      document.getElementById('monthLabel').textContent = viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const { start, end } = monthBounds(viewMonth);
      let events = [];
      if (selectedUserId === 'ALL') {
        events = (await API.get(`/api/calendar?from=${start.toISOString()}&to=${end.toISOString()}`)).events;
      } else {
        events = (await API.get(`/api/calendar/${selectedUserId}?from=${start.toISOString()}&to=${end.toISOString()}`)).events;
      }
      renderGrid(events);
    }

    function renderGrid(events) {
      const grid = document.getElementById('calGrid');
      const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const firstDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
      const startOffset = firstDay.getDay();
      const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
      const todayStr = new Date().toDateString();

      const eventsByDay = {};
      events.forEach(ev => {
        const d = new Date(ev.start_at);
        const key = d.toDateString();
        (eventsByDay[key] = eventsByDay[key] || []).push(ev);
      });

      let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');
      for (let i = 0; i < startOffset; i++) html += `<div class="cal-cell other-month"></div>`;
      for (let day = 1; day <= daysInMonth; day++) {
        const cellDate = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
        const key = cellDate.toDateString();
        const dayEvents = eventsByDay[key] || [];
        html += `<div class="cal-cell ${key === todayStr ? 'today' : ''}" data-day="${day}">
          <div class="date-num">${day}</div>
          ${dayEvents.slice(0, 3).map(ev => `<div class="cal-event-chip" data-event="${ev.id}" title="${esc(ev.title)}" style="${ev.user_color ? `background:${esc(ev.user_color)}22;color:${esc(ev.user_color)}` : ''}">${esc(ev.user_name ? ev.user_name.split(' ')[0] + ': ' : '')}${esc(ev.title)}</div>`).join('')}
          ${dayEvents.length > 3 ? `<div class="muted" style="font-size:.72em">+${dayEvents.length - 3} more</div>` : ''}
        </div>`;
      }
      grid.innerHTML = html;

      grid.querySelectorAll('[data-event]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const ev = events.find(x => x.id === el.dataset.event);
        showEventDetail(ev);
      }));
      grid.querySelectorAll('.cal-cell[data-day]').forEach(el => el.addEventListener('click', () => {
        const day = parseInt(el.dataset.day, 10);
        const d = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day, 9, 0);
        openEventForm(d);
      }));
    }

    function showEventDetail(ev) {
      const isWO = ev.type === 'work_order';
      openModal(ev.title, `
        <p class="muted">${fmtDateTime(ev.start_at)} – ${fmtDateTime(ev.end_at)}</p>
        ${ev.user_name ? `<p>👤 ${esc(ev.user_name)}</p>` : ''}
        ${ev.description ? `<p>${esc(ev.description)}</p>` : ''}
        ${isWO ? `<button class="btn btn-primary btn-sm" id="goToWo">Open work order</button>` : ''}
        ${!isWO ? `<div class="modal-actions"><button class="btn btn-danger btn-sm" id="delEv">Delete</button></div>` : ''}
      `, (body) => {
        if (isWO) body.querySelector('#goToWo').addEventListener('click', () => { closeModal(); navigate(`/work-orders/${ev.work_order_id}`); });
        const delBtn = body.querySelector('#delEv');
        if (delBtn) delBtn.addEventListener('click', async () => {
          try { await API.del(`/api/calendar/${ev.id}`); closeModal(); toast('Event removed', 'success'); load(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
    }

    function openEventForm(prefillDate) {
      const startDefault = prefillDate ? prefillDate.toISOString().slice(0, 16) : '';
      const endDefault = prefillDate ? new Date(prefillDate.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16) : '';
      openModal('Add Calendar Event', `
        <form id="evForm">
          ${isStaff ? `<div class="field"><label>Assign to</label><select name="user_id" required>
            ${teamUsers.map(tu => `<option value="${tu.id}" ${tu.id === selectedUserId ? 'selected' : ''}>${esc(tu.name)} (${tu.role})</option>`).join('')}
          </select></div>` : `<input type="hidden" name="user_id" value="${u.id}">`}
          <div class="field"><label>Title</label><input name="title" required placeholder="e.g. Site visit, leave, team meeting"></div>
          <div class="field"><label>Description</label><textarea name="description" placeholder="Optional details"></textarea></div>
          <div class="form-row">
            <div class="field"><label>Starts</label><input type="datetime-local" name="start_at" value="${startDefault}" required></div>
            <div class="field"><label>Ends</label><input type="datetime-local" name="end_at" value="${endDefault}" required></div>
          </div>
          <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Add to calendar</button></div>
        </form>
      `, (body) => {
        body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
        body.querySelector('#evForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          try {
            await API.post('/api/calendar', {
              user_id: fd.get('user_id'), title: fd.get('title'), description: fd.get('description'),
              start_at: new Date(fd.get('start_at')).toISOString(), end_at: new Date(fd.get('end_at')).toISOString()
            });
            closeModal(); toast('Event added', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }

    document.getElementById('prevMonth').addEventListener('click', () => { viewMonth.setMonth(viewMonth.getMonth() - 1); load(); });
    document.getElementById('nextMonth').addEventListener('click', () => { viewMonth.setMonth(viewMonth.getMonth() + 1); load(); });
    document.getElementById('addEventBtn').addEventListener('click', () => openEventForm(null));
    if (isStaff) document.getElementById('userSelect').addEventListener('change', (e) => { selectedUserId = e.target.value; load(); });

    await load();
  });
})();
