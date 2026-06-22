// public/js/api.js
const API = (() => {
  function token() { return localStorage.getItem('ops_token'); }
  function setToken(t) { t ? localStorage.setItem('ops_token', t) : localStorage.removeItem('ops_token'); }

  async function req(method, path, body, isForm) {
    const headers = {};
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let payload = body;
    if (body && !isForm) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body (e.g. PDF) */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed: ' + res.status));
      err.status = res.status;
      err.data = data; // full response body, for routes that send extra fallback data alongside an error
      throw err;
    }
    return data;
  }

  return {
    token, setToken,
    get: (path) => req('GET', path),
    post: (path, body, isForm) => req('POST', path, body, isForm),
    put: (path, body) => req('PUT', path, body),
    del: (path) => req('DELETE', path),
  };
})();
