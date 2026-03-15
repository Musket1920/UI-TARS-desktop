const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = require.resolve('@playwright/test/cli');
const forwardedArgs = process.argv.slice(2);
const normalizedArgs =
  forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
const outDir = resolve(__dirname, '../out');
const shouldBuild = process.env.CI ? true : !existsSync(outDir);
const buildCommand = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm';
const buildArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm run build:e2e'] : ['run', 'build:e2e'];

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

if (shouldBuild) {
  runCommand(buildCommand, buildArgs);
}

runCommand(process.execPath, [cliPath, 'test', ...normalizedArgs]);
