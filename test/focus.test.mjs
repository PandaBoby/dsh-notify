import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFocusCommand, focusDshWindow } from '../lib/focus.js';

test('buildFocusCommand targets the dsh focus deep link per platform', () => {
  assert.deepEqual(buildFocusCommand('darwin'), { command: '/usr/bin/open', args: ['dsh://open'] });
  assert.deepEqual(buildFocusCommand('win32'), {
    command: 'cmd.exe',
    args: ['/c', 'start', '', 'dsh://open'],
  });
  assert.deepEqual(buildFocusCommand('linux'), { command: 'xdg-open', args: ['dsh://open'] });
  assert.equal(buildFocusCommand('freebsd'), null);
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
