/*
 * The theme, before anything is painted.
 *
 * A classic, same-origin script in the head, run synchronously: it has to
 * finish before the document is laid out, or a viewer who chose light gets a
 * dark flash on every load. Doing it in the app's own startup is a frame too
 * late, and doing it inline is refused outright — the packaged build ships
 * `script-src 'self'`, so an inline block is dropped and the flash comes back
 * silently, in the build nobody runs during development.
 *
 * It has one job and duplicates four lines of theme.ts to do it. Keep the two
 * in step: this decides what is painted, and that decides what is stored.
 */
(function () {
  try {
    var choice = localStorage.getItem('flare.theme');
    var theme =
      choice === 'light' || choice === 'dark'
        ? choice
        : window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* storage or matchMedia unavailable: the default palette is already correct */
  }
})();
