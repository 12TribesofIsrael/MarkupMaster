/* Fetch wrapper: JSON in/out, PIN-gate handling (401 → prompt → /login → retry). */
window.API = (() => {
  async function ensurePin() {
    const pin = prompt('This app is PIN-protected. Enter your PIN:');
    if (pin == null) return false;
    const r = await fetch('/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    return r.ok;
  }

  async function req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    let resp = await fetch(url, opts);
    if (resp.status === 401 && await ensurePin()) resp = await fetch(url, opts);
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ error: `Server error ${resp.status}` }));
      throw new Error(e.error || `Server error ${resp.status}`);
    }
    return resp.json();
  }

  return {
    get: u => req('GET', u),
    post: (u, b) => req('POST', u, b),
    patch: (u, b) => req('PATCH', u, b),
    del: u => req('DELETE', u),
  };
})();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showError(msg) {
  const banner = document.getElementById('errorBanner');
  document.getElementById('errorText').textContent = msg;
  banner.style.display = 'flex';
  window.scrollTo(0, 0);
}
function clearError() {
  document.getElementById('errorBanner').style.display = 'none';
}

/* Days from today to an ISO date (negative = past). */
function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d)) return null;
  return Math.round((d - new Date()) / 86400000);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
