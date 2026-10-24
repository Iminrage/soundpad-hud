'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  shell,
  nativeImage,
  Notification,
  dialog,
} = require('electron');

const { ConfigStore, resetPatch } = require('./config');
const { SoundpadClient } = require('./soundpad');
const {
  loadLibrary,
  relinkSlots,
  fillSlotsFromCategory,
  resolveSource,
  pageCount,
  wrapPage,
  pageSlots,
  listPageCount,
  soundsPerWheel,
  withStop,
  backSlot,
  menuCategories,
  menuSlots,
  topCategory,
  TOP_ID,
  ALL_ID,
} = require('./library');
const { PlayStats } = require('./stats');
const { HotkeyMachine, comboLabel } = require('./hotkey');
const { WheelSelection } = require('./selection');
const { createLogger } = require('./logger');

const SRC = path.join(__dirname, '..');
const ICON = path.join(SRC, 'assets', 'icon.png');

let store;
let stats;
let log;
let sp;
let machine;
let uio = null;
let keyNames = new Map();
const sel = new WheelSelection();

let library = null;
let libraryError = null;
let refreshing = null;

let overlay = null;
let settings = null;
let tray = null;
let hideTimer = null;
let pushTimer = null;
let lastMouse = null;
let pointerLocked = false; // оверлей захватил указатель: смещения идут от него, uiohook-движения не нужны
// текущие страницы, помним между открытиями: main — категория-источник обычного колеса,
// menu — меню колеса категорий, cat — категория, открытая из меню
const pages = { main: 0, menu: 0, cat: 0 };
let view = null; // то, что сейчас на колесе: { key, title, slots, page, pages }
let wheelKind = 'main'; // 'main' — обычное колесо, 'cats' — колесо категорий
let catOpen = null; // колесо категорий: id открытой категории, null — меню категорий
let playing = false; // Soundpad что-то играет: в колесе категорий снизу «Стоп», иначе «Назад»
let statusTimer = null;
let previewing = false; // зажата ПКМ: звук играет только в наушники
let lastNotifyAt = 0;
let quitting = false;

// ---------------------------------------------------------------- окна

function send(win, channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function createOverlay() {
  overlay = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // фокус берём только на время показа и только с grabFocus (см. showOverlay)
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(SRC, 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(SRC, 'overlay', 'overlay.html'));
  overlay.on('blur', () => {
    // фокус ушёл (Alt+Tab, всплывшее окно), пока колесо открыто: отменяем, а не висим поверх
    if (machine && machine.open && store.get().grabFocus) machine.close(false);
  });
}

function createSettings() {
  settings = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    title: 'Soundpad HUD',
    icon: ICON,
    webPreferences: {
      preload: path.join(SRC, 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settings.setMenu(null);
  settings.loadFile(path.join(SRC, 'settings', 'settings.html'));
  settings.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      settings.hide();
    }
  });
}

function showSettings() {
  if (!settings || settings.isDestroyed()) createSettings();
  settings.show();
  settings.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Soundpad HUD');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Настройки', click: showSettings },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ])
  );
  tray.on('click', showSettings);
}

// ---------------------------------------------------------------- оверлей

/**
 * Секторы колеса, нижний всегда «Стоп». Обычное колесо: свои секторы или страница категории-источника.
 * Колесо категорий: меню категорий, а после клика страница выбранной категории; там, пока ничего
 * не играет, снизу «Назад» вместо «Стопа».
 */
