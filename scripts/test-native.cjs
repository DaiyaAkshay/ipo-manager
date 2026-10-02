// Run the same tests with Electron's Node ABI so encrypted SQLite tests execute.
const { spawnSync } = require('node:child_process');
const { dirname, join } = require('node:path');
const electron = require('electron');
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const result = spawnSync(electron, [vitest, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
