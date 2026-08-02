#!/usr/bin/env node

const pty = await import('node-pty');
const windows = process.platform === 'win32';
const shell = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
const args = windows
  ? ['/d', '/s', '/c', 'echo lit-shell-pty-ok']
  : ['-c', 'printf lit-shell-pty-ok'];
const terminal = pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

await new Promise((resolve, reject) => {
  let output = '';
  let exited = false;
  let exitCode;
  const timer = setTimeout(() => {
    try {
      terminal.kill();
    } catch {
      // The PTY may have exited while the timeout callback was queued.
    }
    reject(new Error(`PTY smoke timed out. Output: ${JSON.stringify(output)}`));
  }, 10_000);

  const finish = () => {
    if (!exited || !output.includes('lit-shell-pty-ok')) return;
    clearTimeout(timer);
    if (exitCode === 0) resolve();
    else
      reject(
        new Error(`PTY exited with ${exitCode}: ${JSON.stringify(output)}`),
      );
  };

  terminal.onData((data) => {
    output += data;
    finish();
  });
  terminal.onExit((event) => {
    exited = true;
    exitCode = event.exitCode;
    finish();
  });
});

console.log(`pty-smoke-ok (${process.platform})`);
