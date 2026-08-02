import { spawn } from 'node:child_process';

// Dev harness: vite dev server + electron pointed at it.
const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
  stdio: 'inherit',
  shell: true,
});

setTimeout(() => {
  const electron = spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, FLARE_DEV_URL: 'http://localhost:5199' },
  });
  electron.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
}, 1500);
