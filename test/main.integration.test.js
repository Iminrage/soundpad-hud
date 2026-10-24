'use strict';

// Интеграционный тест главного процесса: подменяем 'electron' и 'uiohook-napi' заглушками,
// поднимаем имитацию Soundpad на pipe и проверяем всю цепочку
// «клавиши/мышь -> колесо -> выбор сектора -> команда в Soundpad».
// Реальный Electron и настоящий uiohook этим тестом НЕ проверяются.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { startMockSoundpad, defaultHandler } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail(`не дождались: ${what}`);
}

function makeFakes(userData) {
  const sent = [];
  const windows = [];
  const handlers = new Map();
  const listeners = new Map();
  const appEvents = new EventEmitter();
  const notifications = [];
  const errors = [];

  class FakeWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.visible = false;
      windows.push(this);
      this.scripts = [];
      this.webContents = {
        send: (channel, payload) => sent.push({ win: this, channel, payload }),
        isDestroyed: () => false,
        executeJavaScript: async (code, userGesture) => {
          this.scripts.push({ code, userGesture });
        },
      };
    }
    loadFile(f) {
      this.file = f;
    }
    setIgnoreMouseEvents(v) {
      this.ignoreMouse = v;
    }
    setFocusable(v) {
      this.focusable = v;
    }
    isFocused() {
      return !!this.focused;
    }
    setAlwaysOnTop() {}
    setMenu() {}
    setBounds(b) {
      this.bounds = b;
    }
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
      this.focused = false;
    }
    focus() {
      this.focused = true;
    }
    isDestroyed() {
      return false;
    }
  }

  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      quit() {
        electron.quitCalled = true;
      },
      on: (e, cb) => appEvents.on(e, cb),
      whenReady: () => Promise.resolve(),
      getPath: () => userData,
    },
    BrowserWindow: FakeWindow,
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
    },
    Menu: { buildFromTemplate: (t) => t },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) },
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    shell: { openPath: async () => '' },
    nativeImage: {
      createFromPath: () => ({
        resize() {
          return this;
        },
      }),
    },
    Notification: class {
      static isSupported() {
        return true;
      }
      constructor(o) {
        notifications.push(o);
      }
      show() {}
    },
    dialog: {
      showErrorBox(title, msg) {
        errors.push(msg);
      },
    },
  };

  const uio = new EventEmitter();
  const hook = new EventEmitter();
  hook.start = () => {
    hook.started = true;
  };
  hook.stop = () => {};
  uio.uIOhook = hook;
  uio.UiohookKey = {
    Ctrl: 29, CtrlRight: 3613, Shift: 42, ShiftRight: 54, Alt: 56, AltRight: 3640,
    Meta: 3675, MetaRight: 3676, Escape: 1, Space: 57, ArrowLeft: 57419, ArrowRight: 57421, A: 30, C: 46,
  };

  return { electron, uio, hook, sent, windows, handlers, listeners, appEvents, notifications, errors };
}