function buildView(cfg) {
  const n = soundsPerWheel(cfg.sectors);
  if (wheelKind === 'cats' && catOpen == null) {
    const top = topCategory(stats.ranked(), library); // «Частые» первыми, если уже что-то играли
    const cats = [...(top ? [top] : []), ...menuCategories(library)];
    const total = listPageCount(cats.length, n);
    pages.menu = wrapPage(pages.menu, total);
    const slots = withStop(menuSlots(cats, n, pages.menu), cfg.sectors);
    return { key: 'menu', title: 'Выбери категорию', slots, page: pages.menu, pages: total };
  }
  if (wheelKind === 'main' && cfg.source.catId == null) {
    return { key: 'main', title: 'Выбери звук', slots: withStop(cfg.slots, cfg.sectors), page: 0, pages: 1 };
  }

  const key = wheelKind === 'cats' ? 'cat' : 'main';
  let cat;
  if (wheelKind !== 'cats') cat = resolveSource(cfg.source, library);
  else if (catOpen === TOP_ID) cat = topCategory(stats.ranked(), library);
  else cat = resolveSource({ catId: catOpen }, library);
  const bottom = wheelKind === 'cats' && !playing ? backSlot() : undefined;
  // библиотека ещё не загружена или категория пропала: пустое колесо, а не чужие секторы
  if (!cat) return { key, title: 'Выбери звук', slots: withStop([], cfg.sectors, bottom), page: 0, pages: 1 };
  const total = pageCount(cat, n);
  pages[key] = wrapPage(pages[key], total);
  const slots = withStop(pageSlots(cat, n, pages[key]), cfg.sectors, bottom);
  return { key, title: wheelKind === 'cats' ? cat.name : 'Выбери звук', slots, page: pages[key], pages: total };
}

/** Выбор этого сектора что-то делает: играет звук или «Стоп». Папки, «Назад» и пустые — нет. */
const isPlayable = (slot) => !!slot && (slot.stop || (!slot.folder && slot.catId != null && slot.pos != null));

function overlayPayload(cfg) {
  // бинд ещё держат (hold и колесо не «залипло» после отпускания мимо звука)
  const holding = cfg.mode === 'hold' && !(machine && machine.stuck);
  return {
    sectors: cfg.sectors,
    slots: view.slots.map((s) => ({
      label: s.label || s.title || '',
      icon: s.icon || '',
      empty: !s.stop && !s.back && !s.folder && (s.catId == null || s.pos == null),
      stop: !!s.stop,
      back: !!s.back,
      folder: !!s.folder,
      sub: s.folder ? `${s.count} зв.` : '',
      // полное название для панели над колесом: у звука — название из Soundpad, у папки — путь категории
      full: s.stop || s.back ? '' : s.title || s.label || '',
    })),
    selected: sel.selected,
    title: view.title,
    page: view.pages > 1 ? { n: view.page + 1, total: view.pages } : null,
    // для совета и подсказок под колесом: что сделают отпускание бинда, клики и прокрутка
    ctx: {
      holding,
      stayOpen: holding && cfg.stayOpen,
      toggle: cfg.mode === 'toggle',
      canBack: wheelKind === 'cats' && catOpen != null,
      showTips: cfg.showTips,
      showHints: cfg.showHints,
    },
  };
}

/**
 * Перестраивает колесо. 'show' — с нуля (выбор сброшен), 'flip' — новая страница с анимацией,
 * 'quiet' — без анимации (сменился «Стоп»/«Назад»).
 */
function rebuild(how) {
  const cfg = store.get();
  view = buildView(cfg);
  if (how === 'show') {
    sel.reset();
    lastMouse = null;
    send(overlay, 'overlay:show', overlayPayload(cfg));
  } else {
    send(overlay, 'overlay:page', { ...overlayPayload(cfg), flip: how === 'flip' });
  }
}

/** Колесо категорий: спрашиваем Soundpad, играет ли звук, и меняем «Назад» на «Стоп» и обратно. */
async function refreshPlaying() {
  if (wheelKind !== 'cats' || previewing) return;
  let now;
  try {
    now = /^(PLAYING|PAUSED|SEEKING)$/.test(await sp.getPlayStatus());
  } catch {
    return;
  }
  if (now === playing || !machine.open || previewing) return; // своё предпрослушивание не считаем
  playing = now;
  if (catOpen != null) rebuild('quiet');
}

/**
 * Клик ЛКМ в колесе категорий: открыть категорию или вернуться в меню.
 * true — клик обработан и колесо остаётся открытым.
 */
