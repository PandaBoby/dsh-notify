import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFocusCommand, focusDshWindow } from '../lib/focus.js';

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
  assert.match(script, /ShowWindow/);
  assert.match(script, /\*DeepSeek\*/);
});

test('focusDshWindow starts a detached command with fixed argv', () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  assert.equal(focusDshWindow({ platform: 'darwin', spawnFn: fakeSpawn }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/open');
  assert.deepEqual(calls[0].args, ['dsh://open']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
});

test('focusDshWindow reports unsupported platforms and spawn failures', () => {
  assert.equal(focusDshWindow({ platform: 'freebsd', spawnFn: () => { throw new Error('unused'); } }), false);
  const throwing = () => {
    throw new Error('spawn unavailable');
  };
  assert.equal(focusDshWindow({ platform: 'darwin', spawnFn: throwing }), false);
});