test('главный процесс: от хоткея до команды в Soundpad', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sphud-main-'));
  // конфиг как у старой версии: Ctrl+Space с keycode: null, без колеса категорий и без stayOpen
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      hotkey: { ctrl: true, alt: false, shift: false, meta: false, keycode: null, name: 'Space' },
      catHotkey: null,
      stayOpen: false,
    })
  );
  let playStatus = 'STOPPED';
  const mock = await startMockSoundpad((cmd) => (cmd === 'GetPlayStatus()' ? playStatus : defaultHandler(cmd)));
  const fk = makeFakes(userData);

  process.env.SOUNDPAD_PIPE = mock.pipePath;
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fk.electron;
    if (request === 'uiohook-napi') return fk.uio;
    return origLoad.call(this, request, ...rest);
  };
  t.after(async () => {
    Module._load = origLoad;
    fk.appEvents.emit('before-quit');
    await mock.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  require('../src/main/main.js');
  await waitFor(() => fk.hook.started, 'старт хука');
  assert.deepEqual(fk.errors, []);
  assert.equal(fk.windows.length, 2); // оверлей и настройки
  const [overlay, settings] = fk.windows;
  assert.equal(overlay.opts.focusable, false);
  assert.equal(overlay.opts.transparent, true);

  const invoke = (ch, ...args) => fk.handlers.get(ch)({}, ...args);
  const key = (type, keycode, mods = {}) =>
    fk.hook.emit(type, { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const lastOf = (channel) => [...fk.sent].reverse().find((m) => m.win === overlay && m.channel === channel);
  const playCmds = () => mock.commands.filter((c) => c.startsWith('DoPlay'));
  const stopCmds = () => mock.commands.filter((c) => c === 'DoStopSound()').length;

  // --- статус и библиотека
  const status = await invoke('sp:status');
  assert.deepEqual([status.online, status.version, status.rcVersion], [true, '9.9.9', '1.1.2']);
  await waitFor(async () => (await invoke('cfg:get')).firstRunDone, 'первичная загрузка библиотеки');
  const cfg0 = await invoke('cfg:get');
  assert.equal(cfg0.hotkey.keycode, 57); // по умолчанию Space из таблицы клавиш
  assert.deepEqual([cfg0.slots[0].title, cfg0.slots[1].title], ['Bruh', 'Vine boom']); // автозаполнение
  assert.equal(cfg0.slots[2].catId, null);
  const lib = await invoke('sp:library', false);
  assert.equal(lib.library.categories[0].id, 'all');

  // --- режим hold: открыть, выбрать сектор 1 (вверх-вправо), отпустить
  assert.deepEqual([overlay.ignoreMouse, overlay.opts.focusable], [true, false]); // в покое оверлей «прозрачен»
  key('keydown', 57, { ctrlKey: true });
  assert.equal(overlay.visible, true);
  // grabFocus по умолчанию: оверлей забирает фокус и мышь у игры
  assert.deepEqual([overlay.focused, overlay.focusable, overlay.ignoreMouse], [true, true, false]);
  assert.deepEqual(overlay.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  const shown = lastOf('overlay:show').payload;
  assert.equal(shown.sectors, 8);
  assert.equal(shown.slots[0].label, 'Bruh');
  assert.equal(shown.slots[2].empty, true);

  fk.hook.emit('mousemove', { x: 500, y: 500 }); // первая точка — только база
  fk.hook.emit('mousemove', { x: 560, y: 440 }); // +60, -60: направление 45°
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 1, 'выбор сектора 1');

  key('keyup', 57);
  await waitFor(() => playCmds().length === 1, 'команда воспроизведения');
  assert.equal(playCmds()[0], 'DoPlaySoundFromCategory(1, 2, true, true)');
  assert.equal(lastOf('overlay:hide') !== undefined, true);
  await waitFor(() => overlay.visible === false, 'скрытие оверлея');
  assert.deepEqual([overlay.focused, overlay.focusable, overlay.ignoreMouse], [false, false, true]); // фокус вернули
  // --- потеря фокуса (Alt+Tab) отменяет выбор
  key('keydown', 57, { ctrlKey: true });
  fk.hook.emit('mousemove', { x: 500, y: 500 });
  fk.hook.emit('mousemove', { x: 560, y: 440 });
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 1, 'выбор перед потерей фокуса');
  overlay.emit('blur');
  key('keyup', 57);
  await waitFor(() => overlay.visible === false, 'скрытие после потери фокуса');
  assert.equal(playCmds().length, 1);
  // --- захват указателя: выбор по смещениям из оверлея, движения uiohook не учитываются
  const fromOverlay = (ch, ...args) => fk.listeners.get(ch)({}, ...args);
  const scriptsBefore = overlay.scripts.length;
  key('keydown', 57, { ctrlKey: true });
  assert.deepEqual(overlay.scripts.slice(scriptsBefore), [{ code: 'window.lockPointer && window.lockPointer()', userGesture: true }]);
  fromOverlay('overlay:pointer-lock', true);
  fk.hook.emit('mousemove', { x: 0, y: 0 });
  fk.hook.emit('mousemove', { x: -90, y: 0 }); // курсор упёрся бы в край: игнорируем
  fromOverlay('overlay:move', 0, 90); // вниз
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 4, 'выбор по смещениям из оверлея');
  key('keydown', 1); // Esc
  key('keyup', 57);
  fromOverlay('overlay:pointer-lock', false);
  fromOverlay('overlay:move', 90, 0); // после закрытия смещения ничего не делают
  await waitFor(() => overlay.visible === false, 'скрытие после захвата');
  assert.equal(playCmds().length, 1);

  // --- grabFocus выключен: старое поведение, фокус не трогаем
  await invoke('cfg:set', { grabFocus: false });
  const scriptsNoGrab = overlay.scripts.length;  key('keydown', 57, { ctrlKey: true });
  assert.deepEqual([overlay.visible, overlay.focused, overlay.ignoreMouse], [true, false, true]);
  assert.equal(overlay.scripts.length, scriptsNoGrab); // указатель не захватываем
  overlay.emit('blur'); // без grabFocus потеря фокуса колесо не закрывает
  assert.equal(overlay.visible, true);
  key('keydown', 1);
  key('keyup', 57);
  await waitFor(() => overlay.visible === false, 'скрытие без grabFocus');  await invoke('cfg:set', { grabFocus: true });

  // --- отпускание в мёртвой зоне ничего не играет
  key('keydown', 57, { ctrlKey: true });
  key('keyup', 57);
  await sleep(60);
  assert.equal(playCmds().length, 1);

  // --- Esc отменяет
  key('keydown', 57, { ctrlKey: true });
  fk.hook.emit('mousemove', { x: 0, y: 0 });
  fk.hook.emit('mousemove', { x: 0, y: -90 });
  key('keydown', 1);
  key('keyup', 57);
  await sleep(60);
  assert.equal(playCmds().length, 1);

  // --- стрелки выбирают сектор: → из пустого выбора даёт сектор 0
  key('keydown', 57, { ctrlKey: true });
  key('keydown', 57419); // ArrowLeft: сектор 7 (последний)
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 7, 'стрелка влево');
  key('keydown', 57421); // ArrowRight: обратно в 0
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 0, 'стрелка вправо');
  key('keyup', 57);
  await waitFor(() => playCmds().length === 2, 'воспроизведение по стрелкам');
  assert.equal(playCmds()[1], 'DoPlaySoundFromCategory(1, 1, true, true)');

  // --- режим toggle: клик подтверждает, правая кнопка отменяет
  await invoke('cfg:set', { mode: 'toggle', lines: { capture: false } });
  key('keydown', 57, { ctrlKey: true });
  key('keyup', 57);
  key('keyup', 29);
  assert.equal(overlay.visible, true); // колесо осталось открытым
  fk.hook.emit('mousemove', { x: 0, y: 0 });
  fk.hook.emit('mousemove', { x: 60, y: -60 });
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 1, 'выбор в toggle');
  fk.hook.emit('mousedown', { button: 1 });
  await waitFor(() => playCmds().length === 3, 'клик подтвердил выбор');
  assert.equal(playCmds()[2], 'DoPlaySoundFromCategory(1, 2, true, false)'); // линия capture выключена

  // --- ПКМ зажата: предпрослушивание только в наушники, отпустил — стоп; колесо остаётся открытым
  key('keydown', 57, { ctrlKey: true });
  key('keyup', 57);
  fk.hook.emit('mousemove', { x: 0, y: 0 });
  fk.hook.emit('mousemove', { x: 60, y: -60 });
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 1, 'выбор перед предпрослушиванием');
  const stops0 = stopCmds();
  fk.hook.emit('mousedown', { button: 2 });
  await waitFor(() => playCmds().length === 4, 'предпрослушивание');
  assert.equal(playCmds()[3], 'DoPlaySoundFromCategory(1, 2, true, false)');
  assert.equal(overlay.visible, true);
  fk.hook.emit('mouseup', { button: 2 });
  await waitFor(() => stopCmds() === stops0 + 1, 'стоп после отпускания ПКМ');
  key('keydown', 1); // Esc
  await sleep(60);
  assert.equal(stopCmds(), stops0 + 1); // предпрослушивание уже остановлено, лишний стоп не нужен
  await invoke('cfg:set', { mode: 'hold' });

  // --- запись новой комбинации: Ctrl+Shift+A
  await waitFor(() => overlay.visible === false, 'скрытие оверлея после Esc в toggle');
  await invoke('hotkey:record');
  key('keydown', 29, { ctrlKey: true });
  assert.equal(overlay.visible, false);
  key('keydown', 30, { ctrlKey: true, shiftKey: true });
  const rec = fk.sent.find((m) => m.win === settings && m.channel === 'hotkey:recorded');
  assert.equal(rec.payload.label, 'Ctrl + Shift + A');
  key('keyup', 30);
  key('keyup', 29);
  const cfg1 = await invoke('cfg:get');
  assert.deepEqual([cfg1.hotkey.shift, cfg1.hotkey.keycode, cfg1.hotkey.name], [true, 30, 'A']);
  key('keydown', 57, { ctrlKey: true }); // старая комбинация больше не открывает колесо
  assert.equal(overlay.visible, false);
  key('keyup', 57);
  key('keydown', 30, { ctrlKey: true, shiftKey: true });
  assert.equal(overlay.visible, true);
  key('keyup', 30);

  // --- тест сектора из настроек и пустой сектор
  assert.deepEqual(await invoke('sp:test-slot', 0), { ok: true });
  assert.equal((await invoke('sp:test-slot', 5)).ok, false);

  // --- категория по страницам: «Все звуки» (5 звуков), 4 сектора = 3 звука + «Стоп» снизу, 2 страницы
  await waitFor(() => overlay.visible === false, 'скрытие оверлея перед страницами');
  await invoke('cfg:set', { sectors: 4, source: { catId: 'all', name: 'Все звуки' } });
  const open = () => key('keydown', 30, { ctrlKey: true, shiftKey: true });
  const wheel = (rotation, direction = 3) => fk.hook.emit('wheel', { rotation, direction });
  open();
  const p1 = lastOf('overlay:show').payload;
  assert.deepEqual(p1.page, { n: 1, total: 2 });
  assert.deepEqual(p1.slots.map((s) => s.label), ['Bruh', 'Vine boom', 'Стоп', 'Oof']);
  assert.deepEqual(p1.slots.map((s) => s.stop), [false, false, true, false]);
  key('keydown', 57421); // → сектор 0
  wheel(1, 4); // горизонтальная прокрутка не листает
  wheel(0); // неполный щелчок колеса
  assert.equal(lastOf('overlay:page'), undefined);
  wheel(1); // вниз: следующая страница, выбор сектора остаётся
  const p2 = lastOf('overlay:page').payload;
  assert.deepEqual([p2.page, p2.selected], [{ n: 2, total: 2 }, 0]);
  assert.deepEqual(p2.slots.map((s) => s.label), ['airhorn', 'Кто-то - Тест', 'Стоп', '']);
  assert.deepEqual(p2.slots.map((s) => s.empty), [false, false, false, true]);
  key('keyup', 30);
  await waitFor(() => playCmds().length === 6, 'воспроизведение со второй страницы');
  assert.equal(playCmds()[5], 'DoPlaySound(4, true, false)');

  // страница запоминается между открытиями и листается по кругу
  await waitFor(() => overlay.visible === false, 'скрытие оверлея после страниц');
  open();
  assert.deepEqual(lastOf('overlay:show').payload.page, { n: 2, total: 2 });
  wheel(-1);
  assert.deepEqual(lastOf('overlay:page').payload.page, { n: 1, total: 2 });
  wheel(-1);
  assert.deepEqual(lastOf('overlay:page').payload.page, { n: 2, total: 2 });

  // нижний сектор «Стоп» останавливает звук
  key('keydown', 57421);
  key('keydown', 57421);
  key('keydown', 57421); // → сектор 2, он снизу при 4 секторах
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 2, 'выбор стоп-сектора');
  const stops1 = stopCmds();
  key('keyup', 30);
  await waitFor(() => stopCmds() === stops1 + 1, 'команда стоп');
  assert.equal(playCmds().length, 6);

  // свои секторы: одна страница, прокрутка ничего не делает
  await invoke('cfg:set', { source: { catId: null } });
  await waitFor(() => overlay.visible === false, 'скрытие оверлея после Esc');
  open();
  assert.equal(lastOf('overlay:show').payload.page, null);
  const flips = fk.sent.filter((m) => m.channel === 'overlay:page').length;
  wheel(1);
  assert.equal(fk.sent.filter((m) => m.channel === 'overlay:page').length, flips);
  key('keydown', 1);
  key('keyup', 30);

  // --- колесо категорий: запись своего хоткея Ctrl+Alt+C
  await waitFor(() => overlay.visible === false, 'скрытие перед колесом категорий');
  await invoke('hotkey:record', 'cats');
  key('keydown', 46, { ctrlKey: true, altKey: true });
  const recCats = [...fk.sent].reverse().find((m) => m.win === settings && m.channel === 'hotkey:recorded');
  assert.deepEqual([recCats.payload.target, recCats.payload.label], ['cats', 'Ctrl + Alt + C']);
  assert.equal((await invoke('cfg:get')).hotkey.keycode, 30); // основной хоткей не тронут
  key('keyup', 46);

  const openCats = () => key('keydown', 46, { ctrlKey: true, altKey: true });
  const right = (n) => {
    for (let i = 0; i < n; i++) key('keydown', 57421);
  };
  const click = () => fk.hook.emit('mousedown', { button: 1 });

  // меню: «Частые» (из колёс уже играли Vine boom ×2, Bruh, airhorn), потом непустые категории,
  // по 3 на страницу (4 сектора, снизу «Стоп»)
  openCats();
  const menu = lastOf('overlay:show').payload;
  assert.equal(menu.title, 'Выбери категорию');
  assert.deepEqual(menu.slots.map((s) => s.label), ['Частые', 'Все звуки', 'Стоп', 'Мемы & шутки']);
  assert.deepEqual(menu.slots.map((s) => s.folder), [true, true, false, true]);
  assert.deepEqual(menu.page, { n: 1, total: 2 });

  // «Частые»: по убыванию счёта, при равенстве недавний выше; играются через «Все звуки»
  right(1);
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 0, 'выбор «Частых»');
  click();
  const top = lastOf('overlay:show').payload;
  assert.equal(top.title, 'Частые');
  assert.deepEqual(top.slots.map((s) => s.label), ['Vine boom', 'airhorn', 'Назад', 'Bruh']);
  right(3);
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 2, 'выбор «Назад» из «Частых»');
  click();

  // клик по категории открывает её звуки; пока ничего не играет, снизу «Назад»
  right(4); // → сектор 3, «Мемы & шутки»
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 3, 'выбор категории');
  click();
  const inCat = lastOf('overlay:show').payload;
  assert.equal(overlay.visible, true); // клик по категории колесо не закрывает
  assert.equal(inCat.title, 'Мемы & шутки');
  assert.deepEqual(inCat.slots.map((s) => s.label), ['Bruh', 'Vine boom', 'Назад', '']);
  assert.deepEqual([inCat.slots[2].back, inCat.slots[2].stop, inCat.selected], [true, false, null]);
  assert.deepEqual(inCat.ctx, { holding: true, stayOpen: false, canBack: true }); // для подсказок: ПКМ в центре — назад

  // «Назад» по клику возвращает в меню
  right(3); // → сектор 2
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 2, 'выбор «Назад»');
  click();
  assert.equal(lastOf('overlay:show').payload.title, 'Выбери категорию');

  // отпускание хоткея на категории просто закрывает колесо
  const plays0 = playCmds().length;
  right(1);
  key('keyup', 46);
  await waitFor(() => overlay.visible === false, 'скрытие колеса категорий');
  assert.equal(playCmds().length, plays0);

  // звук играет: снизу «Стоп» вместо «Назад», он и срабатывает
  openCats();
  right(4);
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 3, 'выбор категории 2');
  click();
  const mark = fk.sent.length;
  const pageAfter = () => fk.sent.slice(mark).reverse().find((m) => m.win === overlay && m.channel === 'overlay:page');
  playStatus = 'PLAYING';
  await waitFor(() => pageAfter()?.payload.slots[2].stop === true, '«Стоп» вместо «Назад»');
  assert.equal(pageAfter().payload.flip, false); // без анимации листания
  right(3);
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 2, 'выбор «Стоп»');
  const stops2 = stopCmds();
  key('keyup', 46);
  await waitFor(() => stopCmds() === stops2 + 1, 'стоп из колеса категорий');
  playStatus = 'STOPPED';

  // звук из открытой категории играет как обычно
  await waitFor(() => overlay.visible === false, 'скрытие после стопа');
  openCats();
  right(4);
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 3, 'выбор категории 3');
  click();
  right(1); // → «Bruh»
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 0, 'выбор звука в категории');
  key('keyup', 46);
  await waitFor(() => playCmds().length === plays0 + 1, 'звук из колеса категорий');
  assert.equal(playCmds().at(-1), 'DoPlaySoundFromCategory(1, 1, true, false)');

  // --- stayOpen: отпустил бинд в центре — колесо открыто, выбор кликом
  await waitFor(() => overlay.visible === false, 'скрытие перед stayOpen');
  await invoke('cfg:set', { stayOpen: true });
  const plays1 = playCmds().length;
  open();
  key('keyup', 30);
  await waitFor(() => lastOf('overlay:page')?.payload.ctx.holding === false, 'подсказки после отпускания: бинд уже не держат');
  assert.equal(overlay.visible, true);
  right(1); // → сектор 0, «Bruh»
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 0, 'выбор после отпускания');
  click();
  await waitFor(() => playCmds().length === plays1 + 1, 'клик после отпускания играет');
  await waitFor(() => overlay.visible === false, 'скрытие после клика');

  // --- сброс разделов: бинды по умолчанию — Ctrl+Alt (колесо звуков) и Ctrl+Shift (категории)
  await waitFor(() => overlay.visible === false, 'скрытие перед сбросом');
  const reset = await invoke('cfg:reset', 'binds');
  const mods = (hk) => [hk.ctrl, hk.alt, hk.shift, hk.meta, hk.modsOnly];
  assert.deepEqual(mods(reset.hotkey), [true, true, false, false, true]);
  assert.deepEqual(mods(reset.catHotkey), [true, false, true, false, true]);
  const look = await invoke('cfg:reset', 'look');
  assert.deepEqual([look.sectors, look.stayOpen], [8, true]); // чужой раздел не тронут
  const stops3 = stopCmds();
  const plays3 = playCmds().length;

  // ЛКМ в центре закрывает колесо без звука
  key('keydown', 29, { ctrlKey: true });
  key('keydown', 56, { ctrlKey: true, altKey: true });
  assert.equal(overlay.visible, true); // Ctrl+Alt открывает колесо звуков
  assert.equal(lastOf('overlay:show').payload.title, 'Выбери звук');
  click();
  await waitFor(() => overlay.visible === false, 'ЛКМ в центре закрыла колесо');
  key('keyup', 56);
  key('keyup', 29);

  // ПКМ в центре: из категории назад в меню, а из меню (назад некуда) — закрыть
  key('keydown', 29, { ctrlKey: true });
  key('keydown', 42, { ctrlKey: true, shiftKey: true });
  assert.equal(lastOf('overlay:show').payload.title, 'Выбери категорию'); // Ctrl+Shift — колесо категорий
  right(3); // после сброса вида снова 8 секторов: «Частые», «Все звуки», «Мемы & шутки»…
  await waitFor(() => lastOf('overlay:state')?.payload.selected === 2, 'выбор категории для ПКМ');
  click();
  assert.equal(lastOf('overlay:show').payload.title, 'Мемы & шутки');
  fk.hook.emit('mousedown', { button: 2 }); // выбор сброшен при входе: курсор в центре
  assert.equal(lastOf('overlay:show').payload.title, 'Выбери категорию');
  assert.equal(overlay.visible, true);
  fk.hook.emit('mousedown', { button: 2 });
  await waitFor(() => overlay.visible === false, 'ПКМ в центре меню закрыла колесо');
  key('keyup', 42);
  key('keyup', 29);
  assert.deepEqual([stopCmds(), playCmds().length], [stops3, plays3]); // ничего не играли и не останавливали

  await invoke('cfg:reset', 'binds');
  await invoke('hotkey:record');
  key('keydown', 30, { ctrlKey: true, shiftKey: true }); // для проверки записи на диск ниже
  key('keyup', 30);

  // --- конфиг записан на диск
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(saved.hotkey.keycode, 30);
  assert.deepEqual(fk.errors, []);
});
