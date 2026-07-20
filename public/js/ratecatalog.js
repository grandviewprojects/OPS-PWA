// public/js/ratecatalog.js
// The "Rate Catalog" tab — manage reusable material & labour prices that get
// pulled in when building a quote.
(() => {
  const { route, openModal, closeModal, toast, esc } = App;
  const money = (v) => 'R' + (Number(v) || 0).toFixed(2);

  route('/rate-catalog', async () => {
    const view = document.getElementById('view');
    view.innerHTML = `<div class="card"><div class="flex"><div class="spinner"></div> Loading…</div></div>`;

    async function load() {
      let items = [];
      try { items = (await API.get('/api/rate-items')).rate_items; } catch (e) { toast(e.message, 'error'); }
      const materials = items.filter(i => i.kind === 'material');
      const labour = items.filter(i => i.kind === 'labour');

      view.innerHTML = `
        <div class="section-title">
          <h2>Rate Catalog</h2>
          <button class="btn btn-primary" id="newRateBtn">+ Add item</button>
        </div>
        <p class="muted" style="margin-top:-6px">Saved materials &amp; labour rates. These appear in the quick-add list when you build a quote on a work order.</p>

        <h3 style="margin-top:16px">🧱 Materials (${materials.length})</h3>
        <div class="card" style="padding:0">${rateTable(materials)}</div>

        <h3 style="margin-top:16px">👷 Labour (${labour.length})</h3>
        <div class="card" style="padding:0">${rateTable(labour)}</div>
      `;

      document.getElementById('newRateBtn').addEventListener('click', () => openRateForm(null, load));
      view.querySelectorAll('[data-rate]').forEach(row =>
        row.addEventListener('click', () => {
          const item = items.find(i => i.id === row.dataset.rate);
          if (item) openRateForm(item, load);
        })
      );
    }

    function rateTable(items) {
      if (!items.length) return '<div class="empty-state" style="padding:16px">Nothing here yet.</div>';
      return `<table class="simple" style="width:100%;font-size:.9em">
        <thead><tr><th>Name</th><th>Unit</th><th style="text-align:right">Unit price</th></tr></thead>
        <tbody>${items.map(i => `
          <tr data-rate="${i.id}" style="cursor:pointer">
            <td>${esc(i.name)}${i.notes ? `<div class="meta">${esc(i.notes)}</div>` : ''}</td>
            <td>${esc(i.unit || '—')}</td>
            <td style="text-align:right">${money(i.unit_price)}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    }

    function openRateForm(item, onDone) {
      openModal(item ? 'Edit rate item' : 'Add rate item', `
        <form id="rateForm">
          <div class="field"><label>Name</label><input name="name" value="${item ? esc(item.name) : ''}" required></div>
          <div class="field"><label>Type</label><select name="kind">
            <option value="material" ${!item || item.kind === 'material' ? 'selected' : ''}>Material</option>
            <option value="labour" ${item && item.kind === 'labour' ? 'selected' : ''}>Labour</option>
          </select></div>
          <div class="form-row">
            <div class="field"><label>Unit <span class="muted">(each, bag, hour…)</span></label><input name="unit" value="${item ? esc(item.unit || '') : ''}"></div>
            <div class="field"><label>Unit price (R)</label><input name="unit_price" type="number" step="0.01" value="${item ? item.unit_price : ''}" required></div>
          </div>
          <div class="field"><label>Notes <span class="muted">(optional)</span></label><input name="notes" value="${item ? esc(item.notes || '') : ''}"></div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal>Cancel</button>
            ${item ? '<button type="button" class="btn btn-danger" id="delRateBtn">Delete</button>' : ''}
            <button class="btn btn-primary" type="submit">${item ? 'Save' : 'Add'}</button>
          </div>
        </form>
      `, (body) => {
        body.querySelector('[data-close-modal]').addEventListener('click', closeModal);
        body.querySelector('#rateForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = {
            name: fd.get('name'), kind: fd.get('kind'), unit: fd.get('unit'),
            unit_price: parseFloat(fd.get('unit_price')) || 0, notes: fd.get('notes'),
          };
          try {
            if (item) await API.put(`/api/rate-items/${item.id}`, payload);
            else await API.post('/api/rate-items', payload);
            closeModal(); toast('Saved', 'success'); onDone();
          } catch (err) { toast(err.message, 'error'); }
        });
        const del = body.querySelector('#delRateBtn');
        if (del) del.addEventListener('click', async () => {
          if (!confirm('Delete this rate item?')) return;
          try { await API.del(`/api/rate-items/${item.id}`); closeModal(); toast('Deleted', 'success'); onDone(); }
          catch (err) { toast(err.message, 'error'); }
        });
      });
    }

    await load();
  });
})();
