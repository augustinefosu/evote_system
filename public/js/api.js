// Shared client library: API access, safe templating, dialogs and charts.
// Loaded by every page. Kept free of inline handlers so the strict
// Content-Security-Policy (script-src 'self') can stay enabled.

/* ------------------------------------------------------------------ *
 * Safe HTML templating
 *
 * Every value interpolated into markup is HTML-escaped by default. This is
 * the single most important defence here: election titles, candidate names,
 * manifestos and audit-log details are all attacker-influenced text that
 * must never be parsed as markup. Compose nested templates freely; only
 * `raw()` bypasses escaping, and it exists solely so a template can embed
 * the output of another template (or generated SVG) verbatim.
 * ------------------------------------------------------------------ */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
function interpolate(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value && value.__html) return value.__html;
  return esc(value);
}
function raw(markup) {
  return { __html: String(markup ?? '') };
}
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return raw(out);
}
// Convenience for the common "set an element's contents" case.
function render(target, content) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return null;
  el.innerHTML = (content && content.__html !== undefined) ? content.__html : String(content ?? '');
  return el;
}

/* ------------------------------------------------------------------ *
 * API access
 * ------------------------------------------------------------------ */
function readCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function parseResponse(res) {
  let data = {};
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    // If the server (or a gateway) did not return a JSON error, turn the
    // status into something a student can act on instead of "Request failed
    // (502)". The API's own JSON message always wins when present.
    const fallback = {
      502: 'The service is temporarily unavailable. Please try again shortly.',
      503: 'The service is temporarily unavailable. Please try again shortly.',
      504: 'The service timed out. Please try again shortly.',
    }[res.status] || `Request failed (${res.status})`;
    const err = new Error(data.error || fallback);
    err.status = res.status;
    throw err;
  }
  return data;
}

