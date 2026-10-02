// Election detail: schedule, instructions and the full candidate list.
document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  navRender(user);
  markCurrentNav();

  const host = document.getElementById('election-detail');
  render(host, skeleton('Loading election…'));
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    render(host, html`<div class="alert error" role="alert">No election was specified.</div>`);
    return;
  }

  let data;
  try {
    data = await api.get(`/api/elections/${encodeURIComponent(id)}`);
  } catch (err) {
    render(host, html`<div class="alert error" role="alert">${err.message}</div>`);
    return;
  }

  const { election, positions, candidates, eligible, voted } = data;
  const canVote = election.display_status === 'open' && eligible && !voted;
  const tz = election.timezone || 'UTC';

  const header = html`
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${statusBadge(election.display_status)}
        <span class="meta">${STATUS_META[election.display_status] ? STATUS_META[election.display_status].hint : ''}</span>
      </div>
      <h2 style="margin:10px 0 6px">${election.title}</h2>
      <p>${election.description || ''}</p>
      <div class="grid two" style="margin-top:12px">
        <div><p class="meta" style="margin:0">Voting opens</p><p><strong>${fmtDateTz(election.starts_at, tz)}</strong></p></div>
        <div><p class="meta" style="margin:0">Voting closes</p><p><strong>${fmtDateTz(election.ends_at, tz)}</strong></p></div>
      </div>
      <p class="meta">Times shown in ${tz}.${election.display_status === 'open'
        ? html` Closing in <span class="countdown" data-end="${election.ends_at}"></span>.`
        : ''}</p>
      ${election.instructions ? html`
        <h4 style="margin-bottom:4px">How to vote</h4>
        <div class="card" style="background:#f8fafc;box-shadow:none"><p class="meta" style="white-space:pre-wrap;margin:0">${election.instructions}</p></div>` : ''}
      <p style="margin-bottom:0">
        ${voted
          ? html`<span class="badge status-closed"><span aria-hidden="true">✓</span> You have voted in this election</span>`
          : eligible
            ? html`<span class="badge status-open"><span aria-hidden="true">✓</span> You are eligible to vote</span>`
            : html`<span class="badge status-draft"><span aria-hidden="true">–</span> You are not eligible for this election</span>`}
      </p>
      <p style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0">
        ${canVote ? html`<a class="btn gold" href="/ballot.html?id=${election.id}">VOTE NOW</a>` : ''}
        ${election.status === 'published' ? html`<a class="btn" href="/results.html?id=${election.id}">View results</a>` : ''}
        <a class="btn ghost" href="/dashboard.html">Back to dashboard</a>
      </p>
    </div>`;

  if (!positions.length) {
    render(host, html`${header}${emptyState('No positions configured', 'The Returning Officer has not added any positions to this election yet.')}`);
    return;
  }

  const sections = positions.map((p) => {
    const list = candidates.filter((c) => c.position_id === p.id);
    const rule = p.min_select === p.max_select
      ? `Select ${p.min_select === 1 ? 'ONE' : p.min_select} candidate`
      : `Select between ${p.min_select} and ${p.max_select} candidates`;
    return html`
      <section class="card" aria-labelledby="position-${p.id}">
        <h3 id="position-${p.id}">${p.title}</h3>
        <p class="meta">${p.description || ''}</p>
        <p class="meta"><strong>${rule}.</strong> ${p.is_mandatory
          ? 'This position is mandatory — you must make a selection.'
          : 'This position is optional — you may abstain.'}</p>
        ${list.length ? list.map((c) => html`
          <div class="candidate">
            ${avatar(c, 84)}
            <div style="min-width:0">
              <h3 style="margin:0 0 4px">${c.name}</h3>
              <p class="meta" style="margin:0 0 2px">
                ${[c.department, c.faculty, c.level ? `${c.level} Level` : '', c.affiliation].filter(Boolean).join(' · ')}
              </p>
              ${c.student_id ? html`<p class="meta" style="margin:0 0 6px">Student ID: ${c.student_id}</p>` : ''}
              ${c.bio ? html`<p style="margin:0 0 8px">${c.bio}</p>` : ''}
              <button type="button" class="btn small ghost" data-manifesto="${c.id}">View manifesto</button>
            </div>
          </div>`) : html`<p class="meta">No candidates have been added for this position yet.</p>`}
      </section>`;
  });

  render(host, html`${header}<h3>Positions and candidates</h3>${sections}`);
  const countdownEl = $('.countdown');
  if (countdownEl) countdown(countdownEl, countdownEl.dataset.end);

  // Manifesto dialogs are attached in JS, never as inline HTML attributes.
  const byId = Object.fromEntries(candidates.map((c) => [String(c.id), c]));
  onDelegated(host, 'click', '[data-manifesto]', (ev, btn) => {
    const candidate = byId[btn.dataset.manifesto];
    if (candidate) showManifesto(candidate);
  });
});
