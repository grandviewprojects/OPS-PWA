// public/js/jobcards.js
(() => {
  const { route, navigate, openModal, closeModal, toast, esc } = App;

  function genId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function downloadPdf(cardId, reference) {
    try {
      const res = await fetch(`/api/job-cards/${cardId}/pdf`, { headers: { Authorization: 'Bearer ' + API.token() } });
      if (!res.ok) throw new Error('Could not download PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Job-Card-${reference || ''}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'error'); }
  }

  route('/job-cards/:id', async ({ id }) => {
    const view = document.getElementById('view');
    const data = await API.get(`/api/job-cards/${id}`);
    const card = data.job_card;
    const u = App.state.user;
    const canEdit = u.role === 'admin' || u.role === 'operational';
    const wasFinalized = card.status === 'finalized';

    let sections = [];
    let photos = [];
    try { sections = JSON.parse(card.sections || '[]'); } catch (e) {}
    try { photos = JSON.parse(card.photos || '[]'); } catch (e) {}
    sections.forEach((s) => { if (!s.id) s.id = genId(); if (!Array.isArray(s.photos)) s.photos = []; });

    view.innerHTML = `
      <a href="#/work-orders/${card.work_order_id}" class="muted">&larr; Back to work order</a>

      <div class="card mt12">
        <div class="letterhead">
          ${App.state.settings.company_logo ? `<img src="/uploads/logo/${esc((App.state.settings.company_logo || '').split('/').pop())}">` : '<div></div>'}
          <div class="co-info">
            <div class="co-name">${esc(App.state.settings.company_name || 'Your Company')}</div>
            <div class="co-meta">${esc(App.state.settings.company_address || '')}</div>
            <div class="co-meta">${esc(App.state.settings.company_phone || '')} ${App.state.settings.company_email ? '· ' + esc(App.state.settings.company_email) : ''}</div>
          </div>
        </div>
        <h2 style="margin-top:0">Job Card</h2>
        ${!canEdit ? `<p class="muted">This is prepared by operations to help you get the job done — what needs fixing, and what to bring.</p>`
          : wasFinalized
            ? `<p class="muted">Finalized ${App.fmtDateTime(card.finalized_at)}. You can still edit — click "Update &amp; Regenerate PDF" to refresh it.</p>`
            : `<p class="muted">Fill in the tasks and materials needed, then finalize to generate a PDF for the onsite team.</p>`}

        ${canEdit ? `
          <div class="field"><label>Title</label><input id="titleInput" value="${esc(card.title || '')}"></div>
          <div class="field"><label>Overview of work</label><textarea id="summaryInput" placeholder="General description of the job">${esc(card.summary || '')}</textarea></div>
          <div class="field"><label>General materials &amp; tools needed</label><textarea id="materialsInput" placeholder="e.g. Ladder, safety harness, caulking gun, drop sheets">${esc(card.general_materials || '')}</textarea></div>
          <div class="field"><label>Special instructions / site access</label><textarea id="instructionsInput" placeholder="e.g. Gate code, pets on site, parking instructions">${esc(card.special_instructions || '')}</textarea></div>
        ` : `
          ${card.summary ? `<div class="field"><label>Overview of work</label><p>${esc(card.summary)}</p></div>` : ''}
          ${card.general_materials ? `<div class="privacy-note" style="background:var(--brand-light);margin-bottom:12px"><strong>🧰 General materials &amp; tools needed</strong><br>${esc(card.general_materials)}</div>` : ''}
          ${card.special_instructions ? `<div class="privacy-note" style="background:var(--warning-light);margin-bottom:12px"><strong>⚠️ Special instructions / site access</strong><br>${esc(card.special_instructions)}</div>` : ''}
        `}

        <h3 class="mt16">Tasks</h3>
        <div id="sectionsWrap"></div>
        ${canEdit ? `<button class="btn btn-sm" id="addSectionBtn">+ Add task</button>` : ''}

        <h3 class="mt16">Overview Photos <span class="muted" style="font-size:.7em;font-weight:400">(general site photos not tied to a specific task)</span></h3>
        ${canEdit ? `<input type="file" id="photoInput" accept="image/*" multiple capture="environment">
        <p class="muted" style="font-size:.8em">Select photos from your camera or photo library.</p>` : ''}
        <div class="photo-grid" id="photoGrid"></div>

        ${canEdit ? `
          <hr class="sep">
          <div class="flex" style="flex-wrap:wrap;gap:10px">
            <button class="btn btn-primary" id="saveDraftBtn">Save changes</button>
            <button class="btn ${wasFinalized ? '' : 'btn-danger'}" id="finalizeBtn">${wasFinalized ? '🔄 Update & Regenerate PDF' : '✅ Finalize job card'}</button>
            ${wasFinalized ? `<button class="btn btn-sm" id="dlBtn2">⬇ Download PDF</button>` : ''}
          </div>
        ` : wasFinalized ? `<hr class="sep"><button class="btn btn-primary" id="dlBtn2">⬇ Download PDF</button>` : ''}
      </div>
    `;

    function renderSectionPhotos(sectionId) {
      const grid = document.getElementById(`secPhotos-${sectionId}`);
      if (!grid) return;
      const section = sections.find((s) => s.id === sectionId);
      const secPhotos = (section && section.photos) || [];
      grid.innerHTML = secPhotos.map((p) => `
        <div class="photo-thumb">
          <img src="${esc(p.url)}" alt="">
          <a class="download-photo" href="${esc(p.url)}" download title="Download photo">⬇</a>
          ${canEdit ? `<input data-sec-cap="${esc(p.id)}" data-sec-id="${esc(sectionId)}" value="${esc(p.caption || '')}" placeholder="Caption">
          <button class="remove-photo" data-remove-sec-photo="${esc(p.id)}">&times;</button>` : (p.caption ? `<div style="padding:4px 6px;font-size:.72em;border-top:1px solid var(--border)">${esc(p.caption)}</div>` : '')}
        </div>
      `).join('') || `<p class="muted" style="font-size:.8em">No photos for this task.</p>`;
      if (canEdit) {
        grid.querySelectorAll('[data-sec-cap]').forEach((inp) => inp.addEventListener('change', async (e) => {
          const sec = sections.find((s) => s.id === e.target.dataset.secId);
          const p = sec && sec.photos.find((x) => x.id === e.target.dataset.secCap);
          if (p) p.caption = e.target.value;
          await saveDraft(false);
        }));
        grid.querySelectorAll('[data-remove-sec-photo]').forEach((btn) => btn.addEventListener('click', async (e) => {
          try {
            await API.del(`/api/job-cards/${id}/photos/${e.target.dataset.removeSecPhoto}`);
            if (section) section.photos = section.photos.filter((p) => p.id !== e.target.dataset.removeSecPhoto);
            renderSectionPhotos(sectionId);
            toast('Photo removed', 'success');
          } catch (err) { toast(err.message, 'error'); }
        }));
      }
    }

    function renderSections() {
      const wrap = document.getElementById('sectionsWrap');
      wrap.innerHTML = sections.map((s, i) => `
        <div class="section-block">
          ${canEdit ? `
            <div class="field"><label>Heading</label><input data-sec="${i}" data-f="heading" value="${esc(s.heading || '')}"></div>
            <div class="field"><label>What needs fixing</label><textarea data-sec="${i}" data-f="notes">${esc(s.notes || '')}</textarea></div>
            <div class="field"><label>Materials needed for this task</label><textarea data-sec="${i}" data-f="materials" placeholder="e.g. 3x roof tiles, roofing adhesive">${esc(s.materials || '')}</textarea></div>
          ` : `
            <div style="font-weight:600">${i + 1}. ${esc(s.heading || 'Untitled task')}</div>
            ${s.notes ? `<p style="margin:6px 0">${esc(s.notes)}</p>` : ''}
            ${s.materials ? `<p style="margin:6px 0"><strong style="color:var(--warning)">Materials needed:</strong> ${esc(s.materials)}</p>` : ''}
          `}
          <label style="display:block;font-size:.8em;font-weight:600;color:var(--muted);margin-bottom:5px">Photos for this task</label>
          ${canEdit ? `<input type="file" data-sec-photo-input="${esc(s.id)}" accept="image/*" multiple capture="environment">` : ''}
          <div class="photo-grid" id="secPhotos-${esc(s.id)}" style="margin-top:8px"></div>
          ${canEdit ? `<button class="btn btn-sm btn-danger mt8" data-remove-sec="${i}">Remove task</button>` : ''}
        </div>
      `).join('') || `<p class="muted">${canEdit ? 'No tasks yet — click "+ Add task" below to start.' : 'No tasks listed yet.'}</p>`;

      sections.forEach((s) => renderSectionPhotos(s.id));

      if (canEdit) {
        wrap.querySelectorAll('[data-sec]').forEach((inp) => inp.addEventListener('input', (e) => {
          sections[+e.target.dataset.sec][e.target.dataset.f] = e.target.value;
        }));
        wrap.querySelectorAll('[data-remove-sec]').forEach((btn) => btn.addEventListener('click', (e) => {
          sections.splice(+e.target.dataset.removeSec, 1); renderSections();
        }));
        wrap.querySelectorAll('[data-sec-photo-input]').forEach((inp) => inp.addEventListener('change', async (e) => {
          const files = Array.from(e.target.files || []);
          if (!files.length) return;
          const sectionId = e.target.dataset.secPhotoInput;
          toast('Uploading photo(s)…');
          try {
            await saveDraft(false);
            const fd = new FormData();
            files.forEach((f) => fd.append('photos', f));
            fd.append('section_id', sectionId);
            const res = await API.post(`/api/job-cards/${id}/photos`, fd, true);
            const freshSections = JSON.parse(res.job_card.sections);
            const updated = freshSections.find((s) => s.id === sectionId);
            const local = sections.find((s) => s.id === sectionId);
            if (local && updated) local.photos = updated.photos;
            renderSectionPhotos(sectionId);
            toast('Photo(s) added to task', 'success');
          } catch (err) { toast(err.message, 'error'); }
          e.target.value = '';
        }));
      }
    }

    function renderPhotos() {
      const grid = document.getElementById('photoGrid');
      grid.innerHTML = photos.map((p) => `
        <div class="photo-thumb">
          <img src="${esc(p.url)}" alt="">
          <a class="download-photo" href="${esc(p.url)}" download title="Download photo">⬇</a>
          ${canEdit ? `<input data-cap="${esc(p.id)}" value="${esc(p.caption || '')}" placeholder="Caption">
          <button class="remove-photo" data-remove-photo="${esc(p.id)}">&times;</button>` : (p.caption ? `<div style="padding:4px 6px;font-size:.72em;border-top:1px solid var(--border)">${esc(p.caption)}</div>` : '')}
        </div>
      `).join('') || `<p class="muted">No photos yet.</p>`;
      if (canEdit) {
        grid.querySelectorAll('[data-cap]').forEach((inp) => inp.addEventListener('change', async (e) => {
          const p = photos.find((x) => x.id === e.target.dataset.cap);
          if (p) p.caption = e.target.value;
          await saveDraft(false);
        }));
        grid.querySelectorAll('[data-remove-photo]').forEach((btn) => btn.addEventListener('click', async (e) => {
          try {
            await API.del(`/api/job-cards/${id}/photos/${e.target.dataset.removePhoto}`);
            photos = photos.filter((p) => p.id !== e.target.dataset.removePhoto);
            renderPhotos();
            toast('Photo removed', 'success');
          } catch (err) { toast(err.message, 'error'); }
        }));
      }
    }

    renderSections();
    renderPhotos();

    async function saveDraft(showToast = true) {
      if (!canEdit) return;
      try {
        await API.put(`/api/job-cards/${id}`, {
          title: document.getElementById('titleInput').value,
          summary: document.getElementById('summaryInput').value,
          general_materials: document.getElementById('materialsInput').value,
          special_instructions: document.getElementById('instructionsInput').value,
          sections
        });
        if (showToast) toast('Changes saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    }

    if (canEdit) {
      document.getElementById('addSectionBtn').addEventListener('click', () => {
        sections.push({ id: genId(), heading: '', notes: '', materials: '', photos: [] });
        renderSections();
      });

      document.getElementById('photoInput').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const fd = new FormData();
        files.forEach((f) => fd.append('photos', f));
        toast('Uploading photo(s)…');
        try {
          const res = await API.post(`/api/job-cards/${id}/photos`, fd, true);
          photos = JSON.parse(res.job_card.photos);
          renderPhotos();
          toast('Photo(s) added', 'success');
        } catch (err) { toast(err.message, 'error'); }
        e.target.value = '';
      });

      document.getElementById('saveDraftBtn').addEventListener('click', () => saveDraft(true));

      document.getElementById('finalizeBtn').addEventListener('click', () => {
        const title = wasFinalized ? 'Update & Regenerate PDF' : 'Finalize Job Card';
        const body = wasFinalized
          ? `<p>This saves your latest changes and regenerates the PDF, and lets the onsite team know it's been updated.</p>
             <div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="confirmFinalize">Update PDF now</button></div>`
          : `<p>This generates a branded PDF for the onsite team and notifies whoever is assigned to this work order.</p>
             <p class="muted">You can still come back and edit this job card later if needed.</p>
             <div class="modal-actions"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-danger" id="confirmFinalize">Finalize now</button></div>`;
        openModal(title, body, (el) => {
          el.querySelector('[data-close-modal]').addEventListener('click', closeModal);
          el.querySelector('#confirmFinalize').addEventListener('click', async () => {
            try {
              await saveDraft(false);
              await API.post(`/api/job-cards/${id}/finalize`, {});
              closeModal();
              toast(wasFinalized ? 'PDF updated' : 'Job card finalized — PDF generated', 'success');
              navigate(`/work-orders/${card.work_order_id}`);
            } catch (err) { toast(err.message, 'error'); }
          });
        });
      });

      const dl2 = document.getElementById('dlBtn2');
      if (dl2) dl2.addEventListener('click', (e) => { e.preventDefault(); downloadPdf(id, ''); });
    } else {
      const dl2 = document.getElementById('dlBtn2');
      if (dl2) dl2.addEventListener('click', (e) => { e.preventDefault(); downloadPdf(id, ''); });
    }
  });
})();