const api = {
  async req(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    if (opts.body !== undefined && !isForm && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    // Double-submit CSRF token, required for cookie-authenticated writes.
    const csrf = readCookie('evs_csrf');
    if (csrf && !SAFE_METHODS.has((opts.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = csrf;

    const res = await fetch(path, { credentials: 'same-origin', headers, ...opts });
    return parseResponse(res);
  },
  // Multipart uploads (candidate photos, CSV imports). Content-Type is left to
  // the browser so the boundary is generated correctly, but the CSRF token is
  // still required for cookie-authenticated sessions.
  async upload(path, method, formData) {
    const headers = {};
    const csrf = readCookie('evs_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    return parseResponse(await fetch(path, { method, body: formData, credentials: 'same-origin', headers }));
  },
  get: (p) => api.req(p),
  post: (p, b) => api.req(p, { method: 'POST', body: b || {} }),
  put: (p, b) => api.req(p, { method: 'PUT', body: b || {} }),
  del: (p) => api.req(p, { method: 'DELETE' }),
  me: () => api.req('/api/auth/me'),
  async logout() {
    try { await api.req('/api/auth/logout', { method: 'POST' }); } catch { /* clear locally regardless */ }
    localStorage.removeItem('evs_user');
    location.href = '/login.html';
  },
};

/* ------------------------------------------------------------------ *
 * Session helpers
 * ------------------------------------------------------------------ */
async function requireAuth(roles) {
  // Normalise to an array: a bare string would let String.includes match any
  // role as a substring ('superadmin'.includes('admin') is true).
  const allowed = roles === undefined || roles === null ? null : (Array.isArray(roles) ? roles : [roles]);
  try {
    const { user } = await api.me();
    localStorage.setItem('evs_user', JSON.stringify(user));
    if (allowed && !allowed.includes(user.role)) {
      location.href = homeFor(user.role);
      return null;
    }
    return user;
  } catch {
    location.href = '/login.html';
    return null;
  }
}
function homeFor(role) {
  if (role === 'superadmin') return '/superadmin.html';
  if (role === 'admin') return '/admin.html';
  return '/dashboard.html';
}
function navRender(user) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  if (!user) {
    render(nav, html`<a href="/login.html">Login</a><a href="/register.html" class="primary">Register</a>`);
    return;
  }
  const links = [
    { href: '/dashboard.html', label: 'Dashboard' },
    { href: '/results.html', label: 'Results' },
  ];
  if (user.role === 'admin' || user.role === 'superadmin') links.push({ href: '/admin.html', label: 'Elections' });
  if (user.role === 'superadmin') links.push({ href: '/superadmin.html', label: 'Super Admin' });
  const anchors = links.map((l) => html`<a href="${l.href}">${l.label}</a>`);
  const signOut = html`<button type="button" data-action="logout">Sign out (${user.name.split(' ')[0]})</button>`;
  render(nav, html`${anchors}${signOut}`);
  nav.querySelector('[data-action="logout"]').addEventListener('click', () => api.logout());
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */
function fmtDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtDateTz(value, tz) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  try {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz || undefined });
  } catch {
    return d.toLocaleString();
  }
}
function plural(n, one, many) {
  return `${Number(n).toLocaleString()} ${Number(n) === 1 ? one : (many || one + 's')}`;
}
function pct(part, whole) {
  if (!whole) return '0.0';
  return ((part * 100) / whole).toFixed(1);
}

// Live countdown to a closing time. Updates the element every second and
// announces the finished state in text, not colour alone.
function countdown(el, endIso) {
  if (!el) return;
  const finish = () => { el.textContent = 'Voting has closed'; };
  const tick = () => {
    const ms = new Date(endIso).getTime() - Date.now();
    if (ms <= 0) return finish();
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    el.textContent = d > 0 ? `${d}d ${h}h ${m}m ${s}s` : `${h}h ${m}m ${s}s`;
  };
  tick();
  setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ *
 * Status — never communicated by colour alone; each state carries a
 * symbol and a word so it survives greyscale and screen readers.
 * ------------------------------------------------------------------ */
const STATUS_META = {
  draft: { label: 'Draft', symbol: '✎', hint: 'Not open for voting' },
  open: { label: 'Open', symbol: '●', hint: 'Voting is open now' },
  closed: { label: 'Closed', symbol: '■', hint: 'Voting has ended' },
  published: { label: 'Results published', symbol: '★', hint: 'Results are public' },
};
function statusBadge(status) {
  const meta = STATUS_META[status] || { label: status, symbol: '•', hint: '' };
  return html`<span class="badge status-${status}"><span aria-hidden="true">${meta.symbol}</span> ${meta.label}</span>`;
}

/* ------------------------------------------------------------------ *
 * Feedback: inline messages, toasts and modal dialogs
 * ------------------------------------------------------------------ */
function showMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) { toast(text, ok ? 'ok' : 'error'); return; }
  el.className = 'alert ' + (ok ? 'ok' : 'error');
  el.textContent = text;
  el.style.display = 'block';
  el.setAttribute('role', ok ? 'status' : 'alert');
}

let toastHost = null;
function toast(text, kind = 'ok', timeout = 5000) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    toastHost.setAttribute('aria-atomic', 'false');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

/**
 * Modal dialog. Returns a promise resolving to true/false for confirm, or
 * with the supplied content for informational dialogs. Replaces window.alert
 * and window.confirm, which are inaccessible and block the page.
 */
function dialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, showCancel = true }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'modal-title');

    const heading = document.createElement('h2');
    heading.id = 'modal-title';
    heading.textContent = title;

    const content = document.createElement('div');
    content.className = 'modal-body';
    if (body instanceof Node) content.appendChild(body);
    else content.textContent = body || '';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      resolve(value);
    };
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn ' + (danger ? 'danger' : 'gold');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => finish(true));

    actions.appendChild(confirmBtn);
    if (showCancel) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn ghost';
      cancelBtn.textContent = cancelLabel;
      cancelBtn.addEventListener('click', () => finish(false));
      actions.appendChild(cancelBtn);
    }
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      if (ev.key === 'Tab') {
        // Keep focus inside the dialog while it is open.
        const focusable = actions.querySelectorAll('button');
        if (!focusable.length) return;
        const first = focusable[0], lastEl = focusable[focusable.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); lastEl.focus(); }
        else if (!ev.shiftKey && document.activeElement === lastEl) { ev.preventDefault(); first.focus(); }
      }
    };

    box.append(heading, content, actions);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

function confirmAction(title, message, confirmLabel = 'Confirm', danger = false) {
  return dialog({ title, body: message, confirmLabel, danger });
}

