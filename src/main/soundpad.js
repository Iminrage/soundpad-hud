'use strict';

// Клиент удалённого управления Soundpad (RC 1.1.2) через named pipe.
// Протокол: пишем текстовую команду, читаем ответ. Терминатора в ответе нет,
// поэтому ответ собирается по частям: либо до закрывающего корневого XML-тега,
// либо до паузы в данных. Запросы идут строго по очереди с минимальным интервалом
// (по документации Soundpad частые одновременные запросы могут сломать канал).

const net = require('net');

const DEFAULT_PIPE = '\\\\.\\pipe\\sp_remote_control';
const OK = /^R-200/;

class SoundpadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SoundpadError';
    this.code = code || 'ERROR';
  }
}

function int(n) {
  if (!Number.isInteger(n)) throw new TypeError(`Ожидалось целое число, получено: ${n}`);
  return String(n);
}

const bool = (b) => (b ? 'true' : 'false');

class SoundpadClient {
  constructor(opts = {}) {
    this.pipePath = opts.pipePath || DEFAULT_PIPE;
    this.idleMs = opts.idleMs ?? 25; // пауза, после которой ответ считается полным
    this.shortIdleMs = opts.shortIdleMs ?? 8; // то же для коротких ответов вида R-200
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.minIntervalMs = opts.minIntervalMs ?? 5;
    this.log = opts.log || (() => {});
    this.sock = null;
    this._connecting = null;
    this._chain = Promise.resolve();
    this._lastAt = 0;
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }

  _ensureSocket() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const sock = net.connect(this.pipePath);
      const onError = (err) => {
        sock.destroy();
        const offline = err.code === 'ENOENT';
        reject(
          new SoundpadError(
            offline ? 'Soundpad не запущен (pipe не найден)' : `Не удалось подключиться к Soundpad: ${err.message}`,
            offline ? 'OFFLINE' : err.code || 'CONNECT'
          )
        );
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);
        sock.on('error', () => {}); // ошибки во время обмена ловит _exchange
        sock.on('close', () => {
          if (this.sock === sock) this.sock = null;
        });
        this.sock = sock;
        resolve(sock);
      });
    });
    this._connecting = this._connecting.finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  /** Отправляет сырую команду, возвращает сырой ответ. Запросы идут по очереди. */
  request(command) {
    const run = () => this._exchange(command);
    const result = this._chain.then(run);
    this._chain = result.catch(() => {});
    return result;
  }

  async _exchange(command) {
    const wait = this._lastAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const sock = await this._ensureSocket();

    return new Promise((resolve, reject) => {
      const chunks = [];
      let idle = null;
      let rootName = null;
      let short = false;

      const hard = setTimeout(() => done(new SoundpadError('Soundpad не ответил вовремя', 'TIMEOUT')), this.timeoutMs);

      const cleanup = () => {
        clearTimeout(idle);
        clearTimeout(hard);
        sock.removeListener('data', onData);
        sock.removeListener('close', onClose);
        sock.removeListener('error', onError);
      };

      const done = (err) => {
        cleanup();
        this._lastAt = Date.now();
        if (err) {
          sock.destroy();
          if (this.sock === sock) this.sock = null;
          this.log('pipe error', command, err.message);
          reject(err);
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        this.log('pipe', command, '->', text.length > 300 ? `${text.slice(0, 300)}… (${text.length} симв.)` : text);
        resolve(text);
      };

      const onData = (chunk) => {
        if (chunks.length === 0) {
          const head = chunk.toString('utf8', 0, Math.min(chunk.length, 256));
          const m = /^\s*<([A-Za-z_][\w:.-]*)/.exec(head);
          rootName = m ? m[1] : null;
          short = /^R-\d{3}/.test(head);
        }
        chunks.push(chunk);
        clearTimeout(idle);
        if (rootName) {
          const tail = Buffer.concat(chunks.slice(-2)).toString('utf8').trimEnd();
          if (tail.endsWith(`</${rootName}>`)) return done();
          if (chunks.length === 1 && /^\s*<[^<>]*\/>\s*$/.test(chunk.toString('utf8'))) return done();
        }
        idle = setTimeout(() => done(), short ? this.shortIdleMs : this.idleMs);
      };
      const onClose = () => done(new SoundpadError('Soundpad закрыл соединение', 'CLOSED'));
      const onError = (e) => done(new SoundpadError(`Ошибка pipe: ${e.message}`, e.code || 'PIPE'));

      sock.on('data', onData);
      sock.once('close', onClose);
      sock.once('error', onError);
      sock.write(command, 'utf8');
    });
  }

  async _play(command) {
    const response = await this.request(command);
    return { ok: OK.test(response), response };
  }

  async _xml(command) {
    const response = await this.request(command);
    if (!response) throw new SoundpadError('Пустой ответ Soundpad', 'EMPTY');
    if (response.startsWith('R-')) throw new SoundpadError(`Soundpad ответил ${response}`, 'REMOTE');
    return response;
  }

  async isAlive() {
    return OK.test(await this.request('IsAlive()'));
  }

  async getVersion() {
    return (await this.request('GetVersion()')).trim();
  }

  async getRcVersion() {
    return (await this.request('GetRemoteControlVersion()')).trim();
  }

  getCategories() {
    return this._xml('GetCategories(true, false)');
  }

  async getCategory(categoryIndex) {
    return this._xml(`GetCategory(${int(categoryIndex)}, true, false)`);
  }

  getSoundlist() {
    return this._xml('GetSoundlist()');
  }

  /** Играет звук по глобальному индексу (категория «Все звуки»). */
  async playSound(index, render = true, capture = true) {
    return this._play(`DoPlaySound(${int(index)}, ${bool(render)}, ${bool(capture)})`);
  }

  /** Играет звук по позиции внутри категории (позиция с 1). */
  async playFromCategory(categoryIndex, position, render = true, capture = true) {
    return this._play(
      `DoPlaySoundFromCategory(${int(categoryIndex)}, ${int(position)}, ${bool(render)}, ${bool(capture)})`
    );
  }

  stop() {
    return this._play('DoStopSound()');
  }

  /** 'STOPPED', 'PLAYING', 'PAUSED' или 'SEEKING' (на живом Soundpad 4.0.35 приходит без префикса R-). */
  async getPlayStatus() {
    return (await this.request('GetPlayStatus()')).trim();
  }
}

module.exports = { SoundpadClient, SoundpadError, DEFAULT_PIPE };
