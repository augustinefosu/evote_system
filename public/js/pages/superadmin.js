// Super-administration: administrator accounts, the full user register,
// institution-wide settings and the audit trail.
document.addEventListener('DOMContentLoaded', async () => {
  const me = await requireAuth(['superadmin']);
  if (!me) return;
  navRender(me);
  markCurrentNav();

  const state = {
    tab: 'admins',
    users: [],
    settings: [],
    logs: [],
    health: null,
    filter: { q: '', role: '', active: '', verified: '' },
    logFilter: { q: '', action: '' },
  };
  const built = {};
  const pane = (name) => document.getElementById(`pane-${name}`);

  const SETTING_SCHEMA = [
    { key: 'school_name', label: 'Institution name', type: 'text', hint: 'Shown in the header, page titles and on the results page.' },
    { key: 'allow_registration', label: 'Allow self-registration', type: 'bool', hint: 'Turn off to close registration; existing accounts are unaffected.' },
    { key: 'require_verification_to_vote', label: 'Require a verified account to vote', type: 'bool', hint: 'Unverified students can browse but cannot cast a ballot.' },
    {
      key: 'results_visibility',
      label: 'Results visibility',
      type: 'select',
      options: [
        ['published_only', 'Published only — students see results after an administrator publishes them'],
        ['all_authenticated', 'After close — students see results once voting ends, before publication'],
        ['admins_only', 'Administrators only — students cannot see any results'],
      ],
      hint: 'Applies to every election. Administrators always retain access.',
    },
    { key: 'max_login_attempts', label: 'Failed logins before lockout', type: 'number', min: 1, max: 20, hint: 'Applies per email address and IP address.' },
    { key: 'session_hours', label: 'Session lifetime (hours)', type: 'number', min: 1, max: 168, hint: 'How long a signed-in session stays valid before re-authentication.' },
  ];

  function showTab(name) {
    state.tab = name;
    $$('.tabs button').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
    });
    ['admins', 'users', 'settings', 'audit'].forEach((t) => {
      pane(t).classList.toggle('hidden', t !== name);
    });
    ({ admins: paintAdmins, users: paintUsers, settings: paintSettings, audit: paintAudit }[name])();
  }
  onDelegated(document, 'click', '.tabs button', (ev, btn) => showTab(btn.dataset.tab));
  onDelegated(document, 'keydown', '.tabs button', (ev, btn) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(ev.key in keys)) return;
    const tabs = $$('.tabs button');
    const next = tabs[(tabs.indexOf(btn) + keys[ev.key] + tabs.length) % tabs.length];
    ev.preventDefault();
    next.focus();
    showTab(next.dataset.tab);
  });

  function report(text, ok = true) {
    render('super-message', html`<div class="alert ${ok ? 'ok' : 'error'}" role="${ok ? 'status' : 'alert'}">${text}</div>`);
    if (ok) toast(text, 'ok');
  }
  const fail = (err) => render('super-message', html`<div class="alert error" role="alert">${err.message}</div>`);

  async function load() {
    render('super-message', '');
    try {
      const [users, settings, logs, health] = await Promise.all([
        api.get('/api/super/users'),
        api.get('/api/super/settings'),
        api.get('/api/super/logs'),
        api.get('/api/health').catch(() => null),
      ]);
      state.users = users;
      state.settings = settings;
      state.logs = logs;
      state.health = health;
    } catch (err) { return fail(err); }
    paintOverview();
    showTab(state.tab);
  }

  function paintOverview() {
    const count = (role) => state.users.filter((u) => u.role === role).length;
    const admins = state.users.filter((u) => u.role !== 'voter');
    const card = (value, meta) => html`<div class="card"><div class="kpi">${value}</div><div class="meta">${meta}</div></div>`;
    render('super-kpis', html`
      ${card(state.users.length, 'Accounts')}
      ${card(count('voter'), 'Voters')}
      ${card(count('admin'), 'Election administrators')}
      ${card(count('superadmin'), 'Super administrators')}
      ${card(state.users.filter((u) => u.is_active).length, 'Active')}
      ${card(state.users.filter((u) => !u.is_active).length, 'Disabled')}
      ${card(state.users.filter((u) => u.role === 'voter' && !u.verified).length, 'Awaiting verification')}
      ${card(state.health ? state.health.db.toUpperCase() : '—', 'Database status')}`);
    render('super-admins', html`
      <div class="card" style="box-shadow:none;background:#eef4ff">
        <h4>Administrator accounts</h4>
        ${admins.length ? html`
          <div class="table-scroll">
            <table>
              <caption class="visually-hidden">Administrator and super administrator accounts</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th></tr></thead>
              <tbody>${admins.map((u) => html`
                <tr>
                  <th scope="row">${u.name}</th>
                  <td class="meta">${u.email}</td>
                  <td>${roleLabel(u.role)}</td>
                  <td>${u.is_active ? 'Active' : 'Disabled'}</td>
                </tr>`)}</tbody>
            </table>
          </div>` : emptyState('No administrators', 'Create the first election administrator below.')}
      </div>`);
  }

  function roleLabel(role) {
    return { superadmin: 'Super administrator', admin: 'Election administrator', voter: 'Student' }[role] || role;
  }

  /* ------------------------------------------------------------------ *
   * Administrators
   * ------------------------------------------------------------------ */
  function buildAdmins() {
    render(pane('admins'), html`
      <h3>Election administrators</h3>
      <p class="meta">
        Administrators create and run elections, manage candidates and the electoral roll, and publish
        results. Only a super administrator can grant or revoke this access.
      </p>

      <div class="card" style="box-shadow:none;background:#f8fafc">
        <h4>Create an account</h4>
        <form id="create-user-form">
          <div class="grid two">
            <div class="field">
              <label for="new-user-name">Full name <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="new-user-name" required maxlength="120">
            </div>
            <div class="field">
              <label for="new-user-email">Email <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="new-user-email" type="email" required autocomplete="off">
            </div>
          </div>
          <div class="grid three">
            <div class="field">
              <label for="new-user-role">Role <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <select id="new-user-role">
                <option value="admin">Election administrator</option>
                <option value="superadmin">Super administrator</option>
                <option value="voter">Student (verified immediately)</option>
              </select>
            </div>
            <div class="field">
              <label for="new-user-password">Temporary password <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span></label>
              <input id="new-user-password" type="password" required minlength="8" autocomplete="new-password">
              <p class="hint">At least 8 characters. Share it over a channel that is not email.</p>
            </div>
            <div class="field">
              <label for="new-user-student-id">Student ID</label>
              <input id="new-user-student-id" placeholder="Only for student accounts">
            </div>
          </div>
          <div class="grid three">
            <div class="field"><label for="new-user-faculty">Faculty</label><input id="new-user-faculty"></div>
            <div class="field"><label for="new-user-department">Department</label><input id="new-user-department"></div>
            <div class="field"><label for="new-user-level">Level</label><input id="new-user-level"></div>
          </div>
          <button type="submit" class="btn">Create account</button>
        </form>
      </div>`);

    $('#create-user-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      try {
        await api.post('/api/super/users', {
          name: $('#new-user-name').value.trim(),
          email: $('#new-user-email').value.trim(),
          password: $('#new-user-password').value,
          role: $('#new-user-role').value,
          student_id: $('#new-user-student-id').value.trim(),
          faculty: $('#new-user-faculty').value.trim(),
          department: $('#new-user-department').value.trim(),
          level: $('#new-user-level').value.trim(),
        });
        form.reset();
        report('Account created. Share the temporary password securely and ask them to change it.');
        await load();
      } catch (err) { fail(err); }
    });
  }

  function paintAdmins() {
    if (!built.admins) { built.admins = true; buildAdmins(); }
    paintOverview();
  }

  function showUserEditor(id) {
    const u = state.users.find((x) => x.id === id);
    const slot = $('#user-editor');
    if (!u || !slot) return;
    render(slot, html`
      <div class="card" style="margin-top:16px;box-shadow:none;background:#eef4ff">
        <h4>Edit #${u.id} — ${u.name}</h4>
        <form id="edit-user-form">
          <div class="grid two">
            <div class="field"><label for="eu-name">Full name</label><input id="eu-name" value="${u.name}" required></div>
            <div class="field">
              <label for="eu-role">Role</label>
              <select id="eu-role">
                <option value="voter" ${u.role === 'voter' ? 'selected' : ''}>Student</option>
                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Election administrator</option>
                <option value="superadmin" ${u.role === 'superadmin' ? 'selected' : ''}>Super administrator</option>
              </select>
            </div>
          </div>
          <div class="grid three">
            <div class="field">
              <label class="check-label" for="eu-active"><input type="checkbox" id="eu-active" ${u.is_active ? 'checked' : ''}> Account is active</label>
            </div>
            <div class="field">
              <label class="check-label" for="eu-verified"><input type="checkbox" id="eu-verified" ${u.verified ? 'checked' : ''}> Verified</label>
            </div>
            <div class="field"><label for="eu-level">Level</label><input id="eu-level" value="${u.level || ''}"></div>
          </div>
          <div class="grid two">
            <div class="field"><label for="eu-faculty">Faculty</label><input id="eu-faculty" value="${u.faculty || ''}"></div>
            <div class="field"><label for="eu-department">Department</label><input id="eu-department" value="${u.department || ''}"></div>
          </div>
          <div class="field">
            <label for="eu-password">Reset password</label>
            <input id="eu-password" type="password" minlength="8" autocomplete="new-password" placeholder="Leave empty to keep the current password">
            <p class="hint">At least 8 characters. Changing this is recorded in the audit log.</p>
          </div>
          <button type="submit" class="btn small">Save account</button>
          <button type="button" class="btn small ghost" id="cancel-user">Cancel</button>
        </form>
      </div>`);
    $('#cancel-user').addEventListener('click', () => render(slot, ''));
    $('#edit-user-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const password = $('#eu-password').value;
      const payload = {
        name: $('#eu-name').value.trim(),
        role: $('#eu-role').value,
        is_active: $('#eu-active').checked ? 1 : 0,
        verified: $('#eu-verified').checked ? 1 : 0,
        faculty: $('#eu-faculty').value.trim(),
        department: $('#eu-department').value.trim(),
        level: $('#eu-level').value.trim(),
      };
      if (password) payload.password = password;
      try {
        await api.put(`/api/super/users/${u.id}`, payload);
        report('Account updated.');
        render(slot, '');
        await load();
      } catch (err) { fail(err); }
    });
    $('#eu-name').focus();
  }

  /* ------------------------------------------------------------------ *
   * User register
   * ------------------------------------------------------------------ */
  function buildUsers() {
    render(pane('users'), html`
      <h3>User register</h3>
      <div class="filterbar">
        <div class="field">
          <label for="user-search">Search accounts</label>
          <input id="user-search" type="search" placeholder="Name, email or student ID" value="${state.filter.q}">
        </div>
        <div class="field">
          <label for="filter-role">Role</label>
          <select id="filter-role">
            <option value="">All roles</option>
            <option value="voter">Students</option>
            <option value="admin">Election administrators</option>
            <option value="superadmin">Super administrators</option>
          </select>
        </div>
        <div class="field">
          <label for="filter-state">Account state</label>
          <select id="filter-state">
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="inactive">Disabled</option>
            <option value="unverified">Awaiting verification</option>
          </select>
        </div>
      </div>
      <p class="meta" id="user-count" role="status"></p>
      <div id="user-list-slot"></div>
      <div id="user-editor"></div>`);

    $('#user-search').addEventListener('input', debounce((ev) => { state.filter.q = ev.target.value; paintUsers(); }, 200));
    $('#filter-role').addEventListener('change', (ev) => { state.filter.role = ev.target.value; paintUsers(); });
    $('#filter-state').addEventListener('change', (ev) => { state.filter.active = ev.target.value; paintUsers(); });

    // Delegated from the pane, not from the table body: the register is
    // re-rendered on every filter change, so per-row listeners would be
    // discarded each time. The editor slot lives here too, keeping the form
    // next to the row whose action was clicked.
    onDelegated(pane('users'), 'click', '[data-action]', async (ev, btn) => {
      const { action, id } = btn.dataset;
      if (action === 'edit') { showUserEditor(Number(id)); return; }
      const user = state.users.find((u) => u.id === Number(id));
      if (!user) return;
      try {
        if (action === 'toggle') {
          const next = user.is_active ? 0 : 1;
          if (user.is_active) {
            const ok = await confirmAction(
              `Disable ${user.name}?`,
              'They will be signed out and unable to sign in until re-enabled. Their ballots and audit history are preserved.',
              'Disable', true,
            );
            if (!ok) return;
          }
          await api.put(`/api/super/users/${user.id}`, { is_active: next });
          report(`${user.name} ${next ? 'enabled' : 'disabled'}.`);
          await load();
        } else if (action === 'delete') {
          const ok = await confirmAction(
            `Delete ${user.name}?`,
            'This is permanent. Accounts that have recorded votes cannot be deleted — disable them instead so the ballot record stays intact.',
            'Delete', true,
          );
          if (!ok) return;
          await api.del(`/api/super/users/${user.id}`);
          report('Account deleted.');
          await load();
        }
      } catch (err) { fail(err); }
    });
  }

  function paintUsers() {
    if (!built.users) { built.users = true; buildUsers(); }
    const term = state.filter.q.toLowerCase();
    const rows = state.users.filter((u) => {
      if (term && !`${u.name} ${u.email} ${u.student_id || ''}`.toLowerCase().includes(term)) return false;
      if (state.filter.role && u.role !== state.filter.role) return false;
      if (state.filter.active === 'active' && !u.is_active) return false;
      if (state.filter.active === 'inactive' && u.is_active) return false;
      if (state.filter.active === 'unverified' && (u.verified || u.role !== 'voter')) return false;
      return true;
    });
    render('#user-count', `${plural(rows.length, 'account')} shown of ${state.users.length}.`);
    const slot = $('#user-list-slot');
    if (!rows.length) {
      return render(slot, emptyState('No accounts match', 'Try clearing the filters above.'));
    }
    render(slot, html`
      <div class="table-scroll">
        <table>
          <caption class="visually-hidden">All registered accounts</caption>
          <thead><tr>
            <th scope="col">Name</th><th scope="col">Student ID</th><th scope="col">Faculty / Department</th>
            <th scope="col">Role</th><th scope="col">Verified</th><th scope="col">Status</th><th scope="col">Actions</th>
          </tr></thead>
          <tbody>${rows.map((u) => html`
            <tr>
              <th scope="row">${u.name}<br><span class="meta">${u.email}</span></th>
              <td class="meta">${u.student_id || '—'}</td>
              <td class="meta">${[u.faculty, u.department].filter(Boolean).join(' · ') || '—'}</td>
              <td>${roleLabel(u.role)}</td>
              <td>${u.verified ? 'Yes' : 'No'}</td>
              <td>${u.is_active ? 'Active' : 'Disabled'}</td>
              <td>
                <div class="row-actions">
                  <button type="button" class="btn small ghost" data-action="edit" data-id="${u.id}">Edit<span class="visually-hidden"> ${u.name}</span></button>
                  <button type="button" class="btn small ${u.is_active ? 'ghost' : ''}" data-action="toggle" data-id="${u.id}">${u.is_active ? 'Disable' : 'Enable'}<span class="visually-hidden"> ${u.name}</span></button>
                  <button type="button" class="btn small danger" data-action="delete" data-id="${u.id}">Delete<span class="visually-hidden"> ${u.name}</span></button>
                </div>
              </td>
            </tr>`)}</tbody>
        </table>
      </div>`);
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */
  function buildSettings() {
    render(pane('settings'), html`
      <h3>Institution settings</h3>
      <p class="meta">These values apply to the whole system and take effect immediately. Each change is written to the audit log.</p>
      <form id="settings-form"><div id="settings-fields"></div>
      <button type="submit" class="btn">Save settings</button></form>
      <div id="settings-extra"></div>
      <div class="card" style="margin-top:18px;box-shadow:none;background:#f8fafc">
        <h4>Add or change an advanced setting</h4>
        <div class="grid two">
          <div class="field"><label for="adv-key">Setting key</label><input id="adv-key" placeholder="e.g. election_support_email"></div>
          <div class="field"><label for="adv-value">Value</label><input id="adv-value"></div>
        </div>
        <button type="button" class="btn small ghost" id="adv-save">Save advanced setting</button>
      </div>`);

    $('#settings-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const updates = [];
      SETTING_SCHEMA.forEach((spec) => {
        const el = $(`#set-${spec.key}`);
        if (!el) return;
        const value = spec.type === 'bool' ? (el.checked ? '1' : '0')
          : spec.type === 'number' ? String(Number(el.value) || 0)
            : el.value.trim();
        updates.push([spec.key, value]);
      });
      // Any additional keys already in the table but not in the schema.
      updates.push(...state.settings
        .filter((s) => !SETTING_SCHEMA.some((spec) => spec.key === s.key))
        .map((s) => [s.key, String(s.value)]));
      try {
        for (const [key, value] of updates) await api.put('/api/super/settings', { key, value });
        report('Settings saved.');
        await load();
      } catch (err) { fail(err); }
    });

    $('#adv-save').addEventListener('click', async () => {
      const key = $('#adv-key').value.trim();
      if (!key) { fail(new Error('A setting key is required')); return; }
      try {
        await api.put('/api/super/settings', { key, value: $('#adv-value').value });
        $('#adv-key').value = '';
        $('#adv-value').value = '';
        report(`Setting "${key}" saved.`);
        await load();
      } catch (err) { fail(err); }
    });
  }

  function paintSettings() {
    if (!built.settings) { built.settings = true; buildSettings(); }
    const current = Object.fromEntries(state.settings.map((s) => [s.key, String(s.value)]));
    const fields = SETTING_SCHEMA.map((spec) => {
      const value = current[spec.key] ?? '';
      let control;
      if (spec.type === 'bool') {
        control = html`<label class="check-label" for="set-${spec.key}">
          <input type="checkbox" id="set-${spec.key}" ${value === '1' ? 'checked' : ''}> Enabled</label>`;
      } else if (spec.type === 'select') {
        control = html`<select id="set-${spec.key}">
          ${spec.options.map(([v, label]) => html`<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`)}
        </select>`;
      } else if (spec.type === 'number') {
        control = html`<input id="set-${spec.key}" type="number" min="${spec.min}" max="${spec.max}" value="${esc(value)}">`;
      } else {
        control = html`<input id="set-${spec.key}" value="${esc(value)}">`;
      }
      return html`
        <div class="field">
          <label for="set-${spec.key}">${spec.label}</label>
          ${control}
          <p class="hint">${spec.hint}</p>
        </div>`;
    });
    render('#settings-fields', html`${fields}`);

    const extra = state.settings.filter((s) => !SETTING_SCHEMA.some((spec) => spec.key === s.key));
    if (!extra.length) return render('#settings-extra', '');
    render('#settings-extra', html`
      <div class="card" style="margin-top:18px;box-shadow:none;background:#f8fafc">
        <h4>Other stored settings</h4>
        <p class="meta">These keys are not covered by the form above. They are preserved unchanged when you save.</p>
        <div class="table-scroll">
          <table>
            <caption class="visually-hidden">Settings not covered by the form above</caption>
            <thead><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
            <tbody>${extra.map((s) => html`<tr><th scope="row">${s.key}</th><td class="meta">${s.value}</td></tr>`)}</tbody>
          </table>
        </div>
      </div>`);
  }

  /* ------------------------------------------------------------------ *
   * Audit trail
   * ------------------------------------------------------------------ */
  function buildAudit() {
    render(pane('audit'), html`
      <h3>Audit trail</h3>
      <p class="meta">
        The most recent ${state.logs.length} recorded events. Ballot contents are never logged: a vote is
        stored as an anonymous selection set, so no entry here can reveal how a person voted.
      </p>
      <div class="filterbar">
        <div class="field">
          <label for="log-search">Search the trail</label>
          <input id="log-search" type="search" placeholder="Actor, action or detail" value="${state.logFilter.q}">
        </div>
        <div class="field">
          <label for="filter-action">Event type</label>
          <select id="filter-action"><option value="">All events</option></select>
        </div>
      </div>
      <div id="log-list-slot"></div>`);

    $('#log-search').addEventListener('input', debounce((ev) => { state.logFilter.q = ev.target.value; paintAudit(); }, 200));
    $('#filter-action').addEventListener('change', (ev) => { state.logFilter.action = ev.target.value; paintAudit(); });
  }

  function paintAudit() {
    if (!built.audit) { built.audit = true; buildAudit(); }
    const actions = Array.from(new Set(state.logs.map((l) => l.action))).sort();
    const sel = $('#filter-action');
    if (sel.options.length - 1 !== actions.length) {
      sel.innerHTML = `<option value="">All events</option>${actions.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}`;
      sel.value = state.logFilter.action;
    }
    const term = state.logFilter.q.toLowerCase();
    const rows = state.logs.filter((l) => {
      if (state.logFilter.action && l.action !== state.logFilter.action) return false;
      if (!term) return true;
      return `${l.actor || ''} ${l.action} ${l.details || ''}`.toLowerCase().includes(term);
    });
    const slot = $('#log-list-slot');
    if (!rows.length) {
      return render(slot, emptyState('No events match', 'Try a different search term or event type.'));
    }
    render(slot, html`
      <p class="meta" role="status">${plural(rows.length, 'event')} shown.</p>
      <div class="table-scroll">
        <table>
          <caption class="visually-hidden">System audit trail</caption>
          <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Event</th><th scope="col">Detail</th></tr></thead>
          <tbody>${rows.map((l) => html`
            <tr>
              <td class="meta nowrap">${fmtDate(l.created_at)}</td>
              <td class="meta">${l.actor || 'system'}</td>
              <td><code>${l.action}</code></td>
              <td class="meta">${l.details || ''}</td>
            </tr>`)}</tbody>
        </table>
      </div>`);
  }

  await load();
});
