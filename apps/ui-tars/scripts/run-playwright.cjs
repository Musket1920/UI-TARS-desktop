const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = require.resolve('@playwright/test/cli');
const forwardedArgs = process.argv.slice(2);
const normalizedArgs =
  forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
const outDir = resolve(__dirname, '../out');

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

if (!existsSync(outDir)) {
  runCommand('npm', ['run', 'build:e2e'], { shell: true });
}

runCommand(process.execPath, [cliPath, 'test', ...normalizedArgs]);
