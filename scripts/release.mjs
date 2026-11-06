// Builds the current source into a separate "play" folder that only changes when
// a verified version is released. Development (dev server, dist/, tests) never touches it.
import { execSync } from 'node:child_process';
import { cpSync, rmSync, writeFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const rm = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

run('npx tsc --noEmit');
run('npx vite build --outDir play-next --emptyOutDir');
// Copy instead of rename: on Windows a file watcher (e.g. the dev server) can hold a
// handle on the fresh folder and make rename fail with EPERM.
rm('play');
cpSync('play-next', 'play', { recursive: true });
rm('play-next');
writeFileSync('play/RELEASE.txt', `released ${new Date().toISOString()}\n`);
console.log('Released to play/ — serve with: npm run play  (http://localhost:4300, also reachable on the LAN)');
