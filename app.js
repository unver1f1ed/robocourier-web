import { COMMANDS, RobotModel, STEPS, COLOR_NAMES } from './protocol.js';
import { WebBleTransport, MockTransport } from './transport.js';

const MAX_LOG = 500;
const STOP_REPEAT_MS = 100;

const useMock = new URLSearchParams(location.search).has('mock');
const supported = useMock || WebBleTransport.supported;
const transport = useMock ? new MockTransport() : new WebBleTransport();
const model = new RobotModel();

const $ = (id) => document.getElementById(id);
const log = [];
let status = { kind: 'idle' };
let hasSession = false;     // true between a successful connection and a user-initiated disconnect
let wakeLock = null;

// Attempts (the brief allows 3 demonstration runs) and the run timer. The attempt count
// survives a page reload; storage can be unavailable, so every access is guarded.
const ATTEMPT_KEY = 'robocourier.attempt';
let attempt = 0;
try { attempt = Number(localStorage.getItem(ATTEMPT_KEY)) || 0; } catch { /* no storage */ }
let runStartedAt = null;    // ms timestamp of «Старт», null when no run is going
let runEndedAt = null;
let shownChecks = 0;        // to restart the LED blink animation on each new wrong color

function saveAttempt() {
  try { localStorage.setItem(ATTEMPT_KEY, String(attempt)); } catch { /* no storage */ }
}

function beginRun() {
  attempt += 1;
  saveAttempt();
  runStartedAt = Date.now();
  runEndedAt = null;
}

const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const STEPS_EL = document.getElementById('steps');
STEPS.forEach((s) => { const li = document.createElement('li'); li.textContent = s.title; STEPS_EL.appendChild(li); });

const LED_TEXT = { off: 'вимкнено', blink3: 'блимнув 3 рази — колір не той', steady: 'світиться — колір збігся', error: 'помилка / повторна спроба' };

const timeFmt = (d) => d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');

function addLog(kind, text) {
  log.push({ kind, text: `${timeFmt(new Date())}  ${text}` });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  const box = $('log');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = log[log.length - 1].text;
  box.appendChild(div);
  while (box.childElementCount > MAX_LOG) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

const isConnected = () => status.kind === 'connected';

function render() {
  const showControls = isConnected() || hasSession;
  $('connect').hidden = showControls;
  $('control').hidden = !showControls;
  $('unsupported').hidden = supported;
  $('scan').disabled = !supported || status.kind === 'connecting';

  const cs = $('connectStatus');
  if (status.kind === 'connecting') cs.textContent = `Підключення до ${status.name}…`;
  else if (status.kind === 'lost') cs.textContent = `Не вдалося: ${status.reason}`;
  else cs.textContent = 'Увімкніть робота і натисніть «Шукати робота». Модуль BLE має бути вставлений.';

  $('dot').classList.toggle('on', isConnected());
  $('paused').hidden = !model.paused;
  const title = model.missionTitle;
  $('mission').textContent = title ?? 'статус недоступний';
  $('mission').className = title ? '' : 'muted';
  document.querySelectorAll('[data-cmd]').forEach((b) => { b.disabled = !isConnected(); });

  let banner = null;
  if (status.kind === 'lost' && hasSession) {
    banner = 'Зв\'язок втрачено. Робот продовжує поточну дію — дочекайтеся перепідключення і натисніть СТОП, якщо треба.';
  } else if (model.lastError) {
    banner = `Помилка робота: ${model.lastError}`;
  }
  $('banner').hidden = !banner;
  if (banner) $('banner').textContent = banner;

  // What to do now, and the recommended button (outline only, never a gate).
  const next = isConnected() ? model.nextAction : { cmd: null, text: 'Немає з\'єднання з роботом. Чекаємо перепідключення.' };
  $('hint').textContent = next.text;
  document.querySelectorAll('[data-cmd]').forEach((b) => b.classList.toggle('next', b.dataset.cmd === next.cmd));

  // Mission steps from the brief's scenario.
  const step = model.stepIndex;
  const finished = model.missionState === 10;
  [...STEPS_EL.children].forEach((li, i) => {
    li.className = finished || i < step ? 'done' : i === step ? 'now' : '';
  });

  // LED mirror and color results.
  const led = $('led');
  if (model.checks.length !== shownChecks) {
    shownChecks = model.checks.length;
    led.className = 'led';
    void led.offsetWidth;   // restart the blink animation for a new result
  }
  led.className = `led ${model.led}`;
  $('ledText').textContent = LED_TEXT[model.led] ?? model.led;
  const checks = $('checks');
  checks.replaceChildren();
  if (!model.checks.length) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.style.fontSize = '14px';
    span.textContent = model.noColorSensor ? 'Давача кольору немає — циліндр підтверджує оператор' : 'Перевірок ще не було';
    checks.appendChild(span);
  }
  model.checks.forEach((c, i) => {
    const chip = document.createElement('span');
    chip.className = c.match ? 'chip ok' : 'chip';
    const name = c.color === null ? 'підтверджено оператором' : COLOR_NAMES[c.color] ?? c.color;
    chip.textContent = `${i + 1}. ${name} ${c.match ? '✓' : '✗'}`;
    checks.appendChild(chip);
  });

  // Attempt counter and timer.
  $('attempt').textContent = attempt;
  const elapsed = runStartedAt === null ? 0 : (runEndedAt ?? Date.now()) - runStartedAt;
  $('timer').textContent = fmtDuration(elapsed);
}

