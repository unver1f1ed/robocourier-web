import test from 'node:test';
import assert from 'node:assert/strict';
import { LineAssembler, parseReply, RobotModel, COMMANDS, MISSION_STATES, resumeCommandFor, commandForError } from './protocol.js';
import { MockTransport } from './transport.js';

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

test('mission replies from the full firmware', () => {
  const cases = [
    ['MATCH RED', { type: 'match', color: 'RED' }],
    ['WRONG BLUE', { type: 'wrong', color: 'BLUE' }],
    ['NO OBJECT', { type: 'noObject' }],
    ['EMPTY', { type: 'empty' }],
    ['SWAP', { type: 'swap' }],
    ['RECHECK', { type: 'recheck' }],
    ['GRAB without color sensor', { type: 'manualGrab' }],
    ['GRABBED', { type: 'grabbed' }],
    ['TURN', { type: 'turning' }],
    ['TURNED', { type: 'turned' }],
    ['RETURN', { type: 'returning' }],
    ['DONE', { type: 'done' }],
    ['toString', { type: 'unknown', line: 'toString' }],   // no prototype lookups
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseReply(input), expected, input);
});

test('next action follows the brief', () => {
  const m = new RobotModel();
  const feed = (s) => m.onData(bytes(s + '\r\n'));
  feed('READY');
  assert.equal(m.nextAction.cmd, 'start');
  feed('START'); feed('state 1');
  assert.equal(m.nextAction.cmd, null);
  assert.equal(m.stepIndex, 0);
  feed('AT TERMINAL 2'); feed('state 2'); feed('WRONG BLUE'); feed('state 3');
  assert.equal(m.led, 'blink3');
  assert.equal(m.stepIndex, 1);
  assert.match(m.nextAction.text, /Замініть циліндр/);
  feed('SWAP'); feed('state 2'); feed('MATCH RED'); feed('state 4');
  assert.equal(m.led, 'steady');
  assert.deepEqual(m.checks, [{ color: 'BLUE', match: false }, { color: 'RED', match: true }]);
  feed('GRABBED'); feed('state 5');
  assert.equal(m.nextAction.cmd, 'turn');
  feed('TURN'); feed('state 6'); feed('STOP');
  assert.equal(m.nextAction.cmd, 'turn');          // resume a paused turn with «Розворот»
  feed('RESUME'); feed('TURNED'); feed('state 7');
  assert.equal(m.nextAction.cmd, 'returnHome');
  feed('RETURN'); feed('state 8'); feed('ERR line lost - resend Return');
  assert.equal(m.nextAction.cmd, 'returnHome');    // retry after a failure
  feed('RESUME'); feed('AT TERMINAL 1'); feed('state 9'); feed('DONE'); feed('state 10');
  assert.equal(m.led, 'off');
  assert.equal(m.nextAction.cmd, 'start');
});

test('no color sensor: G grabs', () => {
  const m = new RobotModel();
  const feed = (s) => m.onData(bytes(s + '\r\n'));
  feed('START'); feed('state 2'); feed('ERR no color sensor - send G to grab');
  assert.equal(m.noColorSensor, true);
  assert.equal(m.nextAction.cmd, 'recheck');
  feed('GRAB without color sensor'); feed('state 4');
  assert.equal(m.lastError, null);
  assert.deepEqual(m.checks, [{ color: null, match: true }]);
});

test('resume and error commands match the firmware', () => {
  assert.equal(resumeCommandFor(1), 'start');
  assert.equal(resumeCommandFor(3), 'recheck');
  assert.equal(resumeCommandFor(6), 'turn');
  assert.equal(resumeCommandFor(9), 'returnHome');
  assert.equal(resumeCommandFor(5), null);
  assert.equal(commandForError('line lost - resend Start'), 'start');
  assert.equal(commandForError('turn - line not found, resend Turn'), 'turn');
  assert.equal(commandForError('no color sensor - send G to grab'), 'recheck');
  assert.equal(commandForError('motor driver 0x47'), null);
});

test('mock robot plays the whole mission', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = new MockTransport();
  const m = new RobotModel();
  mock.onStatus = () => {};
  mock.onData = (b) => m.onData(b);
  // Advance in small steps: timers scheduled inside a tick only fire on a later tick.
  const run = (ms) => { for (let i = 0; i < ms / 50; i++) t.mock.timers.tick(50); };
  mock.connect();
  run(1000);
  assert.equal(m.missionState, 0);
  const press = (ch) => mock.write(new Uint8Array([ch.charCodeAt(0)]));
  press('X');
  run(30000);
  assert.equal(m.missionState, 5);
  assert.deepEqual(m.checks.map((c) => c.match), [false, false, true]);
  press('Y');
  run(5000);
  assert.equal(m.missionState, 7);
  press('U');
  run(10000);
  assert.equal(m.missionState, 10);
});
