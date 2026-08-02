#!/usr/bin/env node

const readyMarker = 'lit-shell-pty-ready';
const inputMarker = 'lit-shell-pty-input';
const outputMarker = 'lit-shell-pty-ok';
const childProgram = [
  `process.stdout.write(${JSON.stringify(readyMarker)});`,
  "process.stdin.setEncoding('utf8');",
  `process.stdin.on('data',(data)=>{if(data.includes(${JSON.stringify(inputMarker)})){process.stdout.write(${JSON.stringify(outputMarker)},()=>process.exit(0));}});`,
  'process.stdin.resume();',
].join('');

const pty = await import('node-pty');
const terminal = pty.spawn(process.execPath, ['--eval', childProgram], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

const cleanupWatchdog = setTimeout(() => {
  console.error('PTY smoke left active handles after cleanup.');
  process.exit(1);
}, 15_000);
cleanupWatchdog.unref();

try {
  await verifyPty(terminal);
} finally {
  // ConPTY can retain native pipe handles after the child exits unless the
  // terminal is explicitly closed.
  try {
    terminal.kill();
  } catch {
    // The child may already have released the PTY.
  }
}

console.log(`pty-smoke-ok (${process.platform})`);

function verifyPty(terminal) {
  return new Promise((resolve, reject) => {
    let output = '';
    let exited = false;
    let exitCode;
    let inputSent = false;
    let settled = false;
    let dataSubscription;
    let exitSubscription;

    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (error === undefined) resolve();
      else reject(error);
    };

    const finish = () => {
      if (!exited || !output.includes(outputMarker)) return;
      if (exitCode === 0) settle();
      else {
        settle(
          new Error(`PTY exited with ${exitCode}: ${JSON.stringify(output)}`),
        );
      }
    };

    const timer = setTimeout(() => {
      settle(
        new Error(`PTY smoke timed out. Output: ${JSON.stringify(output)}`),
      );
    }, 10_000);

    dataSubscription = terminal.onData((data) => {
      output += data;
      if (!inputSent && output.includes(readyMarker)) {
        inputSent = true;
        terminal.write(`${inputMarker}\r`);
      }
      finish();
    });
    exitSubscription = terminal.onExit((event) => {
      exited = true;
      exitCode = event.exitCode;
      finish();
    });
  });
}
