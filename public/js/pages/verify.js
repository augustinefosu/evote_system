// Account verification, password reset request and password reset.
// Handles deep links emailed to students: /verify.html#<token> for
// verification and /verify.html#reset-<token> for a password reset.
document.addEventListener('DOMContentLoaded', async () => {
  const verifyForm = document.getElementById('verify-form');
  const forgotForm = document.getElementById('forgot-form');
  const resetForm = document.getElementById('reset-form');
  const tokenField = document.getElementById('token');
  const resetTokenField = document.getElementById('reset-token');
  const emailField = document.getElementById('email');
  const newPassword = document.getElementById('new-password');

  verifyForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post('/api/auth/verify', { token: tokenField.value.trim() });
      showMsg('verify-msg', r.message, true);
      tokenField.value = '';
    } catch (err) {
      showMsg('verify-msg', err.message, false);
    }
  });

  forgotForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api.post('/api/auth/forgot', { email: emailField.value.trim() });
      // The response is intentionally identical whether or not the address
      // exists, so this screen cannot be used to enumerate students.
      if (r.reset_token) {
        showMsg('forgot-msg', `${r.message} (Demo: no mail server configured, so the token is shown here.)`, true);
        resetTokenField.value = r.reset_token;
        resetForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        newPassword.focus();
      } else {
        showMsg('forgot-msg', r.message, true);
      }
    } catch (err) {
      showMsg('forgot-msg', err.message, false);
    }
  });

  resetForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (newPassword.value.length < 8) {
      showMsg('reset-msg', 'Password must be at least 8 characters.', false);
      return;
    }
    try {
      const r = await api.post('/api/auth/reset', {
        token: resetTokenField.value.trim(),
        new_password: newPassword.value,
      });
      showMsg('reset-msg', r.message, true);
      newPassword.value = '';
      setTimeout(() => { location.href = '/login.html'; }, 1500);
    } catch (err) {
      showMsg('reset-msg', err.message, false);
    }
  });

  // Apply a token from the emailed link, if present.
  const hash = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (!hash) return;
  if (hash.startsWith('reset-')) {
    resetTokenField.value = hash.slice(6);
    showMsg('reset-msg', 'Reset token filled from your email link. Choose a new password, then press Reset.', true);
    resetForm.scrollIntoView({ block: 'center' });
    newPassword.focus();
  } else {
    tokenField.value = hash;
    showMsg('verify-msg', 'Verifying your account…', true);
    try {
      const r = await api.post('/api/auth/verify', { token: hash });
      showMsg('verify-msg', `${r.message} You can now log in.`, true);
      tokenField.value = '';
    } catch (err) {
      showMsg('verify-msg', err.message, false);
    }
  }
});