setInterval(() => { if (runStartedAt !== null && runEndedAt === null) $('timer').textContent = fmtDuration(Date.now() - runStartedAt); }, 250);

transport.onStatus = (next) => {
  const old = status;
  status = next;
  if (next.kind === 'connected') {
    $('deviceName').textContent = next.name;
    hasSession = true;
    model.onConnected();
    addLog('sys', `Підключено до ${next.name}`);
    keepScreenOn();
  } else if (next.kind === 'lost') {
    if (old.kind === 'connected' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    addLog('sys', `Зв'язок втрачено: ${next.reason}`);
  }
  render();
};

transport.onData = (bytes) => {
  for (const line of model.onData(bytes)) {
    addLog('in', line);
    if (line === 'START') beginRun();
    if (line === 'DONE' && runStartedAt !== null) runEndedAt = Date.now();
  }
  render();
};

function send(name) {
  const cmd = COMMANDS[name];
  if (!isConnected()) {
    addLog('sys', `Немає з'єднання — «${cmd.title}» не відправлено`);
    return;
  }
  const payload = new Uint8Array([cmd.byte.charCodeAt(0)]);
  transport.write(payload).catch((e) => addLog('sys', `Помилка запису: ${e.message}`));
  addLog('out', `→ ${cmd.byte}  «${cmd.title}»`);
  // Silent firmware (DEBUG 0) never replies START, so count the run when «Старт» is sent instead.
  if (name === 'start' && model.missionState === null && (runStartedAt === null || runEndedAt !== null)) beginRun();
  if (name === 'stop') {
    // Second STOP: cheap insurance on a lossy link. The firmware treats it the same.
    setTimeout(() => { if (isConnected()) transport.write(payload).catch(() => {}); }, STOP_REPEAT_MS);
  }
}

async function keepScreenOn() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not available */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasSession) keepScreenOn();
});

$('scan').onclick = () => transport.connect();
$('disconnect').onclick = () => {
  hasSession = false;
  transport.disconnect();
  wakeLock?.release?.().catch(() => {});
  addLog('sys', 'Від\'єднано');
  render();
};
document.querySelectorAll('[data-cmd]').forEach((b) => { b.onclick = () => send(b.dataset.cmd); });
// STOP is never disabled: in a panic a tap must at least log "not connected".
$('stop').onclick = () => send('stop');
$('clear').onclick = () => { log.length = 0; $('log').replaceChildren(); };
$('newSeries').onclick = () => {
  if (!confirm('Почати нову серію спроб? Лічильник спроб і таймер скинуться.')) return;
  attempt = 0;
  saveAttempt();
  runStartedAt = null;
  runEndedAt = null;
  render();
};
$('share').onclick = async () => {
  const text = log.map((e) => e.text).join('\n');
  try {
    if (navigator.share) await navigator.share({ text });
    else await navigator.clipboard.writeText(text);
  } catch { /* cancelled */ }
};

render();
