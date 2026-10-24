'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HotkeyMachine, comboLabel } = require('../src/main/hotkey');
const { WheelSelection, sectorAt } = require('../src/main/selection');
const { sanitize, ConfigStore, resetPatch, SECTIONS, defaults } = require('../src/main/config');

// условные коды клавиш (в приложении берутся из uiohook-napi)
const K = { LCTRL: 29, RCTRL: 100, LSHIFT: 42, RSHIFT: 54, LALT: 56, RALT: 101, LMETA: 200, RMETA: 201, SPACE: 57, ESC: 1, A: 30 };
const keys = {
  ctrl: [K.LCTRL, K.RCTRL],
  shift: [K.LSHIFT, K.RSHIFT],
  alt: [K.LALT, K.RALT],
  meta: [K.LMETA, K.RMETA],
  escape: K.ESC,
};

function setup(mode = 'hold') {
  const cfg = { mode, hotkey: { ctrl: true, alt: false, shift: false, meta: false, keycode: K.SPACE, name: 'Space' } };
  const m = new HotkeyMachine({ keys, getConfig: () => cfg, failsafeMs: 50 });
  const log = [];
  m.on('open', () => log.push('open'));
  m.on('close', (e) => log.push(e.confirm ? 'confirm' : 'cancel'));
  m.on('recorded', (c) => log.push(['recorded', c]));
  m.on('record-cancel', () => log.push('record-cancel'));
  return { m, log, cfg };
}

const down = (m, keycode, mods = {}) => m.onKeyDown({ keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const up = (m, keycode) => m.onKeyUp({ keycode });

test('hold: Ctrl+Space открывает, отпускание Space подтверждает, автоповтор игнорируется', () => {
  const { m, log } = setup('hold');
  down(m, K.SPACE, { ctrlKey: true });
  down(m, K.SPACE, { ctrlKey: true }); // автоповтор
  down(m, K.SPACE, { ctrlKey: true });
  assert.deepEqual(log, ['open']);
  up(m, K.SPACE);
  assert.deepEqual(log, ['open', 'confirm']);
  down(m, K.SPACE, { ctrlKey: true }); // нормальное повторное открытие
  assert.deepEqual(log, ['open', 'confirm', 'open']);
});

test('hold: отпускание Ctrl раньше пробела тоже подтверждает, а потом пробел не открывает заново', () => {
  const { m, log } = setup('hold');
  down(m, K.SPACE, { ctrlKey: true });
  up(m, K.RCTRL); // правый Ctrl тоже считается
  assert.deepEqual(log, ['open', 'confirm']);
  down(m, K.SPACE, { ctrlKey: false }); // пробел ещё зажат/повторяется без Ctrl
  assert.deepEqual(log, ['open', 'confirm']);
});

test('hold: комбинация с лишним модификатором не срабатывает', () => {
  const { m, log } = setup('hold');
  down(m, K.SPACE, { ctrlKey: true, shiftKey: true });
  down(m, K.SPACE, {});
  assert.deepEqual(log, []);
});

test('Esc отменяет', () => {
  const { m, log } = setup('hold');
  down(m, K.SPACE, { ctrlKey: true });
  down(m, K.ESC);
  up(m, K.SPACE);
  assert.deepEqual(log, ['open', 'cancel']);
});

test('toggle: отпускание ничего не делает, клик (close(true)) подтверждает, повтор комбинации отменяет', () => {
  const { m, log } = setup('toggle');
  down(m, K.SPACE, { ctrlKey: true });
  down(m, K.SPACE, { ctrlKey: true }); // автоповтор не должен закрыть
  up(m, K.SPACE);
  up(m, K.LCTRL);
  assert.deepEqual(log, ['open']);
  m.close(true); // это делает обработчик клика мыши
  assert.deepEqual(log, ['open', 'confirm']);

  down(m, K.SPACE, { ctrlKey: true });
  up(m, K.SPACE);
  down(m, K.SPACE, { ctrlKey: true }); // второе нажатие
  assert.deepEqual(log, ['open', 'confirm', 'open', 'cancel']);
});

test('страховочный таймер закрывает колесо без подтверждения', async () => {
  const { m, log } = setup('hold');
  down(m, K.SPACE, { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(log, ['open', 'cancel']);
});

test('запись комбинации: модификаторы ждут, Esc отменяет, основная клавиша записывается', () => {
  const { m, log } = setup('hold');
  m.startRecording();
  down(m, K.LCTRL, { ctrlKey: true }); // модификатор не завершает запись
  down(m, K.A, { ctrlKey: true, shiftKey: true });
  assert.deepEqual(log, [['recorded', { ctrl: true, alt: false, shift: true, meta: false, keycode: K.A, modsOnly: false }]]);
  assert.equal(m.recording, false);

  m.startRecording();
  down(m, K.ESC);
  assert.equal(log.at(-1), 'record-cancel');

  // во время записи колесо не открывается
  m.startRecording();
  down(m, K.SPACE, { ctrlKey: true });
  assert.equal(log.includes('open'), false);
});

test('запись комбинации только из модификаторов: Ctrl+Shift записывается при отпускании', () => {
  const { m, log } = setup('hold');
  m.startRecording();
  down(m, K.LCTRL, { ctrlKey: true });
  up(m, K.LCTRL); // один модификатор не записывается
  assert.equal(m.recording, true);
  down(m, K.LCTRL, { ctrlKey: true });
  down(m, K.RSHIFT, { ctrlKey: true, shiftKey: true });
  assert.deepEqual(log, []); // пока держишь, ждём: вдруг будет основная клавиша
  up(m, K.RSHIFT);
  assert.deepEqual(log, [['recorded', { ctrl: true, alt: false, shift: true, meta: false, keycode: null, modsOnly: true }]]);
  assert.equal(m.recording, false);
  up(m, K.LCTRL);
});

test('хоткей только из модификаторов: hold и toggle', () => {
  const { m, log, cfg } = setup('hold');
  cfg.hotkey = { ctrl: true, alt: false, shift: true, meta: false, keycode: null, name: '', modsOnly: true };
  down(m, K.LCTRL, { ctrlKey: true });
  assert.deepEqual(log, []); // одного Ctrl мало
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true });
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true }); // автоповтор
  assert.deepEqual(log, ['open']);
  up(m, K.LSHIFT);
  assert.deepEqual(log, ['open', 'confirm']);
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true }); // Ctrl всё ещё зажат: снова открывается
  assert.deepEqual(log, ['open', 'confirm', 'open']);
  up(m, K.LCTRL); // hold: отпускание Ctrl тоже подтверждает
  up(m, K.LSHIFT);
  assert.deepEqual(log, ['open', 'confirm', 'open', 'confirm']);

  // лишний модификатор не срабатывает; потерянный keyup Alt лечится флагами события
  down(m, K.LALT, { altKey: true });
  down(m, K.LCTRL, { ctrlKey: true, altKey: true });
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true, altKey: true });
  assert.equal(log.length, 4);
  up(m, K.LCTRL);
  up(m, K.LSHIFT); // keyup Alt «потерялся»
  down(m, K.LCTRL, { ctrlKey: true, altKey: false });
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true, altKey: false });
  assert.equal(log.at(-1), 'open');
  up(m, K.LSHIFT);
  up(m, K.LCTRL);

  cfg.mode = 'toggle';
  log.length = 0;
  down(m, K.LCTRL, { ctrlKey: true });
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true });
  up(m, K.LSHIFT);
  up(m, K.LCTRL);
  assert.deepEqual(log, ['open']); // в toggle отпускание не закрывает
  down(m, K.LCTRL, { ctrlKey: true });
  down(m, K.LSHIFT, { ctrlKey: true, shiftKey: true });
  assert.deepEqual(log, ['open', 'cancel']); // повтор комбинации отменяет
});

