// public/js/portal.js
(async () => {
  try {
    const res = await fetch('/api/portal/branding');
    const branding = await res.json();
    if (branding.company_name) document.getElementById('companyName').textContent = branding.company_name;
    if (branding.brand_color) document.documentElement.style.setProperty('--brand', branding.brand_color);
    if (branding.company_logo) {
      const img = document.createElement('img');
      img.src = '/uploads/logo/' + branding.company_logo.split('/').pop();
      document.getElementById('portalHeader').prepend(img);
    }
  } catch (e) { /* branding is optional */ }

  document.getElementById('portalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/portal/work-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      document.getElementById('formCard').innerHTML = `
        <div class="success-box">
          <div class="big">✅</div>
          <h2>Request received</h2>
          <p>Your reference number is <strong>${data.reference}</strong>.</p>
          <p class="muted">Our team will be in touch shortly to schedule your work.</p>
        </div>`;
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Submit request';
      alert(err.message);
    }
  });
})();
