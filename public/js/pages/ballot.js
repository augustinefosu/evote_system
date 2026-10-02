// The ballot: select candidates, review, then submit once.
//
// Selection limits are enforced here for immediate feedback, but the server
// re-validates everything independently — this file is a convenience layer,
// never the security boundary.
document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  navRender(user);
  markCurrentNav();

  const stepBallot = document.getElementById('step-ballot');
  const stepReview = document.getElementById('step-review');
  const stepDone = document.getElementById('step-done');
  const electionId = new URLSearchParams(location.search).get('id');

  let data = null;
  let selections = {}; // positionId -> array of candidateIds

  if (!electionId) {
    render(stepDone, html`<div class="card"><h2>No election selected</h2><a class="btn" href="/dashboard.html">Back to dashboard</a></div>`);
    stepBallot.classList.add('hidden');
    return;
  }

  try {
    data = await api.get(`/api/elections/${encodeURIComponent(electionId)}`);
  } catch (err) {
    render(stepDone, html`<div class="card"><h2>Ballot unavailable</h2><p role="alert">${err.message}</p><a class="btn" href="/dashboard.html">Back to dashboard</a></div>`);
    stepBallot.classList.add('hidden');
    return;
  }

  const { election, positions, candidates, eligible, voted } = data;

  if (voted) {
    stepBallot.classList.add('hidden');
    render(stepDone, html`
      <div class="card">
        <h2>You have already voted</h2>
        <p>One student may cast only one ballot per election, and your vote has already been recorded.</p>
        <p class="meta">Your choices are secret and cannot be displayed or changed.</p>
        <p><a class="btn" href="/dashboard.html">Back to dashboard</a></p>
      </div>`);
    return;
  }
  if (election.display_status !== 'open') {
    stepBallot.classList.add('hidden');
    render(stepDone, html`
      <div class="card">
        <h2>Voting is not open</h2>
        <p>This election is currently <strong>${election.display_status}</strong>. ${STATUS_META[election.display_status] ? STATUS_META[election.display_status].hint : ''}</p>
        <p class="meta">Voting opened ${fmtDate(election.starts_at)} and closes ${fmtDate(election.ends_at)}.</p>
        <p><a class="btn" href="/dashboard.html">Back to dashboard</a></p>
      </div>`);
    return;
  }
  if (!eligible) {
    stepBallot.classList.add('hidden');
    render(stepDone, html`
      <div class="card">
        <h2>You are not eligible</h2>
        <p>Your student account is not on the electoral roll for this election. Contact the Returning Officer if you believe this is an error.</p>
        <p><a class="btn" href="/dashboard.html">Back to dashboard</a></p>
      </div>`);
    return;
  }
  if (!user.verified) {
    stepBallot.classList.add('hidden');
    render(stepDone, html`
      <div class="card">
        <h2>Verify your account first</h2>
        <p>Your account has not been verified, so you cannot vote yet.</p>
        <p><a class="btn" href="/verify.html">Verify account</a> <a class="btn ghost" href="/dashboard.html">Back</a></p>
      </div>`);
    return;
  }

  positions.forEach((p) => { selections[p.id] = []; });
  renderBallot();

  function candidatesFor(positionId) {
    return candidates.filter((c) => c.position_id === positionId);
  }

  function renderBallot() {
    stepReview.classList.add('hidden');
    stepDone.classList.add('hidden');
    stepBallot.classList.remove('hidden');

    const sections = positions.map((p) => {
      const list = candidatesFor(p.id);
      const multi = p.max_select > 1;
      const rule = p.min_select === p.max_select
        ? `Select ${p.min_select === 1 ? 'ONE' : p.min_select} candidate`
        : `Select between ${p.min_select} and ${p.max_select} candidates`;
      return html`
        <fieldset class="card" data-position="${p.id}">
          <legend>${p.title}</legend>
          <p class="meta" id="rule-${p.id}">
            <strong>${rule}.</strong>
            ${p.is_mandatory ? 'Mandatory — you must make a selection.' : 'Optional — you may abstain.'}
          </p>
          ${p.description ? html`<p class="meta">${p.description}</p>` : ''}
          ${list.length ? list.map((c) => html`
            <label class="ballot-option" data-position="${p.id}" data-candidate="${c.id}">
              <input type="${multi ? 'checkbox' : 'radio'}"
                     name="position-${p.id}"
                     value="${c.id}"
                     data-position="${p.id}"
                     aria-describedby="rule-${p.id}">
              <span class="mark" aria-hidden="true"></span>
              ${avatar(c, 56)}
              <span class="ballot-body">
                <strong>${c.name}</strong>
                <span class="meta" style="display:block">${[c.department, c.level ? `${c.level} Level` : '', c.affiliation].filter(Boolean).join(' · ')}</span>
                ${c.bio ? html`<span class="meta" style="display:block">${c.bio}</span>` : ''}
                <button type="button" class="btn small ghost" style="margin-top:8px" data-manifesto="${c.id}">View manifesto</button>
              </span>
            </label>`) : html`<p class="meta" role="alert">No candidates are available for this position. Contact the Returning Officer.</p>`}
        </fieldset>`;
    });

    render(stepBallot, html`
      <div class="card">
        <h2>${election.title} — Ballot</h2>
        <p class="meta">Voting closes ${fmtDate(election.ends_at)} · <span class="countdown" data-end="${election.ends_at}"></span></p>
        <p class="meta">Choose your candidate for each position, then review your ballot before submitting. You can only vote once.</p>
      </div>
      ${sections}
      <div class="card" style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" class="btn gold" id="review-button">Review my vote</button>
        <a class="btn ghost" href="/election.html?id=${election.id}">Back to election</a>
      </div>`);

    countdown($('.countdown', stepBallot), election.ends_at);

    // Selecting a candidate. The native control is inside the label, so
    // clicking the row, pressing Space, or using arrow keys all work.
    stepBallot.addEventListener('change', (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement) || !input.dataset.position) return;
      const positionId = Number(input.dataset.position);
      const candidateId = Number(input.value);
      const position = positions.find((p) => p.id === positionId);
      const current = selections[positionId] || [];

      if (input.checked) {
        if (current.length >= position.max_select) {
          // Refuse the extra choice and tell the voter why.
          input.checked = false;
          toast(`You may select at most ${position.max_select} candidate(s) for ${position.title}.`, 'error');
          return;
        }
        selections[positionId] = [...current, candidateId];
      } else {
        selections[positionId] = current.filter((id) => id !== candidateId);
      }
      syncSelectionStyles();
    });

    const byId = Object.fromEntries(candidates.map((c) => [String(c.id), c]));
    onDelegated(stepBallot, 'click', '[data-manifesto]', (ev, btn) => {
      ev.preventDefault();
      const candidate = byId[btn.dataset.manifesto];
      if (candidate) showManifesto(candidate);
    });

    $('#review-button', stepBallot).addEventListener('click', goToReview);
  }

  function syncSelectionStyles() {
    $$('.ballot-option', stepBallot).forEach((option) => {
      const positionId = Number(option.dataset.position);
      const candidateId = Number(option.dataset.candidate);
      const selected = (selections[positionId] || []).includes(candidateId);
      option.classList.toggle('selected', selected);
      const input = $('input', option);
      if (input) input.checked = selected;
    });
  }

  async function goToReview() {
    const problems = [];
    for (const p of positions) {
      const chosen = selections[p.id] || [];
      if (chosen.length > p.max_select) problems.push(`${p.title}: choose at most ${p.max_select}.`);
      if (p.is_mandatory && chosen.length < p.min_select) {
        problems.push(`${p.title} is mandatory — select at least ${p.min_select} candidate(s), or it will be recorded as an abstention.`);
      }
    }
    if (problems.length) {
      await dialog({ title: 'Your ballot is not complete', body: problems.join('\n\n'), confirmLabel: 'Back to ballot', showCancel: false });
      return;
    }

    const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
    const rows = positions.map((p) => {
      const chosen = selections[p.id] || [];
      return html`
        <tr>
          <th scope="row">${p.title}</th>
          <td>${chosen.length
            ? chosen.map((id) => byId[id] ? byId[id].name : 'Unknown candidate')
            : html`<em>Abstained</em>`}</td>
        </tr>`;
    });

    stepBallot.classList.add('hidden');
    stepReview.classList.remove('hidden');
    render(stepReview, html`
      <div class="card">
        <h2>Review your vote</h2>
        <p class="meta">${election.title}</p>
        <div class="table-scroll">
          <table>
            <caption class="visually-hidden">Your selections for each position</caption>
            <thead><tr><th scope="col">Position</th><th scope="col">Your selection</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="alert error" role="alert">
          Please check your selections carefully. Once you submit, your vote is final and cannot be changed.
        </div>
        <div class="field">
          <label style="display:flex;gap:10px;align-items:flex-start;font-weight:600">
            <input type="checkbox" id="confirm-choice">
            <span>I confirm these selections are correct and I understand they are final.</span>
          </label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn ghost" id="back-button">Back to ballot</button>
          <button type="button" class="btn gold" id="submit-button">SUBMIT MY VOTE</button>
        </div>
      </div>`);

    $('#back-button', stepReview).addEventListener('click', () => {
      stepReview.classList.add('hidden');
      stepBallot.classList.remove('hidden');
    });
    $('#submit-button', stepReview).addEventListener('click', submit);
  }

  async function submit() {
    const confirmBox = $('#confirm-choice', stepReview);
    const button = $('#submit-button', stepReview);
    if (!confirmBox.checked) {
      toast('Please tick the confirmation box before submitting.', 'error');
      confirmBox.focus();
      return;
    }
    const agreed = await confirmAction(
      'Submit your vote?',
      'This is your only ballot in this election and it cannot be changed or withdrawn. Continue?',
      'Submit my vote',
    );
    if (!agreed) return;

    button.disabled = true;
    button.textContent = 'Recording your vote…';
    try {
      const payload = {};
      for (const key of Object.keys(selections)) payload[key] = selections[key];
      const r = await api.post(`/api/elections/${election.id}/vote`, { selections: payload });
      showReceipt(r.reference_code);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'SUBMIT MY VOTE';
      await dialog({ title: 'Your vote was not recorded', body: err.message, confirmLabel: 'Back to ballot', showCancel: false });
    }
  }

  function showReceipt(reference) {
    stepBallot.classList.add('hidden');
    stepReview.classList.add('hidden');
    stepDone.classList.remove('hidden');
    render(stepDone, html`
      <div class="receipt">
        <h2>✓ Vote successfully cast</h2>
        <p>Your vote has been recorded successfully.</p>
        <p class="meta">Confirmation reference</p>
        <p><code class="ref">${reference}</code></p>
        <p class="meta">Keep this reference for your records.</p>
        <div class="alert ok" style="text-align:left">
          Your individual choices are secret. They are stored separately from your identity and will not be
          displayed again — not by you, and not by an administrator.
        </div>
        <p style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:0">
          <a class="btn" href="/dashboard.html">Back to dashboard</a>
          <button type="button" class="btn ghost" id="copy-ref">Copy reference</button>
        </p>
      </div>`);

    $('#copy-ref', stepDone).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(reference);
        toast('Reference copied to clipboard', 'ok');
      } catch {
        toast('Could not copy automatically — please write it down.', 'error');
      }
    });
  }
});
