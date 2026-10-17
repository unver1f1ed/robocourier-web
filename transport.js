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

  async write(bytes) {
    const c = this.characteristic;
    if (!c) return;
    if (c.writeValueWithoutResponse) await c.writeValueWithoutResponse(bytes);
    else await c.writeValue(bytes);
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

/** Fake robot for desktop testing (open the page with ?mock). Answers like the phase 3 firmware. */
export class MockTransport {
  constructor() {
    this.onStatus = () => {};
    this.onData = () => {};
    this.connected = false;
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
    this.onStatus({ kind: 'idle' });
  }

  async write(bytes) {
    if (!this.connected) return;
    const ch = String.fromCharCode(bytes[0]);
    if (ch === 'X') {
      this.#reply('START', 'state 1');
      setTimeout(() => this.#reply('AT TERMINAL 2', 'state 2'), 2000);
    } else if (ch === 'S') {
      this.#reply('STOP');
    }
  }

  /** Sends lines the way the HM-10 does: "\r\n" endings, 20-byte chunks. */
  #reply(...lines) {
    const bytes = new TextEncoder().encode(lines.map((l) => l + '\r\n').join(''));
    for (let i = 0; i < bytes.length; i += 20) {
      setTimeout(() => this.onData(bytes.slice(i, i + 20)), 20 * (i / 20));
    }
  }
}