function navigate() {
  if (wheelKind !== 'cats') return false;
  const slot = sel.selected == null ? null : view.slots[sel.selected];
  if (view.key === 'menu') {
    if (slot && slot.stop) return false; // «Стоп» срабатывает как обычно
    if (slot && slot.folder) {
      catOpen = slot.catId;
      pages.cat = 0;
      rebuild('show');
    }
    return true; // клик мимо категории ничего не делает
  }
  if (slot && slot.back) return goBack();
  return false;
}

/** Колесо категорий: из открытой категории обратно в меню. false — «назад» некуда. */
function goBack() {
  if (wheelKind !== 'cats' || catOpen == null) return false;
  catOpen = null;
  rebuild('show');
  return true;
}

/** ПКМ зажата на звуке: играем его только в наушники, пока кнопку не отпустят. */
function startPreview() {
  const slot = sel.selected == null ? null : view.slots[sel.selected];
  if (!isPlayable(slot) || slot.stop) return;
  previewing = true;
  playSlot(slot, { source: 'preview', lines: { render: true, capture: false } });
}

function stopPreview() {
  if (!previewing) return;
  previewing = false;
  sp.stop().catch(() => {});
}

function showOverlay({ id } = {}) {
  const cfg = store.get();
  clearTimeout(hideTimer);
  wheelKind = id === 'cats' ? 'cats' : 'main';
  catOpen = null;
  playing = false;
  previewing = false;
  clearInterval(statusTimer);
  if (wheelKind === 'cats') {
    refreshPlaying();
    statusTimer = setInterval(refreshPlaying, 400);
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlay.setBounds(display.bounds);
  sel.configure({ sectors: cfg.sectors, deadzone: cfg.deadzone, sensitivity: cfg.sensitivity });
  sel.reset();
  lastMouse = null;
  view = buildView(cfg);
  send(overlay, 'overlay:show', overlayPayload(cfg));
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (!cfg.grabFocus) {
    overlay.showInactive();
    return;
  }
  // забираем фокус: игра перестаёт читать мышь, клики и прокрутка достаются оверлею, а не окну под ним
  overlay.setIgnoreMouseEvents(false);
  overlay.setFocusable(true);
  overlay.show();
  overlay.focus();
  // захват указателя требует жеста пользователя: executeJavaScript(..., true) его даёт
  pointerLocked = false;
  overlay.webContents.executeJavaScript('window.lockPointer && window.lockPointer()', true).catch((e) => {
    log.debug('захват указателя:', e.message);
  });
  setTimeout(() => {
    if (!machine.open) return;
    if (!overlay.isFocused()) log.info('оверлей не получил фокус: Windows не дала забрать его у игры');
    else if (!pointerLocked) log.info('захват указателя не включился: выбор по движениям из uiohook');
  }, 150);
}

/** Возвращает оверлею «прозрачность» для мыши и фокуса после скрытия. */
function releaseOverlay() {
  overlay.setFocusable(false);
  overlay.setIgnoreMouseEvents(true);
}

/** Листание колесом мыши: выбранный сектор остаётся, меняются звуки в секторах. */
function flipPage(delta) {
  if (!machine.open || !view || view.pages < 2) return;
  pages[view.key] = wrapPage(pages[view.key] + delta, view.pages);
  rebuild('flip');
}

function hideOverlay() {
  clearTimeout(pushTimer);
  pushTimer = null;
  send(overlay, 'overlay:hide');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (machine.open || !overlay || overlay.isDestroyed()) return;
    overlay.hide(); // Windows отдаёт фокус окну под оверлеем, то есть игре
    releaseOverlay();
  }, 160);
}

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (machine.open) send(overlay, 'overlay:state', sel.snapshot());
  }, 8);
}

// ---------------------------------------------------------------- Soundpad

function notifyError(body) {
  log.error('playback:', body);
  const now = Date.now();
  if (now - lastNotifyAt < 3000) return;
  lastNotifyAt = now;
  try {
    if (Notification.isSupported()) new Notification({ title: 'Soundpad HUD', body }).show();
  } catch {
    /* уведомление не критично */
  }
}

