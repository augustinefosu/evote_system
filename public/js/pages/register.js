// Student self-registration.
document.addEventListener('DOMContentLoaded', () => {
  navRender(null);
  const form = document.getElementById('register-form');
  const submit = form.querySelector('button[type=submit]');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    const payload = {
      name: document.getElementById('name').value.trim(),
      student_id: document.getElementById('student_id').value.trim(),
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
      faculty: document.getElementById('faculty').value.trim(),
      department: document.getElementById('department').value.trim(),
      level: document.getElementById('level').value.trim(),
    };
    try {
      const r = await api.post('/api/auth/register', payload);
      // With SMTP configured the token is only ever emailed. Without it the
      // API returns the token so the flow stays testable on a fresh machine.
      if (r.verification_token) {
        const body = document.createElement('div');
        const p = document.createElement('p');
        p.textContent = 'Account created. This demo has no mail server configured, so your verification token is shown below.';
        const code = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = r.verification_token;
        code.appendChild(strong);
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'btn gold';
        go.textContent = 'Continue to verification';
        go.addEventListener('click', () => {
          location.href = `/verify.html#${encodeURIComponent(r.verification_token)}`;
        });
        actions.appendChild(go);
        body.append(p, code, actions);
        await dialog({ title: 'Verify your account', body, confirmLabel: 'Close', showCancel: false });
      }
      showMsg('msg', r.message, true);
      setTimeout(() => { location.href = '/verify.html'; }, 1200);
    } catch (err) {
      showMsg('msg', err.message, false);
    } finally {
      submit.disabled = false;
    }
  });
});
