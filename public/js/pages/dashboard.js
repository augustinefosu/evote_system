// Student dashboard: identity, election status, countdowns and notifications.
document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  navRender(user);
  markCurrentNav();

  const verification = user.verified
    ? html`<span class="badge status-open"><span aria-hidden="true">✓</span> Verified</span>`
    : html`<span class="badge status-draft"><span aria-hidden="true">!</span> Not verified</span>`;

  render('who', html`
    <h2 id="greeting">Welcome, ${user.name}</h2>
    <p class="meta">${user.student_id || 'No student ID'} · ${user.faculty || '—'} · ${user.department || '—'} · ${user.level ? `${user.level} Level` : '—'}</p>
    <p>${verification}
      ${user.verified ? '' : html` <a href="/verify.html">Verify your account to vote</a>`}</p>`);

  render('notices', '');
  await loadNotifications();
  await loadElections();
});

async function loadNotifications() {
  const host = document.getElementById('notices');
  if (!host) return;
  let items = [];
  try { items = await api.get('/api/notifications'); } catch { return; }
  if (!items.length) return;
  const unread = items.filter((n) => !n.read_at);
  const rows = items.slice(0, 5).map((n) => html`
    <li>
      <strong>${n.title}</strong>
      <span class="meta"> · ${fmtDate(n.created_at)}${n.read_at ? '' : ' · new'}</span>
      ${n.body ? html`<div class="meta">${n.body}</div>` : ''}
    </li>`);
  render(host, html`
    <div class="card" style="margin-bottom:16px">
      <h3>Notifications ${unread.length ? html`<span class="badge status-draft">${unread.length} new</span>` : ''}</h3>
      <ul class="meta" style="line-height:1.7;padding-left:18px;margin:0">${rows}</ul>
    </div>`);
  if (unread.length) {
    api.post('/api/notifications/read', { ids: unread.map((n) => n.id) }).catch(() => {});
  }
}

async function loadElections() {
  const host = document.getElementById('election-list');
  render(host, skeleton('Loading elections…'));
  let elections = [];
  try {
    elections = await api.get('/api/elections');
  } catch (err) {
    render(host, html`<div class="alert error" role="alert">${err.message}</div>`);
    return;
  }
  if (!elections.length) {
    render(host, emptyState('No elections yet', 'When the Returning Officer publishes an election you are eligible for, it will appear here.'));
    return;
  }

  // Reference codes for elections already voted in. Fetched individually
  // because they are the only per-voter artefact the API will ever return.
  const refs = {};
  await Promise.all(elections.filter((e) => e.voted).map(async (e) => {
    try { refs[e.id] = (await api.get(`/api/elections/${e.id}/my-receipt`)).reference_code; } catch { /* ignore */ }
  }));

  const cards = elections.map((e) => {
    const canVote = e.display_status === 'open' && e.eligible && !e.voted;
    const state = e.voted
      ? html`<span class="badge status-closed"><span aria-hidden="true">✓</span> Already voted</span>`
      : e.eligible
        ? html`<span class="badge status-open"><span aria-hidden="true">✓</span> Eligible</span>`
        : html`<span class="badge status-draft"><span aria-hidden="true">–</span> Not eligible</span>`;
    return html`
      <div class="card">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          ${statusBadge(e.display_status)}${state}
        </div>
        <h3 style="margin:6px 0">${e.title}</h3>
        <p class="meta">${e.description || ''}</p>
        <p class="meta">Voting closes: <strong>${fmtDate(e.ends_at)}</strong>
          ${e.display_status === 'open' ? html` · <span class="countdown" data-end="${e.ends_at}"></span>` : ''}</p>
        <p class="meta">${plural(e.votes_cast, 'vote')} recorded so far.</p>
        ${refs[e.id] ? html`<p class="meta">Your confirmation reference: <code class="ref" style="font-size:14px">${refs[e.id]}</code></p>` : ''}
        <p style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0">
          <a class="btn small ghost" href="/election.html?id=${e.id}">View election</a>
          ${canVote ? html`<a class="btn gold small" href="/ballot.html?id=${e.id}">VOTE NOW</a>` : ''}
          ${e.status === 'published' ? html`<a class="btn small" href="/results.html?id=${e.id}">View results</a>` : ''}
        </p>
      </div>`;
  });
  render(host, html`${cards}`);
  $$('.countdown').forEach((el) => countdown(el, el.dataset.end));
}

// Account settings: change password.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('password-form');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const current = document.getElementById('current-password').value;
    const next = document.getElementById('new-password').value;
    if (next.length < 8) {
      showMsg('password-msg', 'New password must be at least 8 characters.', false);
      return;
    }
    try {
      const r = await api.post('/api/auth/change-password', { current_password: current, new_password: next });
      showMsg('password-msg', r.message, true);
      form.reset();
      toast('Password changed', 'ok');
    } catch (err) {
      showMsg('password-msg', err.message, false);
    }
  });
});
