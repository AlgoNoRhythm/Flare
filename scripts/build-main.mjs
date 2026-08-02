import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', '@lydell/node-pty'],
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });

// the browser server: same backend, no Electron, so `electron` stays external
// only because nothing in this graph reaches it
await build({ ...common, entryPoints: ['server/index.ts'], outfile: 'dist-server/index.cjs' });
