// Pure protocol logic, no browser APIs. Mirrors docs/PROTOCOL.md in the RoboCourier repo.

export const COMMANDS = {
  start:      { byte: 'X', title: 'Старт' },
  turn:       { byte: 'Y', title: 'Розворот' },
  returnHome: { byte: 'U', title: 'Повернення' },
  recheck:    { byte: 'G', title: 'Перевірити колір' },
  stop:       { byte: 'S', title: 'СТОП' },
};

// Index = firmware `enum State` value (RoboCourier.ino).
export const MISSION_STATES = [
  'Очікування на старті',     // 0 ST_IDLE
  'Їде до терміналу 2',       // 1 ST_FOLLOW_OUT
  'Перевірка кольору',        // 2 ST_CHECK
  'Чекає заміну циліндра',    // 3 ST_WAIT_SWAP
  'Захоплення',               // 4 ST_GRAB
  'Чекає «Розворот»',         // 5 ST_WAIT_TURN
  'Розворот',                 // 6 ST_TURN
  'Чекає «Повернення»',       // 7 ST_WAIT_RETURN
  'Повертається',             // 8 ST_FOLLOW_BACK
  'Розвантаження',            // 9 ST_UNLOAD
  'Готово',                   // 10 ST_DONE
];

// The brief's scenario as operator-visible steps; `states` lists the firmware states inside each step.
export const STEPS = [
  { title: '«Старт» і рух по лінії до терміналу', states: [0, 1] },
  { title: 'Перевірка кольору, заміна циліндрів', states: [2, 3] },
  { title: 'Захоплення циліндра',                 states: [4] },
  { title: '«Розворот» на 180°',                  states: [5, 6] },
  { title: '«Повернення» по лінії',               states: [7, 8] },
  { title: 'Автоматичне вивантаження',            states: [9, 10] },
];

export const COLOR_NAMES = { RED: 'червоний', GREEN: 'зелений', BLUE: 'синій', NONE: 'немає', UNSURE: 'невпевнено' };

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

const SIMPLE_REPLIES = {
  'READY': 'ready',
  'START': 'started',
  'RESUME': 'resumed',
  'STOP': 'stopped',
  'NO OBJECT': 'noObject',
  'EMPTY': 'empty',
  'SWAP': 'swap',
  'RECHECK': 'recheck',
  'GRAB without color sensor': 'manualGrab',
  'GRABBED': 'grabbed',
  'TURN': 'turning',
  'TURNED': 'turned',
  'RETURN': 'returning',
  'DONE': 'done',
  'ARM TEST': 'armTest',
  'ARM TEST DONE': 'armTestDone',
};

