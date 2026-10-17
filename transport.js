// Byte transports. Both expose: onStatus(status), onData(Uint8Array), connect(), disconnect(), write(Uint8Array).
// status: {kind: 'idle'|'connecting'|'connected'|'lost'|'unsupported', name?, reason?}

const SERVICE = 0xFFE0;          // HM-10 serial service (docs/PROTOCOL.md)
const CHARACTERISTIC = 0xFFE1;
const RECONNECT_DELAY_MS = 2000;

export class WebBleTransport {
  constructor() {
    this.onStatus = () => {};
    this.onData = () => {};
    this.device = null;
    this.characteristic = null;
    this.userDisconnected = false;
    this.onGattDisconnected = () => this.#lost('З\'єднання розірвано');
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /** Must run from a tap: the browser only shows the device picker after a user gesture. */
  async connect() {
    this.userDisconnected = false;
    try {
      // acceptAllDevices: some HM-10 clones do not advertise FFE0, so a service filter would hide them.
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE],
      });
    } catch (e) {
      if (e.name === 'NotFoundError') return;   // picker dismissed
      this.onStatus({ kind: 'lost', reason: e.message });
      return;
    }
    this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    await this.#open();
  }

  disconnect() {
    this.userDisconnected = true;
    clearTimeout(this.retryTimer);
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      if (this.device.gatt.connected) this.device.gatt.disconnect();
    }
    this.characteristic = null;
    this.onStatus({ kind: 'idle' });
  }

  // Web Bluetooth rejects a write while the previous one is pending ("GATT operation already
  // in progress"), which broke the claw slider. Writes are queued and run one at a time.
  write(bytes) {
    const run = async () => {
      const c = this.characteristic;
      if (!c) return;
      if (c.writeValueWithoutResponse) await c.writeValueWithoutResponse(bytes);
      else await c.writeValue(bytes);
    };
    const result = (this.queue ?? Promise.resolve()).then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  async #open() {
    const name = this.device.name || 'Робот';
    this.onStatus({ kind: 'connecting', name });
    try {
      const server = await this.device.gatt.connect();
      let service;
      try {
        service = await server.getPrimaryService(SERVICE);
      } catch {
        this.userDisconnected = true;
        server.disconnect();
        this.onStatus({ kind: 'lost', reason: 'Це не модуль HM-10 (немає сервісу FFE0)' });
        return;
      }
      this.characteristic = await service.getCharacteristic(CHARACTERISTIC);
      this.characteristic.addEventListener('characteristicvaluechanged', (e) => {
        this.onData(new Uint8Array(e.target.value.buffer));
      });
      await this.characteristic.startNotifications();
      this.onStatus({ kind: 'connected', name });
    } catch (e) {
      this.#lost(e.message || 'Не вдалося підключитися');
    }
  }

  #lost(reason) {
    this.characteristic = null;
    if (this.userDisconnected) return;
    this.onStatus({ kind: 'lost', reason });
    // Keep trying: the robot may just have been power-cycled.
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.userDisconnected) this.#open(); }, RECONNECT_DELAY_MS);
  }
}

/** Fake robot for desktop testing (open the page with ?mock). Plays the full mission like the firmware. */
export class MockTransport {
  constructor() {
    this.onStatus = () => {};
    this.onData = () => {};
    this.connected = false;
    this.state = 0;
    this.paused = false;
    this.timers = [];
    this.wrongLeft = [];   // wrong colors still to be "placed" by the operator this run
  }

  connect() {
    this.onStatus({ kind: 'connecting', name: 'HMSoft (mock)' });
    setTimeout(() => {
      this.connected = true;
      this.onStatus({ kind: 'connected', name: 'HMSoft (mock)' });
      this.#reply('READY', 'state 0');
    }, 500);
  }

  disconnect() {
    this.connected = false;
    this.#cancel();
    this.onStatus({ kind: 'idle' });
  }

  // Plays the whole mission like the firmware: two wrong colors first, the drawn one (red) last.
  async write(bytes) {
    if (!this.connected) return;
    const ch = String.fromCharCode(bytes[0]);
    if (ch === 'S') {
      this.#cancel();
      this.paused = true;
      this.#reply('STOP');
      return;
    }
    const s = this.state;
    if (ch === 'X' && (s === 0 || s === 10)) {
      this.paused = false;
      this.wrongLeft = ['BLUE', 'GREEN'];
      this.#reply('START');
      this.#go(1);
      this.#after(2500, () => { this.#reply('AT TERMINAL 2'); this.#check(); });
    } else if (ch === 'X' && s === 1 && this.paused) {
      this.paused = false;
      this.#reply('RESUME');
      this.#after(1500, () => { this.#reply('AT TERMINAL 2'); this.#check(); });
    } else if (ch === 'G' && (s === 2 || s === 3)) {
      this.#cancel();
      this.paused = false;
      this.#reply('RECHECK');
      this.#check();
    } else if (ch === 'Y' && (s === 5 || (s === 6 && this.paused))) {
      this.paused = false;
      this.#reply(s === 5 ? 'TURN' : 'RESUME');
      this.#go(6);
      this.#after(1500, () => { this.#reply('TURNED'); this.#go(7); });
    } else if (ch === 'U' && (s === 7 || ((s === 8 || s === 9) && this.paused))) {
      this.paused = false;
      this.#reply(s === 7 ? 'RETURN' : 'RESUME');
      this.#go(8);
      this.#after(2500, () => {
        this.#reply('AT TERMINAL 1');
        this.#go(9);
        this.#after(2000, () => { this.#reply('DONE'); this.#go(10); });
      });
    }
  }

  #check() {
    this.#go(2);
    this.#after(1200, () => {
      if (this.wrongLeft.length) {
        this.#reply(`WRONG ${this.wrongLeft.shift()}`);
        this.#go(3);
        // The "operator" swaps the cylinder after 3 s.
        this.#after(3000, () => { this.#reply('EMPTY'); });
        this.#after(4000, () => { this.#reply('SWAP'); this.#check(); });
      } else {
        this.#reply('MATCH RED');
        this.#go(4);
        this.#after(1500, () => { this.#reply('GRABBED'); this.#go(5); });
      }
    });
  }

  #go(state) {
    this.state = state;
    this.#reply(`state ${state}`);
  }

  #after(ms, fn) {
    this.timers.push(setTimeout(fn, ms));
  }

  #cancel() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  /** Sends lines the way the HM-10 does: "\r\n" endings, 20-byte chunks. */
  #reply(...lines) {
    const bytes = new TextEncoder().encode(lines.map((l) => l + '\r\n').join(''));
    for (let i = 0; i < bytes.length; i += 20) {
      setTimeout(() => this.onData(bytes.slice(i, i + 20)), 20 * (i / 20));
    }
  }
}
