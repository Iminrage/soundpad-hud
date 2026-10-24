'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PlayStats } = require('../src/main/stats');
const { topCategory, menuSlots, parseCategories, parseSoundlist, TOP_ID } = require('../src/main/library');
const { SAMPLE_CATEGORIES, SAMPLE_SOUNDLIST } = require('./helpers');

test('stats: счёт, порядок, запись на диск и битый файл', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphud-stats-'));
  const file = path.join(dir, 'stats.json');
  let t = 0;
  const s = new PlayStats(file, { now: () => ++t }).load();
  s.record(String.raw`C:\sounds\Oof.wav`);
  s.record(String.raw`C:\sounds\bruh.mp3`);
  s.record(String.raw`c:\sounds\oof.WAV`); // путь без учёта регистра
  s.record(String.raw`C:\sounds\nested.mp3`);
  s.record('');
  s.flush();
  assert.deepEqual(
    s.ranked().map((r) => [r.url, r.count]),
    [
      [String.raw`c:\sounds\oof.wav`, 2],
      [String.raw`c:\sounds\nested.mp3`, 1], // при равном счёте недавний выше
      [String.raw`c:\sounds\bruh.mp3`, 1],
    ]
  );

  const again = new PlayStats(file).load();
  assert.deepEqual(again.ranked().map((r) => r.count), [2, 1, 1]);
  again.clear();
  assert.deepEqual(new PlayStats(file).load().ranked(), []);

  fs.writeFileSync(file, '{ битый');
  assert.deepEqual(new PlayStats(file).load().ranked(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('library: «Частые» из «Всех звуков» по счёту, папка открывается как TOP_ID', () => {
  const all = { id: 'all', name: 'Все звуки', path: 'Все звуки', sounds: parseSoundlist(SAMPLE_SOUNDLIST) };
  const library = { categories: [all, ...parseCategories(SAMPLE_CATEGORIES)] };
  const ranked = [String.raw`c:\sounds\oof.wav`, String.raw`c:\sounds\пропал.mp3`, String.raw`c:\sounds\bruh.mp3`].map(
    (url) => ({ url })
  );

  const top = topCategory(ranked, library);
  assert.deepEqual([top.id, top.menuId, top.name], ['all', TOP_ID, 'Частые']);
  assert.deepEqual(top.sounds.map((s) => [s.title, s.index]), [['Oof', 3], ['Bruh', 1]]); // пропавший звук пропущен
  assert.equal(topCategory(ranked, library, 1).sounds.length, 1);
  assert.equal(topCategory([], library), null);
  assert.equal(topCategory(ranked, { categories: library.categories.slice(1) }), null); // без «Всех звуков»

  const [folder] = menuSlots([top], 3, 0);
  assert.deepEqual([folder.catId, folder.label, folder.icon, folder.count], [TOP_ID, 'Частые', '⭐', 2]);
});