/** source: 'wheel' (ошибки показываем уведомлением), 'test' или 'preview'; lines — вместо cfg.lines. */
async function playSlot(slot, { source = 'wheel', fallbackName = 'звук', lines } = {}) {
  const cfg = store.get();
  const isStop = !!(slot && slot.stop);
  if (!isStop && (!slot || slot.folder || slot.catId == null || slot.pos == null)) return { ok: false, error: 'Сектор пуст' };
  const name = isStop ? 'Стоп' : slot.label || slot.title || fallbackName;
  try {
    const { render, capture } = lines || cfg.lines;
    let r;
    if (isStop) r = await sp.stop();
    else if (slot.catId === ALL_ID) r = await sp.playSound(slot.index ?? slot.pos, render, capture);
    else r = await sp.playFromCategory(slot.catId, slot.pos, render, capture);
    if (!r.ok) {
      if (source === 'wheel') notifyError(`Soundpad ответил «${r.response || 'пусто'}» на «${name}»`);
      return { ok: false, error: r.response || 'пустой ответ' };
    }
    if (source === 'wheel' && !isStop) stats.record(slot.url); // для «Частых»; прослушивание по ПКМ не считаем
    return { ok: true };
  } catch (e) {
    if (source === 'wheel') notifyError(e.message);
    return { ok: false, error: e.message };
  }
}

function refreshLibrary() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      library = await loadLibrary(sp);
      libraryError = null;
      const cfg = store.get();
      const relinked = relinkSlots(cfg.slots, library);
      let patch = relinked.changed ? { slots: relinked.slots } : null;
      const srcCat = resolveSource(cfg.source, library);
      if (srcCat && srcCat.id !== cfg.source.catId) {
        // категорию-источник переставили в Soundpad: запоминаем её новый индекс
        patch = { ...(patch || {}), source: { catId: srcCat.id, name: srcCat.name } };
      }

      if (!cfg.firstRunDone) {
        // первый запуск: если сектора пусты, заполняем их первыми звуками первой непустой категории
        const base = patch ? patch.slots : cfg.slots;
        const src =
          library.categories.find((c) => c.id !== ALL_ID && c.sounds.length) ||
          library.categories.find((c) => c.sounds.length);
        patch = { ...(patch || {}), firstRunDone: true };
        if (src && base.every((s) => s.catId == null)) {
          patch.slots = fillSlotsFromCategory(src, soundsPerWheel(cfg.sectors), base);
        }
      }
      if (patch) store.update(patch);
      const total = library.categories.reduce((n, c) => n + (c.id === ALL_ID ? 0 : c.sounds.length), 0);
      log.info(`библиотека загружена: категорий ${library.categories.length}, звуков в категориях ${total}`);
    } catch (e) {
      library = null;
      libraryError = e.message;
      log.debug('ошибка загрузки библиотеки:', e.message);
    } finally {
      refreshing = null;
      send(settings, 'library:changed');
    }
  })();
  return refreshing;
}

