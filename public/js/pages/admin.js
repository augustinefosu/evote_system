// Election administration: elections, positions, candidates, voters, activity.
//
// Rendering strategy: each pane's shell (filters, forms, tables) is built once
// and cached, then only the inner list slots are repainted on filter changes.
// That keeps typed input, file pickers and keyboard focus intact, and keeps
// delegated listeners from being registered twice.
document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth(['admin', 'superadmin']);
  if (!user) return;
  navRender(user);
  markCurrentNav();

  const state = {
    stats: null,
    elections: [],
    tab: 'elections',
    el: { q: '', status: '' },
    pos: { electionId: null, q: '', positionId: '' },
    vot: { q: '', faculty: '', department: '', level: '', verified: '', active: '', electionId: null },
  };
  const built = {};
  // Latest election detail (positions + candidates) for the editors.
  const detailCache = { positions: [], candidates: [] };
  const pane = (name) => document.getElementById(`pane-${name}`);

  /* ------------------------------------------------------------------ *
   * Shell, tabs and data loading
   * ------------------------------------------------------------------ */
  function showTab(name) {
    state.tab = name;
    $$('.tabs button').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
    });
    ['elections', 'positions', 'voters', 'activity'].forEach((t) => {
      pane(t).classList.toggle('hidden', t !== name);
    });
    ({ elections: paintElections, positions: paintPositions, voters: paintVoters, activity: paintActivity }[name])();
  }

  onDelegated(document, 'click', '.tabs button', (ev, btn) => showTab(btn.dataset.tab));
  // Roving arrow-key navigation across the tablist.
  onDelegated(document, 'keydown', '.tabs button', (ev, btn) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(ev.key in keys)) return;
    const tabs = $$('.tabs button');
    const next = tabs[(tabs.indexOf(btn) + keys[ev.key] + tabs.length) % tabs.length];
    ev.preventDefault();
    next.focus();
    showTab(next.dataset.tab);
  });

  function adminMessage(text, ok = true) {
    render('admin-message', html`<div class="alert ${ok ? 'ok' : 'error'}" role="${ok ? 'status' : 'alert'}">${text}</div>`);
    if (ok) toast(text, 'ok');
  }
  function reportError(err) {
    render('admin-message', html`<div class="alert error" role="alert">${err.message}</div>`);
  }

  async function refresh() {
    render('admin-message', '');
    try {
      [state.stats, state.elections] = await Promise.all([
        api.get('/api/admin/stats'),
        api.get('/api/admin/elections'),
      ]);
    } catch (err) {
      return reportError(err);
    }
    if (!state.pos.electionId) state.pos.electionId = state.elections[0] ? state.elections[0].id : null;
    if (!state.vot.electionId) state.vot.electionId = state.elections[0] ? state.elections[0].id : null;
    paintKpis();
    showTab(state.tab);
  }

  function paintKpis() {
    const s = state.stats;
    const open = state.elections.filter((e) => e.display_status === 'open');
    const upcoming = state.elections.filter((e) => e.status === 'draft');
    const completed = state.elections.filter((e) => e.status === 'published' || e.display_status === 'closed');
    const avgTurnout = open.length
      ? open.reduce((sum, e) => sum + (e.eligible_count ? (e.votes_cast * 100) / e.eligible_count : 0), 0) / open.length
      : 0;
    const card = (value, meta) => html`<div class="card"><div class="kpi">${value}</div><div class="meta">${meta}</div></div>`;
    render('kpis', html`
      ${card(s.voters, 'Registered voters')}
      ${card(open.length, 'Active elections')}
      ${card(upcoming.length, 'Upcoming / draft')}
      ${card(completed.length, 'Completed')}
      ${card(s.candidates, 'Candidates')}
      ${card(s.votes, 'Votes recorded')}
      ${card(`${avgTurnout.toFixed(1)}%`, 'Avg turnout (open elections)')}
      ${card(s.elections, 'Elections total')}`);
  }

  function toLocalInput(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const statusOptions = (selected) => ['draft', 'open', 'closed', 'published']
    .map((s) => html`<option value="${s}" ${selected === s ? 'selected' : ''}>${STATUS_META[s].label}</option>`);

  /* ------------------------------------------------------------------ *
   * Elections pane
   * ------------------------------------------------------------------ */
  function buildElections() {
    render(pane('elections'), html`
      <h3>Elections</h3>
      <div class="filterbar">
        <div class="field">
          <label for="election-search">Search elections</label>
          <input id="election-search" type="search" placeholder="Title or description" value="${state.el.q}">
        </div>
        <div class="field">
          <label for="election-status">Filter by status</label>
          <select id="election-status"><option value="">All statuses</option>${statusOptions(state.el.status)}</select>
        </div>
      </div>
      <div id="election-list-slot"></div>

      <div class="card" style="margin-top:16px;box-shadow:none;background:#f8fafc">
        <h4>Create election</h4>
        <form id="create-election-form">
          <div class="grid two">
            <div class="field">
              <label for="new-title">Title <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="new-title" required maxlength="200" placeholder="2026 SRC GENERAL ELECTION">
            </div>
            <div class="field">
              <label for="new-status">Initial status</label>
              <select id="new-status">
                <option value="draft">Draft — not visible to voters</option>
                <option value="open">Open — voting live immediately</option>
              </select>
            </div>
          </div>
          <div class="field"><label for="new-description">Description</label><textarea id="new-description" rows="2"></textarea></div>
          <div class="field"><label for="new-instructions">Voting instructions</label><textarea id="new-instructions" rows="3"></textarea></div>
          <div class="grid three">
            <div class="field">
              <label for="new-start">Starts <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="new-start" type="datetime-local" required>
            </div>
            <div class="field">
              <label for="new-end">Ends <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="new-end" type="datetime-local" required>
            </div>
            <div class="field">
              <label for="new-tz">Time zone</label>
              <input id="new-tz" value="Africa/Accra" placeholder="Africa/Accra">
              <p class="hint">IANA name, e.g. <code>Africa/Accra</code>. Times are stored in UTC and displayed in this zone.</p>
            </div>
          </div>
          <button type="submit" class="btn">Create election</button>
        </form>
      </div>
      <div id="edit-election-slot"></div>`);

    const search = $('#election-search');
    search.addEventListener('input', debounce((ev) => { state.el.q = ev.target.value; paintElections(); }, 200));
    $('#election-status').addEventListener('change', (ev) => { state.el.status = ev.target.value; paintElections(); });

    $('#create-election-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      try {
        await api.post('/api/admin/elections', {
          title: $('#new-title').value.trim(),
          description: $('#new-description').value,
          instructions: $('#new-instructions').value,
          starts_at: $('#new-start').value,
          ends_at: $('#new-end').value,
          timezone: $('#new-tz').value.trim() || 'UTC',
          status: $('#new-status').value,
        });
        form.reset();
        $('#new-tz').value = 'Africa/Accra';
        adminMessage('Election created.');
        await refresh();
      } catch (err) { reportError(err); }
    });

    onDelegated(pane('elections'), 'click', '[data-action]', async (ev, btn) => {
      if (btn.closest('#edit-election-slot')) return;
      const { action, id, status } = btn.dataset;
      try {
        if (action === 'status') {
          const label = STATUS_META[status].label.toLowerCase();
          if (status === 'open' || status === 'published') {
            const body = status === 'published'
              ? 'Publishing makes the results visible to every student and cannot be undone.'
              : 'Opening this election notifies every eligible voter that voting has started.';
            if (!await confirmAction(`${STATUS_META[status].label} this election?`, body, `Yes, ${label}`)) return;
          }
          await api.post(`/api/admin/elections/${id}/status`, { status });
          adminMessage(`Election ${label}.`);
          await refresh();
        } else if (action === 'edit') {
          await showEditForm(id);
        } else if (action === 'delete') {
          const ok = await confirmAction(
            'Delete this election?',
            'This permanently removes the election, its positions and its candidates. Deletion is refused if any votes have been recorded.',
            'Delete', true,
          );
          if (!ok) return;
          await api.del(`/api/admin/elections/${id}`);
          adminMessage('Election deleted.');
          await refresh();
        }
      } catch (err) { reportError(err); }
    });
  }

  function paintElections() {
    if (!built.elections) { built.elections = true; buildElections(); }
    const term = state.el.q.toLowerCase();
    const rows = state.elections.filter((e) => {
      if (term && !`${e.title} ${e.description || ''}`.toLowerCase().includes(term)) return false;
      if (state.el.status && e.status !== state.el.status && e.display_status !== state.el.status) return false;
      return true;
    });

    const slot = $('#election-list-slot');
    if (!rows.length) {
      return render(slot, emptyState('No elections match', 'Adjust the search or status filter, or create an election below.'));
    }
    const trs = rows.map((e) => {
      const locked = e.votes_cast > 0;
      return html`
        <tr>
          <th scope="row">
            ${e.title}
            ${locked ? html`<br><span class="meta">${e.votes_cast} vote(s) recorded — voting window locked</span>` : ''}
          </th>
          <td>${statusBadge(e.display_status)}</td>
          <td class="meta">
            ${fmtDateTz(e.starts_at, e.timezone)}<br>
            to ${fmtDateTz(e.ends_at, e.timezone)}<br>
            <span class="meta">${e.timezone || 'UTC'}</span>
          </td>
          <td>
            ${e.votes_cast} / ${e.eligible_count || '—'}<br>
            <span class="meta">${e.position_count} position(s), ${e.candidate_count} candidate(s)</span>
          </td>
          <td>
            <div class="row-actions">
              ${e.status === 'draft' ? html`<button type="button" class="btn small" data-action="status" data-id="${e.id}" data-status="open">Open</button>` : ''}
              ${e.display_status === 'open' ? html`<button type="button" class="btn small" data-action="status" data-id="${e.id}" data-status="closed">Close</button>` : ''}
              ${e.status === 'closed' ? html`<button type="button" class="btn small gold" data-action="status" data-id="${e.id}" data-status="published">Publish results</button>` : ''}
              <button type="button" class="btn small ghost" data-action="edit" data-id="${e.id}">Edit<span class="visually-hidden"> ${e.title}</span></button>
              <button type="button" class="btn small danger" data-action="delete" data-id="${e.id}">Delete<span class="visually-hidden"> ${e.title}</span></button>
              <a class="btn small ghost" href="/results.html?id=${e.id}">Results<span class="visually-hidden"> for ${e.title}</span></a>
              <a class="btn small ghost" href="/api/admin/elections/${e.id}/results.csv">CSV</a>
            </div>
          </td>
        </tr>`;
    });
    render(slot, html`
      <p class="meta" role="status">${plural(rows.length, 'election')} shown.</p>
      <div class="table-scroll">
        <table>
          <caption class="visually-hidden">Elections, their status and turnout</caption>
          <thead>
            <tr>
              <th scope="col">Title</th><th scope="col">Status</th><th scope="col">Period</th>
              <th scope="col">Turnout</th><th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </div>`);
  }

  async function showEditForm(id) {
    const slot = $('#edit-election-slot');
    const summary = state.elections.find((e) => String(e.id) === String(id));
    if (!summary) return;
    const { election: e } = await api.get(`/api/elections/${encodeURIComponent(id)}`);
    const locked = summary.votes_cast > 0;
    render(slot, html`
      <div class="card" style="margin-top:16px;box-shadow:none;background:#eef4ff">
        <h4>Edit election #${e.id} — ${e.title}</h4>
        ${locked ? html`<p class="meta">${summary.votes_cast} vote(s) have been recorded, so the voting window is locked to preserve the integrity of the ballot record. Titles, descriptions and instructions can still be corrected.</p>` : ''}
        <form id="edit-election-form">
          <div class="field"><label for="edit-title">Title</label><input id="edit-title" value="${e.title}" maxlength="200" required></div>
          <div class="field"><label for="edit-description">Description</label><textarea id="edit-description" rows="2">${e.description || ''}</textarea></div>
          <div class="field"><label for="edit-instructions">Voting instructions</label><textarea id="edit-instructions" rows="3">${e.instructions || ''}</textarea></div>
          <div class="grid three">
            <div class="field">
              <label for="edit-start">Starts</label>
              <input id="edit-start" type="datetime-local" value="${toLocalInput(e.starts_at)}" ${locked ? 'disabled' : ''}>
              ${locked ? html`<p class="hint">Locked because votes exist.</p>` : ''}
            </div>
            <div class="field">
              <label for="edit-end">Ends</label>
              <input id="edit-end" type="datetime-local" value="${toLocalInput(e.ends_at)}" ${locked ? 'disabled' : ''}>
            </div>
            <div class="field"><label for="edit-tz">Time zone</label><input id="edit-tz" value="${e.timezone || 'UTC'}" required></div>
          </div>
          <button type="submit" class="btn small">Save changes</button>
          <button type="button" class="btn small ghost" id="cancel-edit">Cancel</button>
        </form>
      </div>`);
    $('#cancel-edit').addEventListener('click', () => render(slot, ''));
    $('#edit-election-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = {
        title: $('#edit-title').value.trim(),
        description: $('#edit-description').value,
        instructions: $('#edit-instructions').value,
        timezone: $('#edit-tz').value.trim() || 'UTC',
      };
      if (!locked) {
        payload.starts_at = $('#edit-start').value;
        payload.ends_at = $('#edit-end').value;
      }
      try {
        await api.put(`/api/admin/elections/${e.id}`, payload);
        adminMessage('Election updated.');
        render(slot, '');
        await refresh();
      } catch (err) { reportError(err); }
    });
    $('#edit-title').focus();
  }

  /* ------------------------------------------------------------------ *
   * Positions and candidates pane
   * ------------------------------------------------------------------ */
  async function paintPositions() {
    const host = pane('positions');
    if (!state.elections.length) {
      return render(host, emptyState('No elections yet', 'Create an election before adding positions and candidates.'));
    }
    if (!built.positions) { built.positions = true; buildPositions(); }
    const slot = $('#position-list-slot');
    render(slot, skeleton('Loading positions…'));

    let detail;
    try {
      detail = await api.get(`/api/elections/${encodeURIComponent(state.pos.electionId)}`);
    } catch (err) { return reportError(err); }
    const { positions, candidates } = detail;
    detailCache.positions = positions;
    detailCache.candidates = candidates;

    const positionRows = positions.map((p) => html`
      <tr>
        <th scope="row">#${p.id} ${p.title}</th>
        <td>${p.min_select === p.max_select ? p.min_select : `${p.min_select}–${p.max_select}`}</td>
        <td>${p.is_mandatory ? 'Mandatory' : 'Optional'}</td>
        <td>${candidates.filter((c) => c.position_id === p.id).length}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn small ghost" data-action="edit-position" data-id="${p.id}">Edit<span class="visually-hidden"> ${p.title}</span></button>
            <button type="button" class="btn small danger" data-action="delete-position" data-id="${p.id}">Remove<span class="visually-hidden"> ${p.title}</span></button>
          </div>
        </td>
      </tr>`);

    render(slot, html`
      <h4>Positions</h4>
      ${positions.length ? html`
        <div class="table-scroll">
          <table>
            <caption class="visually-hidden">Positions in this election</caption>
            <thead><tr><th scope="col">Position</th><th scope="col">Select</th><th scope="col">Rule</th><th scope="col">Candidates</th><th scope="col">Actions</th></tr></thead>
            <tbody>${positionRows}</tbody>
          </table>
        </div>` : emptyState('No positions yet', 'Add the first position below, then add candidates to it.')}
      <div id="position-editor"></div>`);

    const filtered = candidates.filter((c) => {
      if (state.pos.positionId && String(c.position_id) !== String(state.pos.positionId)) return false;
      if (!state.pos.q) return true;
      const term = state.pos.q.toLowerCase();
      return `${c.name} ${c.student_id || ''} ${c.department || ''} ${c.affiliation || ''}`.toLowerCase().includes(term);
    });
    const candidateRows = filtered.map((c) => html`
      <tr>
        <th scope="row">
          ${avatar(c, 32)}
          <span>${c.name}</span>
        </th>
        <td class="meta">${c.student_id || '—'}</td>
        <td>${(positions.find((p) => p.id === c.position_id) || {}).title || '—'}</td>
        <td class="meta">${[c.department, c.level].filter(Boolean).join(' · ') || '—'}</td>
        <td class="meta">${c.affiliation || '—'}</td>
        <td>${c.manifesto && c.manifesto.trim() ? 'Published' : 'None'}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn small ghost" data-action="edit-candidate" data-id="${c.id}">Edit<span class="visually-hidden"> ${c.name}</span></button>
            <button type="button" class="btn small danger" data-action="delete-candidate" data-id="${c.id}">Remove<span class="visually-hidden"> ${c.name}</span></button>
          </div>
        </td>
      </tr>`);

    const candSlot = $('#candidate-list-slot');
    if (!filtered.length) {
      render(candSlot, emptyState('No candidates match', 'Adjust the search or position filter, or add a candidate below.'));
    } else {
      render(candSlot, html`
        <p class="meta" role="status">${plural(filtered.length, 'candidate')} shown.</p>
        <div class="table-scroll">
          <table>
            <caption class="visually-hidden">Candidates in this election</caption>
            <thead><tr>
              <th scope="col">Candidate</th><th scope="col">Student ID</th><th scope="col">Position</th>
              <th scope="col">Department</th><th scope="col">Affiliation</th><th scope="col">Manifesto</th><th scope="col">Actions</th>
            </tr></thead>
            <tbody>${candidateRows}</tbody>
          </table>
        </div>`);
    }
    // Clear any open edit form. Guarded: the slot lives in the pane shell, so
    // a missing element must not abort the rest of this render.
    const candEditor = $('#candidate-editor');
    if (candEditor) candEditor.innerHTML = '';

    // The position dropdown is the source of truth for the candidate form too.
    const positionSelect = $('#cand-position-select');
    if (positionSelect && positionSelect.options.length !== positions.length) {
      positionSelect.innerHTML = positions.map((p) => `<option value="${Number(p.id)}">${esc(p.title)}</option>`).join('');
    }

    // Keep the "filter by position" dropdown in step with the real position
    // list. It is built once with only the "All positions" option, so without
    // this the filter could never narrow anything. The markup is compared
    // rather than the option count so a same-size change still refreshes.
    const filterSelect = $('#cand-position');
    if (filterSelect) {
      const wanted = '<option value="">All positions</option>'
        + positions.map((p) => `<option value="${Number(p.id)}">${esc(p.title)}</option>`).join('');
      if (filterSelect.dataset.filled !== wanted) {
        filterSelect.innerHTML = wanted;
        filterSelect.dataset.filled = wanted;
      }
      // Drop a filter that points at a position which no longer exists.
      if (state.pos.positionId && !positions.some((p) => String(p.id) === String(state.pos.positionId))) {
        state.pos.positionId = '';
      }
      filterSelect.value = state.pos.positionId || '';
    }
  }

  function buildPositions() {
    render(pane('positions'), html`
      <h3>Positions &amp; candidates</h3>
      <div class="filterbar">
        <div class="field">
          <label for="pos-election">Election</label>
          <select id="pos-election">
            ${state.elections.map((e) => html`<option value="${e.id}" ${String(e.id) === String(state.pos.electionId) ? 'selected' : ''}>${e.title}</option>`)}
          </select>
        </div>
      </div>
      <div id="position-list-slot"></div>

      <form id="add-position-form" style="margin-top:16px">
        <div class="grid three">
          <div class="field">
            <label for="pos-title">Position title <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
            <input id="pos-title" required placeholder="SRC President">
          </div>
          <div class="field"><label for="pos-min">Minimum selections</label><input id="pos-min" type="number" min="0" value="1"></div>
          <div class="field"><label for="pos-max">Maximum selections</label><input id="pos-max" type="number" min="1" value="1"></div>
        </div>
        <div class="field"><label for="pos-description">Description</label><input id="pos-description" placeholder="Chief representative of all students"></div>
        <div class="field">
          <label class="check-label" for="pos-mandatory">
            <input type="checkbox" id="pos-mandatory" checked> Mandatory — voters must make a selection
          </label>
        </div>
        <button type="submit" class="btn small">Add position</button>
      </form>

      <h4 style="margin-top:24px">Candidates</h4>
      <div class="filterbar">
        <div class="field">
          <label for="cand-search">Search candidates</label>
          <input id="cand-search" type="search" placeholder="Name, student ID, department or affiliation" value="${state.pos.q}">
        </div>
        <div class="field">
          <label for="cand-position">Filter by position</label>
          <select id="cand-position"><option value="">All positions</option></select>
        </div>
      </div>
      <div id="candidate-list-slot"></div>
      <div id="candidate-editor"></div>

      <div class="card" style="margin-top:16px;box-shadow:none;background:#f8fafc">
        <h4>Add candidate</h4>
        <form id="add-candidate-form">
          <div class="grid three">
            <div class="field">
              <label for="cand-position-select">Position <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <select id="cand-position-select" required></select>
            </div>
            <div class="field">
              <label for="cand-name">Full name <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="cand-name" required maxlength="120">
            </div>
            <div class="field"><label for="cand-student-id">Student ID</label><input id="cand-student-id"></div>
          </div>
          <div class="grid three">
            <div class="field"><label for="cand-department">Department</label><input id="cand-department"></div>
            <div class="field"><label for="cand-faculty">Faculty / School</label><input id="cand-faculty"></div>
            <div class="field"><label for="cand-level">Level</label><input id="cand-level" placeholder="400"></div>
          </div>
          <div class="grid two">
            <div class="field"><label for="cand-affiliation">Affiliation</label><input id="cand-affiliation" value="Independent" placeholder="Independent, or a party name"></div>
            <div class="field">
              <label for="cand-photo">Photograph</label>
              <input id="cand-photo" type="file" accept="image/jpeg,image/png,image/webp,image/gif">
              <p class="hint">JPEG, PNG, WebP or GIF, up to 3 MB. Re-served with scripting disabled.</p>
            </div>
          </div>
          <div class="field"><label for="cand-bio">Short biography</label><textarea id="cand-bio" rows="2"></textarea></div>
          <div class="field"><label for="cand-manifesto">Manifesto</label><textarea id="cand-manifesto" rows="4"></textarea></div>
          <button type="submit" class="btn small">Add candidate</button>
        </form>
      </div>`);

    $('#pos-election').addEventListener('change', (ev) => {
      state.pos.electionId = ev.target.value;
      state.pos.positionId = '';
      $('#cand-position').value = '';
      paintPositions();
    });
    $('#cand-search').addEventListener('input', debounce((ev) => { state.pos.q = ev.target.value; paintPositions(); }, 200));
    $('#cand-position').addEventListener('change', (ev) => { state.pos.positionId = ev.target.value; paintPositions(); });

    $('#add-position-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api.post(`/api/admin/elections/${state.pos.electionId}/positions`, {
          title: $('#pos-title').value.trim(),
          description: $('#pos-description').value.trim(),
          min_select: Number($('#pos-min').value) || 0,
          max_select: Number($('#pos-max').value) || 1,
          is_mandatory: $('#pos-mandatory').checked ? 1 : 0,
        });
        ev.target.reset();
        $('#pos-min').value = '1';
        $('#pos-max').value = '1';
        $('#pos-mandatory').checked = true;
        adminMessage('Position added.');
        await paintPositions();
      } catch (err) { reportError(err); }
    });

    $('#add-candidate-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData();
      fd.append('election_id', state.pos.electionId);
      fd.append('position_id', $('#cand-position-select').value);
      fd.append('name', $('#cand-name').value.trim());
      fd.append('student_id', $('#cand-student-id').value.trim());
      fd.append('department', $('#cand-department').value.trim());
      fd.append('faculty', $('#cand-faculty').value.trim());
      fd.append('level', $('#cand-level').value.trim());
      fd.append('affiliation', $('#cand-affiliation').value.trim() || 'Independent');
      fd.append('bio', $('#cand-bio').value);
      fd.append('manifesto', $('#cand-manifesto').value);
      const file = $('#cand-photo').files[0];
      if (file) fd.append('photo', file);
      try {
        await api.upload('/api/admin/candidates', 'POST', fd);
        ev.target.reset();
        $('#cand-affiliation').value = 'Independent';
        adminMessage('Candidate added.');
        await paintPositions();
      } catch (err) { reportError(err); }
    });

    onDelegated(pane('positions'), 'click', '[data-action]', async (ev, btn) => {
      const { action, id } = btn.dataset;
      try {
        if (action === 'delete-position') {
          const ok = await confirmAction('Remove this position?', 'Its candidates are removed too. This is refused if ballots have already been recorded for it.', 'Remove', true);
          if (!ok) return;
          await api.del(`/api/admin/positions/${id}`);
          adminMessage('Position removed.');
        } else if (action === 'delete-candidate') {
          const ok = await confirmAction('Remove this candidate?', 'This is refused once the candidate has received votes, so published results can never be rewritten.', 'Remove', true);
          if (!ok) return;
          await api.del(`/api/admin/candidates/${id}`);
          adminMessage('Candidate removed.');
        } else if (action === 'edit-position') {
          showPositionEditor(id, btn);
          return;
        } else if (action === 'edit-candidate') {
          await showCandidateEditor(id);
          return;
        }
        await paintPositions();
      } catch (err) { reportError(err); }
    });
  }

  function showPositionEditor(id, trigger) {
    const { positions } = detailCache;
    const p = positions.find((x) => String(x.id) === String(id));
    const slot = $('#position-editor');
    if (!p || !slot) return;
    render(slot, html`
      <div class="card" style="margin-top:12px;box-shadow:none;background:#eef4ff">
        <h4>Edit position #${p.id} — ${p.title}</h4>
        <form id="edit-position-form">
          <div class="grid three">
            <div class="field"><label for="ep-title">Title</label><input id="ep-title" value="${p.title}" required></div>
            <div class="field"><label for="ep-min">Minimum</label><input id="ep-min" type="number" min="0" value="${p.min_select}"></div>
            <div class="field"><label for="ep-max">Maximum</label><input id="ep-max" type="number" min="1" value="${p.max_select}"></div>
          </div>
          <div class="field"><label for="ep-desc">Description</label><input id="ep-desc" value="${p.description || ''}"></div>
          <div class="field">
            <label class="check-label" for="ep-mandatory"><input type="checkbox" id="ep-mandatory" ${p.is_mandatory ? 'checked' : ''}> Mandatory</label>
          </div>
          <button type="submit" class="btn small">Save position</button>
          <button type="button" class="btn small ghost" id="cancel-pos">Cancel</button>
        </form>
      </div>`);
    $('#cancel-pos').addEventListener('click', () => { render(slot, ''); trigger.focus(); });
    $('#edit-position-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api.put(`/api/admin/positions/${p.id}`, {
          title: $('#ep-title').value.trim(),
          description: $('#ep-desc').value,
          min_select: Number($('#ep-min').value) || 0,
          max_select: Number($('#ep-max').value) || 1,
          is_mandatory: $('#ep-mandatory').checked ? 1 : 0,
        });
        adminMessage('Position updated.');
        render(slot, '');
        await paintPositions();
      } catch (err) { reportError(err); }
    });
    $('#ep-title').focus();
  }

  async function showCandidateEditor(id) {
    const slot = $('#candidate-editor');
    if (!slot) return;
    const { positions, candidates } = detailCache;
    const c = candidates.find((x) => String(x.id) === String(id));
    if (!c) return;
    render(slot, html`
      <div class="card" style="margin-top:16px;box-shadow:none;background:#eef4ff">
        <h4>Edit candidate #${c.id} — ${c.name}</h4>
        <form id="edit-candidate-form">
          <div class="grid three">
            <div class="field"><label for="ec-name">Full name</label><input id="ec-name" value="${c.name}" required></div>
            <div class="field"><label for="ec-student-id">Student ID</label><input id="ec-student-id" value="${c.student_id || ''}"></div>
            <div class="field">
              <label for="ec-position">Position</label>
              <select id="ec-position">
                ${positions.map((p) => html`<option value="${p.id}" ${p.id === c.position_id ? 'selected' : ''}>${p.title}</option>`)}
              </select>
            </div>
          </div>
          <div class="grid three">
            <div class="field"><label for="ec-department">Department</label><input id="ec-department" value="${c.department || ''}"></div>
            <div class="field"><label for="ec-faculty">Faculty</label><input id="ec-faculty" value="${c.faculty || ''}"></div>
            <div class="field"><label for="ec-level">Level</label><input id="ec-level" value="${c.level || ''}"></div>
          </div>
          <div class="grid two">
            <div class="field"><label for="ec-affiliation">Affiliation</label><input id="ec-affiliation" value="${c.affiliation || ''}"></div>
            <div class="field">
              <label for="ec-photo">Replace photograph</label>
              <input id="ec-photo" type="file" accept="image/jpeg,image/png,image/webp,image/gif">
              <p class="hint">${c.photo_url ? 'A photograph is currently uploaded. Leave empty to keep it.' : 'No photograph uploaded.'}</p>
            </div>
          </div>
          <div class="field"><label for="ec-bio">Biography</label><textarea id="ec-bio" rows="2">${c.bio || ''}</textarea></div>
          <div class="field"><label for="ec-manifesto">Manifesto</label><textarea id="ec-manifesto" rows="4">${c.manifesto || ''}</textarea></div>
          <button type="submit" class="btn small">Save candidate</button>
          <button type="button" class="btn small ghost" id="cancel-cand">Cancel</button>
        </form>
      </div>`);
    $('#cancel-cand').addEventListener('click', () => render(slot, ''));
    $('#edit-candidate-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData();
      fd.append('name', $('#ec-name').value.trim());
      fd.append('student_id', $('#ec-student-id').value.trim());
      fd.append('position_id', $('#ec-position').value);
      fd.append('department', $('#ec-department').value.trim());
      fd.append('faculty', $('#ec-faculty').value.trim());
      fd.append('level', $('#ec-level').value.trim());
      fd.append('affiliation', $('#ec-affiliation').value.trim());
      fd.append('bio', $('#ec-bio').value);
      fd.append('manifesto', $('#ec-manifesto').value);
      const file = $('#ec-photo').files[0];
      if (file) fd.append('photo', file);
      try {
        await api.upload(`/api/admin/candidates/${c.id}`, 'PUT', fd);
        adminMessage('Candidate updated.');
        render(slot, '');
        await paintPositions();
      } catch (err) { reportError(err); }
    });
    $('#ec-name').focus();
  }

  /* ------------------------------------------------------------------ *
   * Voters and eligibility pane
   * ------------------------------------------------------------------ */
  function buildVoters() {
    render(pane('voters'), html`
      <h3>Voters &amp; electoral roll</h3>
      <p class="meta">
        This pane controls <strong>roll membership</strong> — which registered students may vote in a given
        election. Creating, verifying, disabling or deleting a student <em>account</em> is a super
        administrator action; ask one of them if an account itself needs to change.
      </p>
      <div class="filterbar">
        <div class="field">
          <label for="voter-search">Search students</label>
          <input id="voter-search" type="search" placeholder="Name, email or student ID" value="${state.vot.q}">
        </div>
        <div class="field">
          <label for="filter-faculty">Faculty</label>
          <select id="filter-faculty"><option value="">All faculties</option></select>
        </div>
        <div class="field">
          <label for="filter-department">Department</label>
          <select id="filter-department"><option value="">All departments</option></select>
        </div>
        <div class="field">
          <label for="filter-level">Level</label>
          <select id="filter-level"><option value="">All levels</option></select>
        </div>
        <div class="field">
          <label for="filter-verified">Verification</label>
          <select id="filter-verified">
            <option value="">Any</option>
            <option value="1">Verified</option>
            <option value="0">Unverified</option>
          </select>
        </div>
        <div class="field">
          <label for="filter-active">Account</label>
          <select id="filter-active">
            <option value="">Any</option>
            <option value="1">Active</option>
            <option value="0">Disabled</option>
          </select>
        </div>
      </div>

      <div class="card" style="box-shadow:none;background:#eef4ff;margin-bottom:14px">
        <h4>Turnout for one election</h4>
        <div class="field">
          <label for="roll-election">Election</label>
          <select id="roll-election">
            ${state.elections.map((e) => html`<option value="${e.id}" ${String(e.id) === String(state.vot.electionId) ? 'selected' : ''}>${e.title}</option>`)}
          </select>
        </div>
        <div id="turnout-slot"></div>
        <p class="row-actions" style="margin:12px 0 0">
          <button type="button" class="btn small" data-action="bulk-eligible">Make all verified voters eligible</button>
          <a class="btn small ghost" href="/api/admin/eligibility-template">Download CSV template</a>
        </p>
      </div>

      <p class="meta" id="voter-count"></p>
      <div id="voter-list-slot"></div>

      <div class="card" style="margin-top:16px;box-shadow:none;background:#f8fafc">
        <h4>Import eligibility from CSV</h4>
        <p class="meta">Upload a CSV with <code>student_id</code> and/or <code>email</code> columns for the election selected above. Rows that do not match a registered voter are reported back, so nothing is silently dropped.</p>
        <form id="import-form">
          <div class="field">
            <label for="csv-file">CSV file <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
            <input id="csv-file" type="file" accept=".csv,text/csv" required>
          </div>
          <button type="submit" class="btn small">Import for the selected election</button>
        </form>
        <p style="margin:12px 0 0"><a class="btn small ghost" href="/api/admin/voters/export.csv">Export the full voter roll (CSV)</a></p>
      </div>`);

    const bind = (id, key, event = 'change', wait = 0) => {
      const apply = (ev) => { state.vot[key] = ev.target.value; paintVoters(); };
      $(`#${id}`).addEventListener(event, wait ? debounce(apply, wait) : apply);
    };
    bind('voter-search', 'q', 'input', 250);
    bind('filter-faculty', 'faculty');
    bind('filter-department', 'department');
    bind('filter-level', 'level');
    bind('filter-verified', 'verified');
    bind('filter-active', 'active');
    bind('roll-election', 'electionId');

    $('#import-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const file = $('#csv-file').files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await api.upload(`/api/admin/elections/${state.vot.electionId}/eligibility/import`, 'POST', fd);
        const extra = r.not_found_total
          ? ` ${r.not_found_total} row(s) did not match a registered voter: ${r.not_found.slice(0, 5).join(', ')}${r.not_found_total > 5 ? '…' : ''}`
          : '';
        adminMessage(`${r.message}${extra}`);
        await paintVoters();
      } catch (err) { reportError(err); }
    });

    onDelegated(pane('voters'), 'click', '[data-action]', async (ev, btn) => {
      const { action, id } = btn.dataset;
      try {
        if (action === 'bulk-eligible') {
          const ok = await confirmAction('Make all verified voters eligible?', 'This adds every active, verified student to the electoral roll for the selected election.', 'Add them');
          if (!ok) return;
          const r = await api.post(`/api/admin/elections/${state.vot.electionId}/eligibility`, { all_verified: true });
          adminMessage(r.message);
        } else if (action === 'add-eligible') {
          await api.post(`/api/admin/elections/${state.vot.electionId}/eligibility`, { user_ids: [Number(id)] });
          adminMessage('Added to the electoral roll.');
        } else if (action === 'remove-eligible') {
          const ok = await confirmAction('Remove from the electoral roll?', 'This student will no longer be able to vote in this election.', 'Remove', true);
          if (!ok) return;
          await api.del(`/api/admin/elections/${state.vot.electionId}/eligibility/${id}`);
          adminMessage('Removed from the electoral roll.');
        }
        await paintVoters();
      } catch (err) { reportError(err); }
    });
  }

  async function paintVoters() {
    const host = pane('voters');
    if (!state.elections.length) {
      return render(host, emptyState('No elections yet', 'Create an election before managing the electoral roll.'));
    }
    if (!built.voters) { built.voters = true; buildVoters(); }
    render('#voter-list-slot', skeleton('Loading students…'));

    const params = new URLSearchParams({ limit: '300' });
    Object.entries(state.vot).forEach(([key, value]) => { if (value) params.set(key, value); });

    let voters;
    let roll;
    try {
      [voters, roll] = await Promise.all([
        api.get(`/api/admin/voters?${params}`),
        api.get(`/api/admin/elections/${encodeURIComponent(state.vot.electionId)}/roll`),
      ]);
    } catch (err) { return reportError(err); }

    // Facet dropdowns reflect the whole cohort, not the filtered subset.
    const fillFacet = (id, values, selected) => {
      const sel = $(`#${id}`);
      const wanted = ['', ...values];
      const have = Array.from(sel.options).map((o) => o.value);
      if (wanted.join(' ') === have.join(' ')) {
        sel.value = selected;
        return;
      }
      sel.innerHTML = `<option value="">All</option>${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
      sel.value = selected;
    };
    fillFacet('filter-faculty', voters.facets.faculty, state.vot.faculty);
    fillFacet('filter-department', voters.facets.department, state.vot.department);
    fillFacet('filter-level', voters.facets.level, state.vot.level);
    $('#filter-verified').value = state.vot.verified;
    $('#filter-active').value = state.vot.active;

    const voted = roll.rows.filter((r) => r.has_voted).length;
    render('#turnout-slot', html`
      <p style="margin:0">
        <strong>${voted}</strong> of <strong>${roll.total}</strong> eligible voters have voted
        — ${pct(voted, roll.total)}% turnout.
      </p>
      <p class="meta" style="margin:4px 0 0">
        ${roll.explicit_roll
          ? 'An explicit electoral roll applies to this election.'
          : 'No explicit roll: every registered voter is eligible.'}
        Participation is reported only. No administrator can see how an individual student voted.
      </p>`);

    const rollByUser = new Map(roll.rows.map((r) => [r.id, r]));
    render('#voter-count', `${plural(voters.total, 'student')} match your filters.`);
    const slot = $('#voter-list-slot');
    if (!voters.rows.length) {
      return render(slot, emptyState('No students match', 'Try clearing the filters above.'));
    }
    const rows = voters.rows.map((v) => {
      const onRoll = rollByUser.get(v.id);
      const eligible = !roll.explicit_roll || !!onRoll;
      const status = !eligible
        ? html`<span class="meta">Not on roll</span>`
        : onRoll.has_voted
          ? html`<span class="badge status-published">Voted</span>`
          : html`<span class="badge">Not voted</span>`;
      return html`
        <tr>
          <th scope="row">${v.name}<br><span class="meta">${v.email}</span></th>
          <td class="meta">${v.student_id || '—'}</td>
          <td class="meta">${[v.department, v.level].filter(Boolean).join(' · ') || '—'}</td>
          <td>${v.verified ? 'Yes' : 'No'}</td>
          <td>${v.is_active ? 'Active' : 'Disabled'}</td>
          <td>${status}</td>
          <td>
            <div class="row-actions">
              ${roll.explicit_roll && !onRoll
                ? html`<button type="button" class="btn small" data-action="add-eligible" data-id="${v.id}">Add to roll<span class="visually-hidden"> ${v.name}</span></button>`
                : ''}
              ${roll.explicit_roll && onRoll
                ? html`<button type="button" class="btn small ghost" data-action="remove-eligible" data-id="${v.id}">Remove from roll<span class="visually-hidden"> ${v.name}</span></button>`
                : ''}
            </div>
          </td>
        </tr>`;
    });
    render(slot, html`
      <div class="table-scroll">
        <table>
          <caption class="visually-hidden">Eligible students and their participation status</caption>
          <thead><tr>
            <th scope="col">Student</th><th scope="col">Student ID</th><th scope="col">Department</th>
            <th scope="col">Verified</th><th scope="col">Account</th><th scope="col">Participation</th><th scope="col">Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  /* ------------------------------------------------------------------ *
   * Activity pane
   * ------------------------------------------------------------------ */
  async function paintActivity() {
    const host = pane('activity');
    const election = state.elections.find((e) => e.display_status === 'open') || state.elections[0];
    render(host, html`
      <h3>Activity &amp; audit log</h3>
      <p class="meta">
        Audit records cover authentication and administration events. They deliberately contain no ballot
        content: no administrator can see how any individual student voted.
      </p>
      ${election ? html`
        <h4>Ballots recorded per hour — ${election.title}</h4>
        <div id="activity-chart">${skeleton('Loading vote volume…')}</div>` : ''}
      <h4 style="margin-top:22px">Recent audit entries</h4>
      <div class="table-scroll">
        <table>
          <caption class="visually-hidden">Recent system activity</caption>
          <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Details</th></tr></thead>
          <tbody>${(state.stats.recent || []).map((l) => html`
            <tr>
              <td class="meta">${fmtDate(l.created_at)}</td>
              <td class="meta">${l.actor || 'system'}</td>
              <td>${l.action}</td>
              <td class="meta">${l.details || ''}</td>
            </tr>`)}</tbody>
        </table>
      </div>`);
    if (!election) return;

    try {
      const activity = await api.get(`/api/admin/elections/${encodeURIComponent(election.id)}/activity`);
      render('#activity-chart', activity.byHour.length
        ? barChart({
          title: `Ballots recorded per hour (${plural(activity.receipts, 'ballot')} total)`,
          items: activity.byHour.map((h) => ({ label: h.h, value: h.c })),
          total: activity.receipts,
        })
        : emptyState('No votes recorded yet', 'Vote volume appears here as ballots arrive.'));
    } catch (err) {
      render('#activity-chart', emptyState('Vote volume unavailable', err.message));
    }
  }

  await refresh();
});
