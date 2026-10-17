// Pure protocol logic, no browser APIs. Mirrors ios/RoboCourierRemote/Protocol (docs/PROTOCOL.md).

export const COMMANDS = {
  start:      { byte: 'X', title: 'Старт' },
  turn:       { byte: 'Y', title: 'Розворот' },
  returnHome: { byte: 'U', title: 'Повернення' },
  recheck:    { byte: 'G', title: 'Перевірити колір' },
  stop:       { byte: 'S', title: 'СТОП' },
};

export const MISSION_STATES = [
  'Очікування на старті',     // 0
  'Їде до терміналу 2',       // 1
  'Перевірка кольору',        // 2
  'Чекає заміну циліндра',    // 3
  'Захоплення',               // 4
  'Чекає «Розворот»',         // 5
  'Розворот',                 // 6
  'Чекає «Повернення»',       // 7
  'Повертається',             // 8
  'Розвантаження',            // 9
  'Готово',                   // 10
];

export const MAX_LINE_BYTES = 256;

/** Turns BLE notification chunks (<= 20 bytes) into complete text lines split on "\n". */
export class LineAssembler {
  constructor() {
    this.buffer = [];
    this.decoder = new TextDecoder('utf-8');
  }

  append(bytes) {
    const lines = [];
    for (const b of bytes) {
      if (b === 0x0a) {
        this.#flush(lines);
      } else {
        this.buffer.push(b);
      }
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.#flush(lines);
    return lines;
  }

  reset() {
    this.buffer = [];
  }

  #flush(lines) {
    const text = this.decoder.decode(new Uint8Array(this.buffer)).trim();
    this.buffer = [];
    if (text) lines.push(text);
  }
}

/** Parses one reply line. Unknown lines are kept as {type: 'unknown'}. */
export function parseReply(line) {
  switch (line) {
    case 'READY':  return { type: 'ready' };
    case 'START':  return { type: 'started' };
    case 'RESUME': return { type: 'resumed' };
    case 'STOP':   return { type: 'stopped' };
  }
  if (line.startsWith('ERR ')) return { type: 'error', message: line.slice(4) };
  const terminal = numberAfter('AT TERMINAL ', line);
  if (terminal !== null) return { type: 'atTerminal', value: terminal };
  const state = numberAfter('state ', line);
  if (state !== null) return { type: 'state', value: state };
  return { type: 'unknown', line };
}

function numberAfter(prefix, line) {
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  return /^-?\d+$/.test(rest) ? Number(rest) : null;
}

/** Observable robot state: feed it chunks, read the fields. */
export class RobotModel {
  constructor() {
    this.assembler = new LineAssembler();
    this.missionState = null;   // index into MISSION_STATES, or null when unknown
    this.paused = false;
    this.lastError = null;
  }

  onConnected() {
    this.assembler.reset();
    this.missionState = null;
    this.paused = false;
    this.lastError = null;
  }

  /** Returns the lines that were completed by this chunk. */
  onData(bytes) {
    const lines = this.assembler.append(bytes);
    for (const line of lines) this.#apply(parseReply(line));
    return lines;
  }

  get missionTitle() {
    return this.missionState === null ? null : MISSION_STATES[this.missionState] ?? null;
  }

  #apply(reply) {
    switch (reply.type) {
      case 'ready':
        this.missionState = 0; this.paused = false; this.lastError = null; break;
      case 'started':
      case 'resumed':
        this.paused = false; this.lastError = null; break;
      case 'stopped':
        this.paused = true; break;
      case 'state':
        this.missionState = reply.value >= 0 && reply.value < MISSION_STATES.length ? reply.value : null; break;
      case 'error':
        this.lastError = reply.message; break;
    }
  }
}