async function getStatus() {
  try {
    if (!(await sp.isAlive())) return { online: false, error: 'IsAlive() вернул не R-200' };
    const [version, rcVersion] = await Promise.all([sp.getVersion(), sp.getRcVersion()]);
    if (!library && !refreshing) refreshLibrary();
    return { online: true, version, rcVersion };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('cfg:get', () => store.get());
  ipcMain.handle('cfg:set', (_e, patch) => store.update(patch));
  ipcMain.handle('cfg:reset', (_e, section) => {
    const patch = resetPatch(section);
    if (!patch) return store.get();
    if (patch.hotkey) machine.cancelRecording();
    store.update(patch);
    ensureHotkey(); // по умолчанию keycode: null, подставляем Space из таблицы uiohook
    return store.get();
  });
  ipcMain.handle('sp:status', () => getStatus());
  ipcMain.handle('sp:library', async (_e, force) => {
    if (force || !library) await refreshLibrary();
    return { library, error: libraryError };
  });
  ipcMain.handle('sp:test-slot', (_e, i) =>
    playSlot(store.get().slots[Number(i)], { source: 'test', fallbackName: `сектор ${Number(i) + 1}` })
  );
  ipcMain.handle('sp:stop', async () => {
    try {
      return await sp.stop();
    } catch (e) {
      return { ok: false, response: e.message };
    }
  });
  ipcMain.handle('hotkey:record', (_e, target) => {
    machine.startRecording(target === 'cats' ? 'cats' : 'main');
    return true;
  });
  ipcMain.handle('hotkey:cancel', () => {
    machine.cancelRecording();
    return true;
  });
  ipcMain.handle('app:open-data', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('stats:summary', () => {
    const ranked = stats.ranked();
    return { sounds: ranked.length, plays: ranked.reduce((n, s) => n + s.count, 0) };
  });
  ipcMain.handle('stats:clear', () => {
    stats.clear();
    return true;
  });

  ipcMain.on('overlay:pointer-lock', (_e, locked) => {
    pointerLocked = !!locked;
    lastMouse = null; // при возврате к uiohook первая точка снова только база
  });
  ipcMain.on('overlay:move', (_e, dx, dy) => {
    if (!machine.open || !pointerLocked) return;
    sel.move(Number(dx) || 0, Number(dy) || 0);
    schedulePush();
  });
}

// ---------------------------------------------------------------- глобальные хуки

let spaceKey = null; // код Space из таблицы uiohook, известен после загрузки хука

/** keycode: null без modsOnly (значение по умолчанию) означает Space: подставляем настоящий код. */
function ensureHotkey() {
  const hk = store.get().hotkey;
  if (hk.keycode == null && !hk.modsOnly && spaceKey != null) {
    store.update({ hotkey: { keycode: spaceKey, name: 'Space' } });
  }
}

function setupHook() {
  const K = uio.UiohookKey;
  const keys = {
    ctrl: [K.Ctrl, K.CtrlRight],
    alt: [K.Alt, K.AltRight],
    shift: [K.Shift, K.ShiftRight],
    meta: [K.Meta, K.MetaRight],
    escape: K.Escape,
    left: K.ArrowLeft,
    right: K.ArrowRight,
  };

  keyNames = new Map();
  for (const [name, code] of Object.entries(K)) if (!keyNames.has(code)) keyNames.set(code, name);

  spaceKey = K.Space;
  ensureHotkey();

  machine = new HotkeyMachine({
    keys,
    getConfig: () => store.get(),
    missed: () => !isPlayable(view && sel.selected !== null ? view.slots[sel.selected] : null),
  });

  machine.on('open', showOverlay);
  machine.on('stuck', () => rebuild('quiet')); // подсказка в центре: теперь выбор кликом
  machine.on('close', ({ confirm }) => {
    const picked = sel.selected;
    const slot = view && picked !== null ? view.slots[picked] : null;
    clearInterval(statusTimer);
    hideOverlay();
    const plays = confirm && isPlayable(slot);
    if (previewing) {
      previewing = false;
      if (!plays) sp.stop().catch(() => {}); // новый звук сам заменит предпрослушивание
    }
    if (plays) playSlot(slot, { fallbackName: `сектор ${picked + 1}` });
  });
  machine.on('recorded', (combo, target) => {
    const name = combo.modsOnly ? '' : keyNames.get(combo.keycode) || `#${combo.keycode}`;
    const field = target === 'cats' ? 'catHotkey' : 'hotkey';
    const saved = store.update({ [field]: { ...combo, name } })[field];
    send(settings, 'hotkey:recorded', { target, hotkey: saved, label: comboLabel(saved) });
  });
  machine.on('record-cancel', () => send(settings, 'hotkey:record-cancel'));

  const h = uio.uIOhook;
  h.on('keydown', (e) => {
    machine.onKeyDown(e);
    if (!machine.open) return;
    if (e.keycode === keys.left) {
      sel.step(-1);
      schedulePush();
    } else if (e.keycode === keys.right) {
      sel.step(1);
      schedulePush();
    }
  });
  h.on('keyup', (e) => machine.onKeyUp(e));
  h.on('mousemove', (e) => {
    if (!machine.open || pointerLocked) return;
    if (lastMouse) sel.move(e.x - lastMouse.x, e.y - lastMouse.y);
    lastMouse = { x: e.x, y: e.y };
    schedulePush();
  });
  h.on('mousedown', (e) => {
    if (!machine.open) return;
    const center = sel.selected === null; // курсор в мёртвой зоне
    if (e.button === 1) {
      if (center) machine.close(false); // ЛКМ в центр: закрыть без звука
      else if (!navigate()) machine.close(true); // выбрать (или навигация по категориям)
    } else if (e.button === 2) {
      if (center) {
        if (!goBack()) machine.close(false); // ПКМ в центр: «назад», а если некуда — закрыть
      } else {
        startPreview(); // ПКМ зажата на звуке: предпрослушивание в наушники
      }
    }
  });
  h.on('mouseup', (e) => {
    if (e.button === 2) stopPreview();
  });
  const vertical = uio.WheelDirection ? uio.WheelDirection.VERTICAL : 3;
  h.on('wheel', (e) => {
    // libuiohook на Windows копит дельты до целого щелчка (неполный даёт 0);
    // прокрутка вниз (к себе) положительная: следующая страница
    if (e.direction !== vertical || !e.rotation) return;
    flipPage(Math.sign(e.rotation));
  });
  h.start();
}

// ---------------------------------------------------------------- запуск

async function init() {
  const userData = app.getPath('userData');
  store = new ConfigStore(path.join(userData, 'config.json'));
  store.load();
  log = createLogger(() => store.get().debug, path.join(userData, 'hud.log'));
  store.on('save-error', (e) => log.error('не удалось сохранить конфиг:', e));
  stats = new PlayStats(path.join(userData, 'stats.json')).load();
  stats.onError = (e) => log.error('не удалось сохранить статистику звуков:', e);
  store.on('change', (cfg) => send(settings, 'cfg:changed', cfg));
  let sourceName = store.get().source.name;
  store.on('change', (cfg) => {
    // другая категория-источник: начинаем с первой страницы
    if (cfg.source.name !== sourceName) pages.main = 0;
    sourceName = cfg.source.name;
  });

  sp = new SoundpadClient({
    pipePath: process.env.SOUNDPAD_PIPE,
    log: (...a) => log.debug(...a),
  });

  try {
    uio = require('uiohook-napi');
  } catch (e) {
    log.error('uiohook-napi не загрузился:', e);
    dialog.showErrorBox('Soundpad HUD', `Не удалось загрузить uiohook-napi:\n${e.message}\n\nВыполни "npm install" заново.`);
    app.quit();
    return;
  }

  createOverlay();
  createSettings();
  createTray();
  registerIpc();

  try {
    setupHook();
  } catch (e) {
    log.error('не удалось запустить глобальный хук:', e);
    dialog.showErrorBox('Soundpad HUD', `Не удалось запустить перехват клавиш:\n${e.message}`);
    app.quit();
    return;
  }

  if (!process.argv.includes('--hidden')) showSettings();

  refreshLibrary();
  // Soundpad мог быть запущен позже нас: пробуем подтянуть библиотеку, пока её нет
  setInterval(() => {
    if (!library && !refreshing) refreshLibrary();
  }, 10000).unref();

  log.info(`запущено, конфиг: ${path.join(userData, 'config.json')}`);}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showSettings);
  app.on('window-all-closed', () => {
    /* живём в трее */
  });
  app.on('before-quit', () => {
    quitting = true;
    try {
      if (uio) uio.uIOhook.stop();
    } catch {
      /* ignore */
    }
    if (sp) sp.close();
    if (stats) stats.flush(); // счётчики пишутся с задержкой: дописываем перед выходом
  });
  app.whenReady().then(init);
}