test('config: хоткей только из модификаторов', () => {
  const ok = sanitize({ hotkey: { ctrl: true, shift: true, keycode: 57, name: 'Space', modsOnly: true } }).hotkey;
  assert.deepEqual(ok, { ctrl: true, alt: false, shift: true, meta: false, keycode: null, name: '', modsOnly: true });
  const one = sanitize({ hotkey: { ctrl: true, modsOnly: true } }).hotkey; // одного модификатора мало
  assert.deepEqual(one, defaults().hotkey); // возвращаем значение по умолчанию
});

test('config: значения по умолчанию — Ctrl+Alt, Ctrl+Shift и stayOpen; старые конфиги', () => {
  const d = sanitize({});
  assert.equal(comboLabel(d.hotkey), 'Ctrl + Alt');
  assert.equal(comboLabel(d.catHotkey), 'Ctrl + Shift');
  assert.equal(d.stayOpen, true);
  // конфиг до колеса категорий и stayOpen: поля получают значения по умолчанию
  const old = sanitize({ hotkey: { ctrl: true, alt: false, shift: false, meta: false, keycode: 57, name: 'Space' } });
  assert.deepEqual([old.hotkey.keycode, old.hotkey.modsOnly, comboLabel(old.catHotkey), old.stayOpen], [57, false, 'Ctrl + Shift', true]);
  // явно убранный бинд и выключенная галочка остаются как есть
  const off = sanitize({ catHotkey: null, stayOpen: false });
  assert.deepEqual([off.catHotkey, off.stayOpen], [null, false]);
});