// Renders a candidate manifesto in a readable dialog instead of an alert().
function showManifesto(candidate) {
  const body = document.createElement('div');
  const heading = document.createElement('p');
  heading.className = 'meta';
  heading.textContent = [candidate.department, candidate.faculty, candidate.level ? `${candidate.level} Level` : '', candidate.affiliation]
    .filter(Boolean).join(' · ');
  const text = document.createElement('p');
  text.className = 'manifesto';
  text.textContent = candidate.manifesto && candidate.manifesto.trim()
    ? candidate.manifesto
    : 'This candidate has not published a manifesto.';
  body.append(heading, text);
  return dialog({ title: `Manifesto — ${candidate.name}`, body, confirmLabel: 'Close', showCancel: false });
}

/* ------------------------------------------------------------------ *
 * Candidate photos
 *
 * Rendered locally as an initials avatar. Previously this called out to a
 * third-party avatar service, which leaked every page view to an external
 * host and broke on air-gapped university networks.
 * ------------------------------------------------------------------ */
function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || '?';
}
function avatar(candidate, size = 56) {
  if (candidate.photo_url) {
    return html`<img class="avatar" src="${candidate.photo_url}" width="${size}" height="${size}"
      alt="Photograph of ${candidate.name}" loading="lazy">`;
  }
  return html`<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.6)}px"
    role="img" aria-label="No photograph available for ${candidate.name}">${initialsOf(candidate.name)}</span>`;
}

/* ------------------------------------------------------------------ *
 * Charts
 *
 * Small dependency-free SVG bar charts. Avoids a third-party charting CDN,
 * so the results dashboard renders on an offline campus network and stays
 * within the Content-Security-Policy.
 * ------------------------------------------------------------------ */
function barChart({ title, items, total, unit = 'votes' }) {
  const rows = items.filter((i) => i);
  if (!rows.length) return html`<p class="meta">No data to chart yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const bars = rows.map((r) => {
    const share = (r.value * 100) / max;
    const shareOfTotal = total ? (r.value * 100) / total : 0;
    return html`
      <div class="chart-row">
        <div class="chart-label" title="${r.label}">${r.label}</div>
        <div class="chart-track">
          <div class="chart-fill${r.leader ? ' chart-fill-leader' : ''}" style="width:${Math.max(share, r.value > 0 ? 2 : 0).toFixed(2)}%"></div>
        </div>
        <div class="chart-value">
          <strong>${Number(r.value).toLocaleString()}</strong>
          <span class="meta">${shareOfTotal.toFixed(1)}%</span>
        </div>
      </div>`;
  });
  return html`
    <figure class="chart" role="group" aria-label="${title}">
      <figcaption class="chart-caption">${title}</figcaption>
      ${bars}
    </figure>`;
}

function turnoutRing(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = 54, c = 2 * Math.PI * r;
  return html`
    <svg class="ring" viewBox="0 0 140 140" role="img"
      aria-label="Voter turnout ${clamped.toFixed(2)} percent">
      <circle cx="70" cy="70" r="${r}" class="ring-track"></circle>
      <circle cx="70" cy="70" r="${r}" class="ring-fill"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - clamped / 100)).toFixed(1)}"></circle>
      <text x="70" y="66" class="ring-value" text-anchor="middle">${clamped.toFixed(1)}%</text>
      <text x="70" y="88" class="ring-caption" text-anchor="middle">turnout</text>
    </svg>`;
}

/* ------------------------------------------------------------------ *
 * Small DOM utilities used by the page scripts
 * ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Trailing-edge debounce for search-as-you-type, so typing a student name
// issues one request instead of one per keystroke.
function debounce(fn, wait = 250) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Delegated click handling: keeps behaviour out of HTML attributes, which is
// both CSP-safe and free of attribute-injection risk.
function onDelegated(root, eventName, selector, handler) {
  root.addEventListener(eventName, (ev) => {
    const target = ev.target.closest(selector);
    if (target && root.contains(target)) handler(ev, target);
  });
}

function emptyState(title, detail) {
  return html`<div class="empty"><p class="empty-title">${title}</p><p class="meta">${detail}</p></div>`;
}
function skeleton(text = 'Loading…') {
  return html`<p class="loading" role="status">${text}</p>`;
}

// Marks the page heading as the current page for assistive technology.
function markCurrentNav() {
  const here = location.pathname.split('/').pop() || 'index.html';
  $$('#nav a').forEach((a) => {
    if (a.getAttribute('href') === `/${here}`) a.setAttribute('aria-current', 'page');
  });
}
