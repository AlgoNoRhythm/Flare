import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Strict CSP for the packaged app only — the dev server needs inline scripts for HMR.
function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const csp =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'";
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: './',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
