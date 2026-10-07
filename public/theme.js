// Applies the saved theme before the page paints, so there is no flash of the wrong one.
// "system" (or nothing saved) leaves data-theme unset and the OS preference decides.
(function applySavedTheme() {
  try {
    const theme = localStorage.getItem("vdev.theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {
    // storage unavailable; follow the system theme
  }
})();
