'use strict';

// Диагностика: подключается к Soundpad и показывает сырые ответы удалённого управления.
// Нужна, чтобы проверить реальный формат XML (атрибуты Category/Sound) и версию RC.
// Запуск: npm run probe   (Soundpad должен быть запущен)
// Полные ответы сохраняются в probe-output.txt рядом с package.json.

const fs = require('fs');
const path = require('path');
const { SoundpadClient } = require('../src/main/soundpad');
const { parseCategories, parseSoundlist } = require('../src/main/library');

const COMMANDS = ['IsAlive()', 'GetVersion()', 'GetRemoteControlVersion()', 'GetCategories(true, false)', 'GetSoundlist(1, 5)'];

(async () => {
  const client = new SoundpadClient({ pipePath: process.env.SOUNDPAD_PIPE });
  const full = [];
  try {
    for (const cmd of COMMANDS) {
      const res = await client.request(cmd);
      full.push(`### ${cmd}\n${res}\n`);
      const head = res.length > 1200 ? `${res.slice(0, 1200)}\n… (всего ${res.length} символов)` : res;
      console.log(`\n### ${cmd}\n${head}`);
      if (cmd.startsWith('GetCategories')) {
        const cats = parseCategories(res);
        console.log(`\n→ разобрано категорий: ${cats.length}, звуков в них: ${cats.reduce((n, c) => n + c.sounds.length, 0)}`);
      }
      if (cmd.startsWith('GetSoundlist')) console.log(`\n→ разобрано звуков: ${parseSoundlist(res).length}`);
    }
    const out = path.join(__dirname, '..', 'probe-output.txt');
    fs.writeFileSync(out, full.join('\n'));
    console.log(`\nПолный вывод: ${out}`);
  } catch (e) {
    console.error(`\nОшибка: ${e.message} (${e.code || 'без кода'})`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
})();
