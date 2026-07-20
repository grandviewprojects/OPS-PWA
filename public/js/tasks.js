// public/js/tasks.js
(() => {
  const { route, navigate, openModal, closeModal, toast, esc, fmtDateTime, statusLabel } = App;

  const STATUS_FLOW = ['pending', 'in_progress', 'completed', 'cancelled'];

  function timerInfo(task) {
    if (!task.due_at || task.status === 'completed' || task.status === 'cancelled') return null;
    const due = new Date(task.due_at).getTime();
    const diffMs = due - Date.now();
    const hrs = Math.round(diffMs / 3600000);
    if (diffMs < 0) return { cls: 'sla-overdue', label: `Overdue by ${Math.abs(hrs)}h` };
    if (hrs <= 24) return { cls: 'sla-warning', label: `Due in ${hrs}h` };
    return { cls: 'sla-ok', label: `Due in ${Math.round(hrs / 24)}d ${hrs % 24}h` };
  }

  function taskRow(t) {
    const timer = timerInfo(t);
    return `<div class="list-item" data-task="${t.id}">
      <div>
        <div class="title">${esc(t.title)}</div>
        <div class="meta">${t.assignee_name ? '👤 ' + esc(t.assignee_name) : ''}${t.creator_name && t.creator_name !== t.assignee_name ? ' · delegated by ' + esc(t.creator_name) : ''}</div>
      </div>
      <div class="text-right">
        <span class="badge badge-${t.status === 'in_progress' ? 'in_progress' : t.status === 'completed' ? 'completed' : t.status === 'cancelled' ? 'cancelled' : 'new'}">${statusLabel(t.status)}</span>
        ${timer ? `<div class="mt8"><span class="sla-chip ${timer.cls}">${timer.label}</span></div>` : ''}
      </div>
    </div>`;
  }

  route('/tasks', async () => {
    const u = App.state.user;
    const isAdmin = u.role === 'admin';
    const view = document.getElementById('view');
    view.innerHTML = `<div class="card"><div class="flex"><div class="spinner"></div> Loading…</div></div>`;

    let teamUsers = [];
    if (isAdmin) teamUsers = (await API.get('/api/users')).users.filter((x) => ['operational', 'marketing'].includes(x.role) && x.active !== 0);

    view.innerHTML = `
      <div class="section-title">
        <h2>Tasks</h2>
        <div class="flex" style="gap:8px">
          <select id="taskSort" class="btn btn-sm" style="padding:6px 10px">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="due">By deadline</option>
          </select>
          <button class="btn btn-primary" id="newTaskBtn">+ ${isAdmin ? 'Delegate task' : 'New task'}</button>
        </div>
      </div>
      <div class="card" id="taskList"><div class="flex"><div class="spinner"></div> Loading…</div></div>
    `;

    let currentSort = 'newest';
    async function load() {
      const { tasks } = await API.get('/api/tasks?sort=' + currentSort);
      const list = document.getElementById('taskList');
      list.innerHTML = tasks.length ? tasks.map(taskRow).join('') : `<div class="empty-state">No tasks ${isAdmin ? 'yet' : 'assigned to you yet'}.</div>`;
      list.querySelectorAll('[data-task]').forEach((el) => el.addEventListener('click', () => openTaskDetail(el.dataset.task)));
    }

    document.getElementById('taskSort').addEventListener('change', (e) => { currentSort = e.target.value; load(); });

    function openNewTaskForm() {
      openModal(isAdmin ? 'Delegate a Task' : 'New Task', `
        <form id="taskForm">
          <div class="field"><label>Title</label><input name="title" required></div>
          <div class="field"><label>Description</label><textarea name="description"></textarea></div>
          ${isAdmin ? `<div class="field"><label>Assign to</label><select name="assigned_to" required>
            <option value="">Choose a team member…</option>
            ${teamUsers.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.role})</option>`).join('')}
          </select></div>` : ''}
          <div class="field"><label>Deadline / timer <span class="muted">(optional)</span></label><input type="datetime-local" name="due_at"></div>
          <div class="modal-actions"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Create</button></div>
        </form>
      `, (body) => {
        body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
        body.querySelector('#taskForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = { title: fd.get('title'), description: fd.get('description') };
          if (isAdmin) payload.assigned_to = fd.get('assigned_to');
          const dueRaw = fd.get('due_at');
          if (dueRaw) payload.due_at = new Date(dueRaw).toISOString();
          try {
            await API.post('/api/tasks', payload);
            closeModal(); toast('Task created', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }

    async function openTaskDetail(taskId) {
      const { task, activity } = await API.get(`/api/tasks/${taskId}`);
      const canManage = isAdmin || task.assigned_to === u.id;
      const timer = timerInfo(task);

      openModal(task.title, `
        ${task.description ? `<p>${esc(task.description)}</p>` : ''}
        <table class="simple">
          <tr><th>Assigned to</th><td>${esc(task.assignee_name || '—')}</td></tr>
          <tr><th>Delegated by</th><td>${esc(task.creator_name || '—')}</td></tr>
          <tr><th>Status</th><td><span class="badge badge-${task.status === 'in_progress' ? 'in_progress' : task.status === 'completed' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'new'}">${statusLabel(task.status)}</span></td></tr>
        </table>
        ${timer ? `<p><span class="sla-chip ${timer.cls}">${timer.label}</span></p>` : ''}
        ${canManage ? `
          <div class="field"><label>Title</label><input id="taskTitleInput" value="${esc(task.title)}"></div>
          <div class="field"><label>Description</label><textarea id="taskDescInput">${esc(task.description || '')}</textarea></div>
          <div class="form-row">
            <div class="field"><label>Status</label><select id="taskStatusSelect">
              ${STATUS_FLOW.map((s) => `<option value="${s}" ${s === task.status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
            </select></div>
            <div class="field"><label>Deadline / timer</label><input type="datetime-local" id="taskDueInput" value="${task.due_at ? task.due_at.slice(0, 16) : ''}"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="saveTaskBtn">Save changes</button>
          ${isAdmin ? `<button class="btn btn-danger btn-sm" id="deleteTaskBtn">Delete task</button>` : ''}
        ` : ''}
        <hr class="sep">
        <h3 style="font-size:.9em">Activity</h3>
        <div>${activity.map((a) => `<div class="list-item" style="cursor:default;padding:8px 0"><div><div style="font-size:.88em">${esc(a.message)}</div><div class="meta">${fmtDateTime(a.created_at)}</div></div></div>`).join('') || '<p class="muted">No activity yet.</p>'}</div>
      `, (body) => {
        const saveBtn = body.querySelector('#saveTaskBtn');
        if (saveBtn) saveBtn.addEventListener('click', async () => {
          const status = body.querySelector('#taskStatusSelect').value;
          const dueRaw = body.querySelector('#taskDueInput').value;
          const titleEl = body.querySelector('#taskTitleInput');
          const descEl = body.querySelector('#taskDescInput');
          const payload = { status, due_at: dueRaw ? new Date(dueRaw).toISOString() : null };
          if (titleEl && titleEl.value.trim()) payload.title = titleEl.value.trim();
          if (descEl) payload.description = descEl.value;
          try {
            await API.put(`/api/tasks/${taskId}`, payload);
            closeModal(); toast('Task updated', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
        const delBtn = body.querySelector('#deleteTaskBtn');
        if (delBtn) delBtn.addEventListener('click', async () => {
          if (!confirm('Delete this task permanently?')) return;
          try {
            await API.del(`/api/tasks/${taskId}`);
            closeModal(); toast('Task deleted', 'success'); load();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }

    document.getElementById('newTaskBtn').addEventListener('click', openNewTaskForm);
    await load();
  });
})();
