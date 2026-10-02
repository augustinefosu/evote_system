// Landing page: resolve the current session so the header shows the right links.
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const { user } = await api.me();
    navRender(user);
  } catch {
    navRender(null);
  }
  markCurrentNav();
});
