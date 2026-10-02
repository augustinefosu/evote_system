// Results dashboard. Aggregates only — the API has no endpoint that can
// return an individual voter's selections, and nothing here attempts to.
document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  navRender(user);
  markCurrentNav();

  const isAdmin = user.role === 'admin' || user.role === 'superadmin';
  const host = document.getElementById('results');
  const id = new URLSearchParams(location.search).get('id');

  if (!id) return renderIndex(isAdmin);
  return renderResults(id, isAdmin);
});

async function renderIndex(isAdmin) {
  const host = document.getElementById('results');
  render(host, skeleton('Loading elections…'));
  let elections = [];
  try {
    elections = await api.get('/api/elections');
  } catch (err) {
    return render(host, html`<div class="alert error" role="alert">${err.message}</div>`);
  }
  const visible = elections.filter((e) => e.status === 'published' || isAdmin);
  if (!visible.length) {
    return render(host, html`
      <div class="card"><h2>Results</h2></div>
      ${emptyState('No results to show', isAdmin
        ? 'Create and publish an election to see results here.'
        : 'Results appear here once the Returning Officer has published them.')}`);
  }
  const cards = visible.map((e) => html`
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${statusBadge(e.display_status)}</div>
      <h3 style="margin:8px 0 4px">${e.title}</h3>
      <p class="meta">${e.votes_cast} vote(s) recorded${e.published_at ? ` · published ${fmtDate(e.published_at)}` : ''}</p>
      <a class="btn small" href="/results.html?id=${e.id}">Open results</a>
    </div>`);
  render(host, html`<div class="card"><h2>Results</h2></div><div class="grid">${cards}</div>`);
}

async function renderResults(id, isAdmin) {
  const host = document.getElementById('results');
  render(host, skeleton('Loading results…'));
  let r;
  try {
    r = await api.get(`/api/elections/${encodeURIComponent(id)}/results`);
  } catch (err) {
    return render(host, html`
      <div class="card">
        <h2>Results unavailable</h2>
        <p role="alert">${err.message}</p>
        <a class="btn ghost" href="/results.html">All elections</a>
      </div>`);
  }

  const { election, positions, candidates, perCandidate, perPosition, eligibleTotal, votesCast, turnout } = r;
  const notCast = Math.max(0, eligibleTotal - votesCast);

  const summary = html`
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${statusBadge(election.display_status)}
        ${election.published_at ? html`<span class="meta">Published ${fmtDate(election.published_at)}</span>` : ''}
      </div>
      <h2 style="margin:10px 0 4px">${election.title}</h2>
      <p class="meta">${election.description || ''}</p>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:20px;align-items:center;margin-top:16px">
        <div>
          <div class="grid three">
            <div><div class="kpi">${Number(eligibleTotal).toLocaleString()}</div><div class="meta">Total eligible voters</div></div>
            <div><div class="kpi">${Number(votesCast).toLocaleString()}</div><div class="meta">Votes cast</div></div>
            <div><div class="kpi">${Number(notCast).toLocaleString()}</div><div class="meta">Not yet voted</div></div>
          </div>
          <div class="bar" style="margin-top:14px" role="img"
            aria-label="Voter turnout ${turnout} percent">
            <div style="width:${Math.max(0, Math.min(100, turnout))}%"></div>
          </div>
          <p class="meta" style="margin-top:6px">Turnout: <strong>${turnout}%</strong></p>
        </div>
        ${turnoutRing(turnout)}
      </div>
      ${isAdmin ? html`<p style="margin-bottom:0"><a class="btn small ghost" href="/api/admin/elections/${election.id}/results.csv">Download results (CSV)</a></p>` : ''}
    </div>`;

  if (!positions.length) {
    return render(host, html`${summary}${emptyState('No positions', 'This election has no positions configured.')}`);
  }

  const sections = positions.map((p) => {
    const stats = perPosition[p.id] || { votes: 0, abstentions: 0, leaders: [], tied: false };
    const list = candidates.filter((c) => c.position_id === p.id);
    const leaderIds = stats.leaders || [];
    const items = list.map((c) => ({
      label: c.name,
      value: perCandidate[c.id] || 0,
      leader: leaderIds.includes(c.id),
    })).sort((a, b) => b.value - a.value);

    const winnerNote = !stats.votes
      ? html`<p class="meta">No votes were cast for this position.</p>`
      : stats.tied
        ? html`<p class="meta"><strong>Tied</strong> — ${leaderIds.length} candidates share the highest tally. A run-off may be required.</p>`
        : html`<p class="meta">Leading candidate: <strong>${list.find((c) => c.id === leaderIds[0]) ? list.find((c) => c.id === leaderIds[0]).name : ''}</strong></p>`;

    return html`
      <section class="card" aria-labelledby="res-position-${p.id}">
        <h3 id="res-position-${p.id}">${p.title}</h3>
        <p class="meta">${stats.votes} valid selection(s) · ${stats.abstentions} abstention(s)</p>
        ${barChart({ title: `${p.title} — votes`, items, total: stats.votes })}
        ${winnerNote}
        <details style="margin-top:10px">
          <summary class="meta" style="cursor:pointer">Candidate details</summary>
          <div class="table-scroll" style="margin-top:8px">
            <table>
              <caption class="visually-hidden">Vote totals for ${p.title}</caption>
              <thead><tr><th scope="col">Candidate</th><th scope="col">Department</th><th scope="col">Affiliation</th><th scope="col">Votes</th><th scope="col">Share</th></tr></thead>
              <tbody>${list.map((c) => {
                const v = perCandidate[c.id] || 0;
                return html`<tr>
                  <td>${c.name}</td>
                  <td>${c.department || '—'}</td>
                  <td>${c.affiliation || '—'}</td>
                  <td>${v.toLocaleString()}</td>
                  <td>${pct(v, stats.votes)}%</td>
                </tr>`;
              })}</tbody>
            </table>
          </div>
        </details>
      </section>`;
  });

  render(host, html`
    ${summary}
    <h3>Results by position</h3>
    ${sections}
    <p class="meta">
      These are aggregate totals only. Individual ballot choices are stored anonymously, are never linked to a
      voter, and cannot be retrieved by any user of this system — including administrators.
    </p>`);
}
