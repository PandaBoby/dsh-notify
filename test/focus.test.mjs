import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { buildFocusCommand, runFocusCommand } from '../lib/focus.js';

function fakeSpawn({ code = 0, stderr = '' } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.text = '';
    child.stderr.text = '';
    child.kill = () => {};
    child.args = args;
    child.options = options;
    setImmediate(() => {
      if (stderr !== '') child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

test('buildFocusCommand targets the dsh focus deep link per platform', () => {
  assert.deepEqual(buildFocusCommand('darwin'), { command: '/usr/bin/open', args: ['dsh://open'] });
  assert.deepEqual(buildFocusCommand('linux'), { command: 'xdg-open', args: ['dsh://open'] });
  assert.equal(buildFocusCommand('freebsd'), null);

  const windows = buildFocusCommand('win32');
  assert.equal(windows.command, 'powershell.exe');
  assert.deepEqual(windows.args.slice(0, -1), [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
  ]);
  const script = Buffer.from(windows.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /dsh:\/\/open/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /SetWindowPos/);
  assert.match(script, /SwitchToThisWindow/);
  assert.match(script, /ShowWindow/);
  assert.match(script, /\*DeepSeek\*/);
});

test('runFocusCommand settles on the helper exit status', async () => {
  const success = await runFocusCommand({ platform: 'darwin', spawnFn: fakeSpawn({ code: 0 }) });
  assert.equal(success.ok, true);
  assert.equal(success.command, '/usr/bin/open');

  const failure = await runFocusCommand({
    platform: 'win32',
    spawnFn: fakeSpawn({ code: 3, stderr: 'main window not found' }),
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 3);
  assert.match(failure.error, /main window not found/);
});

test('runFocusCommand refuses unsupported platforms without spawning', async () => {
  let spawned = false;
  const result = await runFocusCommand({
    platform: 'freebsd',
    spawnFn: () => {
      spawned = true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(spawned, false);
});
