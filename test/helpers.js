'use strict';

const net = require('net');
const os = require('os');
const path = require('path');

let counter = 0;

/** Путь для тестового «pipe»: на Windows настоящий named pipe, на Linux/macOS unix-сокет. */
function tempPipePath() {
  const name = `sp-test-${process.pid}-${Date.now()}-${counter++}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * Имитация Soundpad. handler(command) возвращает строку ответа или массив кусков
 * (куски отправляются с паузой, чтобы проверить сборку ответа).
 */
async function startMockSoundpad(handler, { chunkDelayMs = 4 } = {}) {
  const pipePath = tempPipePath();
  const commands = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.on('data', async (data) => {
      const cmd = data.toString('utf8');
      commands.push(cmd);
      const res = handler(cmd);
      if (res === undefined) return; // не отвечаем: проверка таймаута
      const parts = Array.isArray(res) ? res : [res];
      for (const part of parts) {
        sock.write(part);
        if (parts.length > 1) await new Promise((r) => setTimeout(r, chunkDelayMs));
      }
    });
  });
  await new Promise((resolve) => server.listen(pipePath, resolve));
  return {
    pipePath,
    commands,
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const SAMPLE_CATEGORIES = `<?xml version="1.0" encoding="UTF-8"?>
<Categories>
  <Category index="9" type="1" name="Все звуки" hidden="true"/>
  <Category index="1" name="Мемы &amp; шутки" type="0" hidden="false">
    <Sound index="1" url="C:\\sounds\\bruh.mp3" artist="" title="Bruh" duration="00:00:02"/>
    <Sound index="2" url="C:\\sounds\\vine boom.mp3" artist="" title="Vine boom" duration="00:00:03"/>
    <Category index="3" name="Вложенная" type="0" hidden="false">
      <Sound index="5" url="C:\\sounds\\nested.mp3" artist="Кто-то" title="Тест" duration="00:00:01"/>
    </Category>
  </Category>
  <Category index="2" name="Игры" type="0" hidden="false">
    <Sound index="3" url="C:\\sounds\\oof.wav" artist="" title="Oof" duration="00:00:01"/>
    <Sound index="4" url="C:\\sounds\\airhorn.wav" artist="" title="" duration="00:00:02"/>
  </Category>
</Categories>`;

const SAMPLE_SOUNDLIST = `<Soundlist>
  <Sound index="1" url="C:\\sounds\\bruh.mp3" artist="" title="Bruh" duration="00:00:02"/>
  <Sound index="2" url="C:\\sounds\\vine boom.mp3" artist="" title="Vine boom" duration="00:00:03"/>
  <Sound index="3" url="C:\\sounds\\oof.wav" artist="" title="Oof" duration="00:00:01"/>
  <Sound index="4" url="C:\\sounds\\airhorn.wav" artist="" title="" duration="00:00:02"/>
  <Sound index="5" url="C:\\sounds\\nested.mp3" artist="Кто-то" title="Тест" duration="00:00:01"/>
</Soundlist>`;

/** Стандартный обработчик команд для тестов. */
function defaultHandler(cmd) {
  if (cmd === 'IsAlive()') return 'R-200';
  if (cmd === 'GetVersion()') return '9.9.9';
  if (cmd === 'GetRemoteControlVersion()') return '1.1.2';
  if (cmd === 'GetCategories(true, false)') return SAMPLE_CATEGORIES;
  if (cmd === 'GetSoundlist()') return SAMPLE_SOUNDLIST;
  if (cmd.startsWith('DoPlay')) return 'R-200';
  if (cmd === 'DoStopSound()') return 'R-200';
  return 'R-404';
}

module.exports = { startMockSoundpad, defaultHandler, tempPipePath, SAMPLE_CATEGORIES, SAMPLE_SOUNDLIST };
