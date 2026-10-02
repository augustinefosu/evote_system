// Student / staff sign-in.
document.addEventListener('DOMContentLoaded', () => {
  navRender(null);
  const form = document.getElementById('login-form');
  const identifier = document.getElementById('identifier');
  const password = document.getElementById('password');
  const submit = form.querySelector('button[type=submit]');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showMsg('msg', 'Signing in…', true);
    submit.disabled = true;
    try {
      const r = await api.post('/api/auth/login', {
        identifier: identifier.value.trim(),
        password: password.value,
      });
      localStorage.setItem('evs_user', JSON.stringify(r.user));
      toast('Signed in. Redirecting…', 'ok', 2000);
      location.href = homeFor(r.user.role);
    } catch (err) {
      showMsg('msg', err.message, false);
      password.value = '';
      password.focus();
    } finally {
      submit.disabled = false;
    }
  });
});
