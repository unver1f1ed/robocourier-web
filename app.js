import { COMMANDS, RobotModel } from './protocol.js';
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
}

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
  for (const line of model.onData(bytes)) addLog('in', line);
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
$('share').onclick = async () => {
  const text = log.map((e) => e.text).join('\n');
  try {
    if (navigator.share) await navigator.share({ text });
    else await navigator.clipboard.writeText(text);
  } catch { /* cancelled */ }
};

render();
