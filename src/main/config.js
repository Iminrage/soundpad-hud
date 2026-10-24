'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SECTOR_CHOICES = [4, 6, 8, 10, 12];
const MAX_SLOTS = 12;

const emptySlot = () => ({ catId: null, pos: null, index: null, title: '', url: '', label: '', icon: '' });
const CONFIG_VERSION = 2; // v2: поле source (листание категории); v1 читается как есть, source пустой

function defaults() {
  return {
    version: CONFIG_VERSION,
    // modsOnly: комбинация только из модификаторов, keycode тогда null.
    // keycode: null без modsOnly (старые конфиги) означает «Space»: код подставляет main из таблицы uiohook
    hotkey: { ctrl: true, alt: true, shift: false, meta: false, keycode: null, name: '', modsOnly: true },
    // колесо категорий: тот же формат, null — убран пользователем
    catHotkey: { ctrl: true, alt: false, shift: true, meta: false, keycode: null, name: '', modsOnly: true },
    mode: 'hold', // 'hold' — держишь и отпускаешь; 'toggle' — нажал, выбрал кликом, закрыл
    // hold: если бинд отпущен, а звук не выбран, колесо остаётся открытым (до клика, повтора бинда или Esc)
    stayOpen: true,
    sectors: 8,
    deadzone: 45, // радиус «мёртвой зоны» в центре, где ничего не выбрано
    sensitivity: 1, // множитель движения мыши для выбора сектора
    lines: { render: true, capture: true }, // render — слышишь ты, capture — слышат в микрофоне
    // пока колесо открыто, оверлей забирает фокус: игра не получает мышь, клики и прокрутку
    grabFocus: true,
    slots: Array.from({ length: MAX_SLOTS }, emptySlot),
    // catId: null — на колесе свои секторы (slots); иначе вся категория по страницам.
    // name нужен, чтобы найти категорию, если её индекс в Soundpad поменялся
    source: { catId: null, name: '' },
    debug: false,
    firstRunDone: false,
  };
}

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const intOrNull = (v) => (Number.isInteger(v) ? v : null);
const flag = (v, fallback) => (v === undefined ? fallback : !!v);

function sanitizeSlot(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const catId = s.catId === 'all' ? 'all' : intOrNull(s.catId);
  const pos = Number.isInteger(s.pos) && s.pos >= 1 ? s.pos : null;
  if (catId === null || pos === null) {
    return { ...emptySlot(), label: str(s.label, 40), icon: str(s.icon, 8) };
  }
  return {
    catId,
    pos,
    index: intOrNull(s.index),
    title: str(s.title, 200),
    url: str(s.url, 1000),
    label: str(s.label, 40),
    icon: str(s.icon, 8),
  };
}

function sanitizeSource(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const catId = s.catId === 'all' ? 'all' : intOrNull(s.catId);
  return { catId, name: catId === null ? '' : str(s.name, 200) };
}

/** Проверка хоткея; fallback — что вернуть для негодной комбинации. */
function sanitizeHotkey(raw, fallback) {
  if (!raw || typeof raw !== 'object') return fallback;
  const hk = raw;
  const mods = { ctrl: !!hk.ctrl, alt: !!hk.alt, shift: !!hk.shift, meta: !!hk.meta };
  if (!hk.modsOnly) {
    // keycode: null тут допустим только у основного хоткея старых конфигов (main подставит Space)
    return { ...mods, keycode: intOrNull(hk.keycode), name: str(hk.name, 32) || 'Space', modsOnly: false };
  }
  // без основной клавиши нужно минимум два модификатора
  if (Object.values(mods).filter(Boolean).length >= 2) return { ...mods, keycode: null, name: '', modsOnly: true };
  return fallback;
}

function sanitize(raw) {
  const d = defaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  const lines = r.lines && typeof r.lines === 'object' ? r.lines : {};

  let render = flag(lines.render, d.lines.render);
  let capture = flag(lines.capture, d.lines.capture);
  if (!render && !capture) {
    render = true;
    capture = true;
  }

  const slotsIn = Array.isArray(r.slots) ? r.slots : [];

  // негодная комбинация у основного хоткея: возвращаем значение по умолчанию
  const hotkey = sanitizeHotkey(r.hotkey, d.hotkey);
  // колесо категорий: поля нет (конфиг старше) — по умолчанию; null — пользователь убрал бинд;
  // без основной клавиши и без modsOnly бинда нет вовсе
  let catHotkey = r.catHotkey === undefined ? d.catHotkey : sanitizeHotkey(r.catHotkey, null);
  if (catHotkey && !catHotkey.modsOnly && catHotkey.keycode === null) catHotkey = null;

  return {
    version: CONFIG_VERSION,
    hotkey,
    catHotkey,
    mode: r.mode === 'toggle' ? 'toggle' : 'hold',
    stayOpen: flag(r.stayOpen, d.stayOpen),
    sectors: SECTOR_CHOICES.includes(r.sectors) ? r.sectors : d.sectors,
    deadzone: clamp(r.deadzone, 10, 120, d.deadzone),
    sensitivity: clamp(r.sensitivity, 0.2, 5, d.sensitivity),
    lines: { render, capture },
    grabFocus: flag(r.grabFocus, d.grabFocus),
    slots: Array.from({ length: MAX_SLOTS }, (_, i) => sanitizeSlot(slotsIn[i])),
    source: sanitizeSource(r.source),
    debug: !!r.debug,
    firstRunDone: !!r.firstRunDone,
  };
}

/** Поля каждого раздела окна настроек, которые сбрасывает его кнопка «Сбросить». */
const SECTIONS = {
  binds: ['hotkey', 'catHotkey'],
  control: ['mode', 'stayOpen', 'grabFocus'],
  look: ['sectors', 'deadzone', 'sensitivity'],
  lines: ['lines'],
  wheel: ['source', 'slots'],
  service: ['debug'],
};

/** Патч для ConfigStore.update, возвращающий раздел к значениям по умолчанию; null — нет такого раздела. */
function resetPatch(section) {
  const fields = SECTIONS[section];
  if (!fields) return null;
  const d = defaults();
  return Object.fromEntries(fields.map((f) => [f, d[f]]));
}

class ConfigStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.cfg = sanitize({});
  }

  load() {
    try {
      this.cfg = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.cfg = sanitize({});
    }
    return this.cfg;
  }

  get() {
    return this.cfg;
  }

  /** Частичное обновление: lines и hotkey сливаются, остальное (включая catHotkey, slots и source) заменяется целиком. */
  update(patch) {
    const cur = this.cfg;
    const p = patch && typeof patch === 'object' ? patch : {};
    this.cfg = sanitize({
      ...cur,
      ...p,
      lines: { ...cur.lines, ...(p.lines || {}) },
      hotkey: { ...cur.hotkey, ...(p.hotkey || {}) },
    });
    this._save();
    this.emit('change', this.cfg);
    return this.cfg;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.emit('save-error', e);
    }
  }
}

module.exports = { ConfigStore, sanitize, defaults, resetPatch, SECTIONS, emptySlot, SECTOR_CHOICES, MAX_SLOTS };