test('hold + stayOpen: отпускание мимо звука оставляет колесо открытым', () => {
  const { m, log, cfg } = setup('hold');
  cfg.stayOpen = true;
  let miss = true;
  m.missed = () => miss;
  let stuck = 0;
  m.on('stuck', () => stuck++);

  down(m, K.SPACE, { ctrlKey: true });
  up(m, K.SPACE);
  up(m, K.LCTRL); // остальные отпускания тоже не закрывают
  assert.deepEqual([log, stuck], [['open'], 1]);
  down(m, K.SPACE, { ctrlKey: true }); // повтор бинда отменяет
  assert.deepEqual(log, ['open', 'cancel']);
  up(m, K.SPACE);

  miss = false; // на звуке закрывается как обычно
  down(m, K.SPACE, { ctrlKey: true });
  up(m, K.SPACE);
  assert.deepEqual(log.slice(2), ['open', 'confirm']);

  miss = true; // после «залипания» клик подтверждает
  down(m, K.SPACE, { ctrlKey: true });
  up(m, K.SPACE);
  m.close(true);
  assert.deepEqual(log.slice(4), ['open', 'confirm']);

  cfg.stayOpen = false; // без галочки промах закрывает, как раньше
  down(m, K.SPACE, { ctrlKey: true });
  up(m, K.SPACE);
  assert.deepEqual(log.slice(6), ['open', 'confirm']);
});

test('два хоткея: колесо категорий открывается и закрывается своей комбинацией', () => {
  const { m, log, cfg } = setup('hold');
  cfg.catHotkey = { ctrl: true, alt: true, shift: false, meta: false, keycode: K.A, name: 'A', modsOnly: false };
  const ids = [];
  m.on('open', (e) => ids.push(e.id));
  down(m, K.A, { ctrlKey: true, altKey: true });
  assert.deepEqual(ids, ['cats']);
  up(m, K.SPACE); // клавиша обычного колеса это колесо не закрывает
  assert.deepEqual(log, ['open']);
  up(m, K.A);
  assert.deepEqual(log, ['open', 'confirm']);
  down(m, K.SPACE, { ctrlKey: true });
  assert.deepEqual(ids, ['cats', 'main']);
  up(m, K.SPACE);

  const targets = [];
  m.on('recorded', (_c, t) => targets.push(t));
  m.startRecording('cats');
  down(m, K.A, { shiftKey: true });
  assert.deepEqual(targets, ['cats']);
});

test('config: хоткей колеса категорий', () => {
  const hk = sanitize({ catHotkey: { alt: true, keycode: 46, name: 'C' } }).catHotkey;
  assert.deepEqual(hk, { ctrl: false, alt: true, shift: false, meta: false, keycode: 46, name: 'C', modsOnly: false });
  assert.equal(sanitize({ catHotkey: { ctrl: true } }).catHotkey, null); // без клавиши — не задан
  assert.equal(sanitize({ catHotkey: { ctrl: true, modsOnly: true } }).catHotkey, null); // одного модификатора мало
});

test('config: сброс раздела к значениям по умолчанию', () => {
  assert.deepEqual(resetPatch('look'), { sectors: 8, deadzone: 45, sensitivity: 1, showTips: true, showHints: true });
  assert.equal(comboLabel(resetPatch('binds').catHotkey), 'Ctrl + Shift');
  assert.equal(resetPatch('нет такого'), null);
  // каждое поле настроек, кроме служебных, принадлежит какому-то разделу
  const covered = Object.values(SECTIONS).flat().sort();
  const all = Object.keys(defaults()).filter((k) => !['version', 'firstRunDone'].includes(k)).sort();
  assert.deepEqual(covered, all);
});

test('comboLabel', () => {
  assert.equal(comboLabel({ ctrl: true, alt: false, shift: true, meta: false, keycode: null, modsOnly: true }), 'Ctrl + Shift');
  assert.equal(comboLabel({ ctrl: true, alt: false, shift: true, meta: false, keycode: 30, name: 'A' }), 'Ctrl + Shift + A');
  assert.equal(comboLabel({ ctrl: false, alt: false, shift: false, meta: true, keycode: 5 }), 'Win + #5');
});

test('selection: направления сектора при 8 секторах (0 сверху, по часовой)', () => {
  const r = 100;
  const at = (deg) => sectorAt(r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180), 8, 45);
  assert.equal(at(0), 0);
  assert.equal(at(44), 1);
  assert.equal(at(90), 2);
  assert.equal(at(180), 4);
  assert.equal(at(270), 6);
  assert.equal(at(359), 0);
  assert.equal(at(-20), 0);
  assert.equal(sectorAt(10, 10, 8, 45), null); // мёртвая зона
});