/** Parses one reply line. Unknown lines are kept as {type: 'unknown'}. */
export function parseReply(line) {
  if (Object.hasOwn(SIMPLE_REPLIES, line)) return { type: SIMPLE_REPLIES[line] };
  if (line.startsWith('ERR ')) return { type: 'error', message: line.slice(4) };
  if (line.startsWith('MATCH ')) return { type: 'match', color: line.slice(6) };
  if (line.startsWith('WRONG ')) return { type: 'wrong', color: line.slice(6) };
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

/** Which command resumes the robot after «СТОП» in a given firmware state (mirrors handleCommand). */
export function resumeCommandFor(state) {
  switch (state) {
    case 1: return 'start';
    case 2: case 3: case 4: return 'recheck';
    case 6: return 'turn';
    case 8: case 9: return 'returnHome';
    default: return null;
  }
}

/** Which command an error message asks for (the firmware names it in the text). */
export function commandForError(message) {
  if (/resend Start/i.test(message)) return 'start';
  if (/resend Turn/i.test(message)) return 'turn';
  if (/resend Return/i.test(message)) return 'returnHome';
  if (/\b(re)?send G\b/i.test(message)) return 'recheck';
  return null;
}

/** Observable robot state: feed it chunks, read the fields. */
export class RobotModel {
  constructor() {
    this.assembler = new LineAssembler();
    this.missionState = null;   // index into MISSION_STATES, or null when unknown
    this.paused = false;
    this.lastError = null;
    this.checks = [];           // [{color, match}] for the current run, in order (color null = confirmed by operator)
    this.led = 'off';           // 'off' | 'blink3' | 'steady' | 'error' - what the robot's LED shows
    this.noColorSensor = false;
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
    for (const line of lines) this.apply(parseReply(line));
    return lines;
  }

  get missionTitle() {
    return this.missionState === null ? null : MISSION_STATES[this.missionState] ?? null;
  }

  /** Index into STEPS for the current state, or -1 when unknown. */
  get stepIndex() {
    if (this.missionState === null) return -1;
    return STEPS.findIndex((s) => s.states.includes(this.missionState));
  }

  /** What the operator should do now: {cmd, text}. cmd is a COMMANDS key or null. Advice only. */
  get nextAction() {
    if (this.lastError) {
      const cmd = commandForError(this.lastError);
      if (/no color sensor/i.test(this.lastError)) {
        return { cmd: 'recheck', text: 'Давача кольору немає. Переконайтеся, що на терміналі потрібний циліндр, і натисніть «Перевірити колір» — робот захопить його.' };
      }
      if (/unsure/i.test(this.lastError)) {
        return { cmd: 'recheck', text: 'Колір не визначено впевнено. Робот пробує далі; можна поправити циліндр і натиснути «Перевірити колір».' };
      }
      return { cmd, text: cmd ? `Повторна спроба: натисніть «${COMMANDS[cmd].title}».` : 'Перевірте робота і повторіть останню команду.' };
    }
    if (this.paused) {
      const cmd = resumeCommandFor(this.missionState);
      return { cmd, text: cmd ? `Пауза. Щоб продовжити, натисніть «${COMMANDS[cmd].title}».` : 'Пауза.' };
    }
    switch (this.missionState) {
      case 0:  return { cmd: 'start', text: 'Поставте робота в стартову зону і натисніть «Старт».' };
      case 1:  return { cmd: null, text: 'Робот їде по лінії до терміналу з відкритим захватом.' };
      case 2:  return { cmd: null, text: 'Робот перевіряє колір циліндра.' };
      case 3:  return { cmd: null, text: 'Колір не той — світлодіод блимнув 3 рази. Замініть циліндр, робот перевірить сам.' };
      case 4:  return { cmd: null, text: 'Колір збігся — світлодіод світиться. Маніпулятор захоплює циліндр.' };
      case 5:  return { cmd: 'turn', text: 'Циліндр захоплено. Натисніть «Розворот».' };
      case 6:  return { cmd: null, text: 'Робот розвертається на 180° і шукає лінію.' };
      case 7:  return { cmd: 'returnHome', text: 'Робот на лінії. Натисніть «Повернення».' };
      case 8:  return { cmd: null, text: 'Робот везе циліндр до старту.' };
      case 9:  return { cmd: null, text: 'Робот вивантажує циліндр.' };
      case 10: return { cmd: 'start', text: 'Готово. Для наступної спроби поставте робота на старт і натисніть «Старт».' };
      default: return { cmd: null, text: 'Статус недоступний: прошивка без відповідей (DEBUG 0) або робот ще не відповів.' };
    }
  }

  apply(reply) {
    switch (reply.type) {
      case 'ready':
        this.missionState = 0; this.paused = false; this.lastError = null; this.led = 'off'; break;
      case 'started':
        this.paused = false; this.lastError = null; this.checks = []; this.led = 'off'; this.noColorSensor = false; break;
      case 'resumed':
      case 'recheck':
      case 'turning':
      case 'returning':
        this.paused = false; this.lastError = null; break;
      case 'stopped':
        this.paused = true; break;
      case 'state':
        this.missionState = reply.value >= 0 && reply.value < MISSION_STATES.length ? reply.value : null; break;
      case 'error':
        this.lastError = reply.message;
        if (/no color sensor/i.test(reply.message)) this.noColorSensor = true;
        this.led = 'error';
        break;
      case 'match':
        this.checks.push({ color: reply.color, match: true }); this.led = 'steady'; this.lastError = null; break;
      case 'wrong':
        this.checks.push({ color: reply.color, match: false }); this.led = 'blink3'; this.lastError = null; break;
      case 'manualGrab':
        this.checks.push({ color: null, match: true }); this.led = 'steady'; this.lastError = null; this.paused = false; break;
      case 'grabbed':
        this.led = 'steady'; break;
      case 'done':
        this.led = 'off'; break;
    }
  }
}
