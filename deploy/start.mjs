import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const root = '/app';
const serverDataDir = join(root, 'packages/mcp-server');
const persistentDir = process.env.MOCHI_DATA_DIR || '/mochi-data';
const persistedFiles = [
  'wallet-state.json',
  'audit-log.jsonl',
  'collections.json',
  'contacts.json',
  'payment-policy.json',
  'payments.json',
  'policy.json',
];

await mkdir(persistentDir, { recursive: true });
for (const name of persistedFiles) {
  const source = join(serverDataDir, name);
  const target = join(persistentDir, name);
  const destination = join(serverDataDir, name);
  let targetExists = false;
  try {
    await lstat(target);
    targetExists = true;
  } catch {
    // First boot: the EFS file is created when a tool writes to the symlink.
  }
  if (!targetExists) {
    try {
      const current = await lstat(destination);
      if (current.isFile() && !current.isSymbolicLink()) await copyFile(destination, target);
    } catch {
      // The state file is optional and can be created by the application.
    }
  }
  try {
    await unlink(destination);
  } catch {
    // The target does not exist in a fresh image.
  }
  await symlink(target, destination);
}

const env = { ...process.env };
const children = [
  spawn(process.execPath, ['packages/mcp-server/dist/index.js', '--http'], {
    cwd: root,
    env,
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--port', '3001', '--hostname', '0.0.0.0'], {
    cwd: join(root, 'packages/dashboard'),
    env: { ...env, PORT: '3001' },
    stdio: 'inherit',
  }),
];

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 60_000);
  timer.unref();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

for (const child of children) {
  child.on('error', (error) => {
    console.error('[mochi] child process failed to start:', error.message);
    stop('SIGTERM');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code && code !== 0 ? code : 1;
      stop('SIGTERM');
    }
  });
}