test('selection: границы секторов для 6 и 12', () => {
  const dir = (deg, n) => sectorAt(100 * Math.sin((deg * Math.PI) / 180), -100 * Math.cos((deg * Math.PI) / 180), n, 45);
  assert.equal(dir(29, 6), 0);
  assert.equal(dir(31, 6), 1);
  assert.equal(dir(14, 12), 0);
  assert.equal(dir(16, 12), 1);
});

test('selection: накопление дельт, ограничение радиуса, чувствительность, сброс', () => {
  const s = new WheelSelection();
  s.configure({ sectors: 8, deadzone: 45, sensitivity: 2 });
  assert.equal(s.selected, null);
  s.move(30, 0); // 60 с учётом чувствительности
  assert.equal(s.selected, 2); // вправо
  s.move(5000, 0);
  assert.ok(Math.hypot(s.vx, s.vy) <= s.maxRadius + 1e-9);
  s.move(-20000, 0); // быстро через центр влево
  assert.equal(s.selected, 6);
  s.reset();
  assert.equal(s.selected, null);
});

test('selection: клавиатурные шаги по кругу', () => {
  const s = new WheelSelection();
  s.configure({ sectors: 6, deadzone: 45, sensitivity: 1 });
  s.step(1);
  assert.equal(s.selected, 0);
  s.step(1);
  assert.equal(s.selected, 1);
  s.step(-1);
  s.step(-1);
  assert.equal(s.selected, 5);
  const snap = s.snapshot();
  assert.equal(snap.selected, 5);
});

test('config: валидация и значения по умолчанию', () => {
  const d = sanitize({});
  assert.equal(d.sectors, 8);
  assert.equal(d.mode, 'hold');
  assert.equal(d.slots.length, 12);
  assert.equal(d.hotkey.ctrl, true);
  assert.equal(d.hotkey.keycode, null);

  const c = sanitize({
    sectors: 7,
    mode: 'bogus',
    deadzone: 9999,
    sensitivity: -3,
    lines: { render: false, capture: false },
    hotkey: { keycode: '57', ctrl: 0 },
    slots: [{ catId: 'all', pos: 3, index: 3, title: 'x'.repeat(500), label: 'y'.repeat(99), icon: '🎺' }, { catId: 'evil', pos: 1 }],
  });
  assert.equal(c.sectors, 8);
  assert.equal(c.mode, 'hold');
  assert.equal(c.deadzone, 120);
  assert.equal(c.sensitivity, 0.2);
  assert.deepEqual(c.lines, { render: true, capture: true }); // обе линии выключить нельзя
  assert.equal(c.hotkey.keycode, null);
  assert.equal(c.hotkey.ctrl, false);
  assert.equal(c.slots[0].title.length, 200);
  assert.equal(c.slots[0].label.length, 40);
  assert.equal(c.slots[0].catId, 'all');
  assert.equal(c.slots[1].catId, null); // мусорная категория отброшена
});

test('config: источник страниц и чтение конфига v1', () => {
  const v1 = sanitize({ version: 1, sectors: 6 }); // старый конфиг без source
  assert.equal(v1.version, 2);
  assert.equal(v1.sectors, 6);
  assert.deepEqual(v1.source, { catId: null, name: '' });

  assert.deepEqual(sanitize({ source: { catId: 'all', name: 'Все звуки' } }).source, { catId: 'all', name: 'Все звуки' });
  assert.equal(sanitize({ source: { catId: 3, name: 'x'.repeat(300) } }).source.name.length, 200);
  assert.deepEqual(sanitize({ source: { catId: 'evil', name: 'x' } }).source, { catId: null, name: '' });
});

test('config: сохранение, загрузка, слияние lines/hotkey', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphud-'));
  const file = path.join(dir, 'config.json');
  const a = new ConfigStore(file);
  a.load();
  const changes = [];
  a.on('change', (c) => changes.push(c.sectors));
  a.update({ sectors: 6, lines: { render: false }, hotkey: { alt: true, keycode: 30, name: 'A', modsOnly: false } });
  assert.deepEqual(changes, [6]);

  const b = new ConfigStore(file);
  const cfg = b.load();
  assert.equal(cfg.sectors, 6);
  assert.deepEqual(cfg.lines, { render: false, capture: true });
  assert.deepEqual([cfg.hotkey.ctrl, cfg.hotkey.alt, cfg.hotkey.keycode], [true, true, 30]);

  fs.writeFileSync(file, '{ битый json');
  assert.equal(new ConfigStore(file).load().sectors, 8); // повреждённый файл не ломает запуск
  fs.rmSync(dir, { recursive: true, force: true });
});
