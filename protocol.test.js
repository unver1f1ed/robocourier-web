import test from 'node:test';
import assert from 'node:assert/strict';
import { LineAssembler, parseReply, RobotModel, COMMANDS, MISSION_STATES } from './protocol.js';

const bytes = (s) => new TextEncoder().encode(s);

test('line split across three chunks', () => {
  const a = new LineAssembler();
  assert.deepEqual(a.append(bytes('AT TER')), []);
  assert.deepEqual(a.append(bytes('MINAL')), []);
  assert.deepEqual(a.append(bytes(' 2\r\n')), ['AT TERMINAL 2']);
});

test('two lines in one chunk, and a line straddling chunks', () => {
  const a = new LineAssembler();
  assert.deepEqual(a.append(bytes('READY\r\nstate 0\r\n')), ['READY', 'state 0']);
  assert.deepEqual(a.append(bytes('STA')), []);
  assert.deepEqual(a.append(bytes('RT\r\nsta')), ['START']);
  assert.deepEqual(a.append(bytes('te 1\r\n')), ['state 1']);
});

test('bare newline, empty lines, reset, overflow', () => {
  const a = new LineAssembler();
  assert.deepEqual(a.append(bytes('STOP\n')), ['STOP']);
  assert.deepEqual(a.append(bytes('\r\n\r\nSTOP\r\n')), ['STOP']);
  a.append(bytes('REA'));
  a.reset();
  assert.deepEqual(a.append(bytes('STOP\r\n')), ['STOP']);
  const long = 'A'.repeat(300);
  assert.deepEqual(a.append(bytes(long)), [long]);
  assert.deepEqual(a.append(bytes('B\n')), ['B']);
});

test('reply parsing', () => {
  const cases = [
    ['READY', { type: 'ready' }],
    ['START', { type: 'started' }],
    ['RESUME', { type: 'resumed' }],
    ['STOP', { type: 'stopped' }],
    ['AT TERMINAL 2', { type: 'atTerminal', value: 2 }],
    ['AT TERMINAL 1', { type: 'atTerminal', value: 1 }],
    ['state 0', { type: 'state', value: 0 }],
    ['state 10', { type: 'state', value: 10 }],
    ['ERR line lost - resend Start', { type: 'error', message: 'line lost - resend Start' }],
    ['ERR color sensor 0x29', { type: 'error', message: 'color sensor 0x29' }],
    ['state x', { type: 'unknown', line: 'state x' }],
    ['ready', { type: 'unknown', line: 'ready' }],
    ['hello', { type: 'unknown', line: 'hello' }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseReply(input), expected, input);
});

test('commands match docs/PROTOCOL.md', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, v.byte])),
    { start: 'X', turn: 'Y', returnHome: 'U', recheck: 'G', stop: 'S' });
  assert.equal(MISSION_STATES.length, 11);
});

test('model: state, error and pause handling', () => {
  const m = new RobotModel();
  m.onConnected();
  m.onData(bytes('state '));
  m.onData(bytes('1\r\n'));
  assert.equal(m.missionTitle, 'Їде до терміналу 2');
  m.onData(bytes('ERR line lost - resend Start\r\n'));
  assert.equal(m.lastError, 'line lost - resend Start');
  m.onData(bytes('START\r\n'));
  assert.equal(m.lastError, null);
  m.onData(bytes('STOP\r\n'));
  assert.equal(m.paused, true);
  m.onData(bytes('RESUME\r\n'));
  assert.equal(m.paused, false);
  m.onData(bytes('state 11\r\n'));
  assert.equal(m.missionTitle, null);
});
