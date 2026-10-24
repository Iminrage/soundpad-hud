'use strict';

// Библиотека звуков: категории из GetCategories(true,false) плюс псевдо-категория «Все звуки»
// из GetSoundlist(). Формат XML описан в README (раздел «Допущения»), парсер толерантный.

const { parseXml, findAll } = require('./xml');
const { emptySlot } = require('./config');

const ALL_ID = 'all';

const norm = (u) => String(u || '').toLowerCase();

function baseName(p) {
  return String(p || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '');
}

function soundTitle(a) {
  if (a.artist && a.title) return `${a.artist} - ${a.title}`;
  return a.title || baseName(a.url) || '(без названия)';
}

function toSound(node, pos) {
  const a = node.attrs;
  const index = Number.parseInt(a.index, 10);
  return {
    pos,
    index: Number.isFinite(index) ? index : null,
    title: soundTitle(a),
    url: a.url || '',
    duration: a.duration || '',
  };
}

/** Разбирает ответ GetCategories / GetCategory в плоский список категорий. */
function parseCategories(xml) {
  const doc = parseXml(xml);
  const out = [];
  const walk = (node, trail) => {
    for (const child of node.children) {
      if (child.name !== 'Category') {
        walk(child, trail);
        continue;
      }
      // type="1": служебная скрытая «Все звуки» самого Soundpad, у нас её заменяет ALL_ID
      if (child.attrs.type === '1') continue;
      const index = Number.parseInt(child.attrs.index, 10);
      const name = child.attrs.name || `Категория ${child.attrs.index ?? ''}`.trim();
      const pathNames = [...trail, name];
      const sounds = child.children.filter((c) => c.name === 'Sound').map((n, i) => toSound(n, i + 1));
      if (Number.isFinite(index)) {
        out.push({ id: index, index, name, path: pathNames.join(' / '), sounds });
      }
      walk(child, pathNames);
    }
  };
  walk(doc, []);
  return out;
}

/** Разбирает ответ GetSoundlist: позиция в «Всех звуках» совпадает с глобальным индексом. */
function parseSoundlist(xml) {
  const nodes = findAll(parseXml(xml), 'Sound');
  return nodes.map((n, i) => {
    const s = toSound(n, i + 1);
    const idx = s.index ?? i + 1;
    return { ...s, index: idx, pos: idx };
  });
}

async function loadLibrary(client) {
  let categories = [];
  let catError = null;
  try {
    categories = parseCategories(await client.getCategories());
    if (categories.length && categories.every((c) => c.sounds.length === 0)) {
      // запасной путь: звуки не пришли вместе с деревом категорий
      for (const c of categories) {
        const one = parseCategories(await client.getCategory(c.index)).find((x) => x.index === c.index);
        if (one) c.sounds = one.sounds;
      }
    }
  } catch (e) {
    catError = e;
  }

  let all = [];
  try {
    all = parseSoundlist(await client.getSoundlist());
  } catch (e) {
    if (catError) throw catError;
  }
  if (!categories.length && !all.length && catError) throw catError;

  const cats = categories.slice();
  if (all.length) {
    cats.unshift({ id: ALL_ID, index: null, name: 'Все звуки', path: 'Все звуки', sounds: all });
  }
  return { categories: cats, loadedAt: Date.now() };
}

/**
 * Проверяет, что сектора всё ещё указывают на те же файлы. Если звук переехал
 * (поменялся индекс или категория), ищет его по пути файла и обновляет ссылку.
 */
function relinkSlots(slots, library) {
  const cats = library.categories;
  const allCat = cats.find((c) => c.id === ALL_ID);
  const byId = new Map(cats.map((c) => [String(c.id), c]));
  let changed = false;

  const out = slots.map((slot) => {
    if (slot.catId == null || !slot.url) return slot;
    const url = norm(slot.url);
    const cat = byId.get(String(slot.catId));

    const here = cat && cat.sounds.find((s) => s.pos === slot.pos);
    if (here && norm(here.url) === url) {
      if (here.index !== slot.index) {
        changed = true;
        return { ...slot, index: here.index };
      }
      return slot;
    }

    const order = [cat, ...cats.filter((c) => c !== cat && c !== allCat), allCat].filter(Boolean);
    for (const c of order) {
      const s = c.sounds.find((x) => norm(x.url) === url);
      if (s) {
        changed = true;
        return { ...slot, catId: c.id, pos: s.pos, index: s.index };
      }
    }
    return slot; // не нашли: оставляем, пользователь увидит в настройках
  });

  return { slots: out, changed };
}

function slotFromSound(cat, sound, prev = {}) {
  return {
    catId: cat.id,
    pos: sound.pos,
    index: sound.index,
    title: sound.title,
    url: sound.url,
    label: sound.title.slice(0, 40),
    icon: prev.icon || '',
  };
}

/** Заполняет первые count секторов первыми звуками категории, лишние сектора очищает. */
function fillSlotsFromCategory(cat, count, slots) {
  return slots.map((slot, i) => {
    if (i >= count) return slot;
    const s = cat.sounds[i];
    return s ? slotFromSound(cat, s, slot) : { ...emptySlot(), icon: slot.icon };
  });
}

/**
 * Категория, которую колесо листает по страницам. Ищем по id, но если под этим id
 * теперь другое имя (категории переставили в Soundpad), ищем по имени.
 */
function resolveSource(source, library) {
  if (!source || source.catId == null || !library) return null;
  const cats = library.categories;
  const byId = cats.find((c) => String(c.id) === String(source.catId));
  if (byId && (!source.name || byId.name === source.name)) return byId;
  return cats.find((c) => c.name === source.name) || byId || null;
}

const pageCount = (cat, size) => Math.max(1, Math.ceil(cat.sounds.length / size));
const listPageCount = (n, size) => Math.max(1, Math.ceil(n / size));

/** Страница page (с 0) по кругу: в обе стороны переходит через край. */
const wrapPage = (page, pages) => ((page % pages) + pages) % pages;

/** Секторы страницы page: ровно size штук, после последнего звука пустые. */
function pageSlots(cat, size, page) {
  return Array.from({ length: size }, (_, i) => {
    const s = cat.sounds[page * size + i];
    return s ? slotFromSound(cat, s) : emptySlot();
  });
}

/** Сколько звуков помещается на колесо: один сектор всегда занят «Стопом». */
const soundsPerWheel = (sectors) => sectors - 1;

/** Нижний сектор (0 сверху, по часовой). sectors всегда чётное, так что он ровно снизу. */
const stopSector = (sectors) => sectors / 2;

const stopSlot = () => ({ ...emptySlot(), stop: true, label: 'Стоп', icon: '⏹' });

/** Нижний сектор в колесе категорий, пока ничего не играет: возврат в меню категорий. */
const backSlot = () => ({ ...emptySlot(), back: true, label: 'Назад', icon: '↩' });

/** Раскладывает звуки по секторам колеса, пропуская нижний: он под «Стоп» (или bottom). */
function withStop(soundSlots, sectors, bottom = stopSlot()) {
  const out = soundSlots.slice(0, soundsPerWheel(sectors));
  while (out.length < soundsPerWheel(sectors)) out.push(emptySlot());
  out.splice(stopSector(sectors), 0, bottom);
  return out;
}

/** Категории для меню колеса категорий: только непустые, «Все звуки» первой. */
const menuCategories = (library) => (library ? library.categories.filter((c) => c.sounds.length) : []);

/** Секторы меню категорий на странице page: папка на каждую категорию, после последней пусто. */
function menuSlots(cats, size, page) {
  return Array.from({ length: size }, (_, i) => {
    const c = cats[page * size + i];
    if (!c) return emptySlot();
    const catId = c.menuId ?? c.id;
    return { ...emptySlot(), folder: true, catId, title: c.path, label: c.name.slice(0, 40), icon: c.icon || '📁', count: c.sounds.length };
  });
}

const TOP_ID = 'top';

/**
 * Псевдо-категория «Частые»: звуки из «Всех звуков» в порядке ranked (из PlayStats), до limit штук.
 * id у неё ALL_ID, чтобы звуки игрались по глобальному индексу, а в меню она открывается как TOP_ID.
 * null — нет «Всех звуков» или ни один сыгранный звук не найден в библиотеке.
 */
function topCategory(ranked, library, limit = 50) {
  const all = library && library.categories.find((c) => c.id === ALL_ID);
  if (!all) return null;
  const byUrl = new Map(all.sounds.map((s) => [norm(s.url), s]));
  const sounds = ranked
    .map((r) => byUrl.get(norm(r.url)))
    .filter(Boolean)
    .slice(0, limit);
  if (!sounds.length) return null;
  return { id: ALL_ID, menuId: TOP_ID, name: 'Частые', path: 'Частые', icon: '⭐', sounds };
}

module.exports = {
  ALL_ID,
  soundsPerWheel,
  stopSector,
  withStop,
  backSlot,
  menuCategories,
  menuSlots,
  topCategory,
  TOP_ID,
  resolveSource,
  pageCount,
  listPageCount,
  wrapPage,
  pageSlots,
  parseCategories,
  parseSoundlist,
  loadLibrary,
  relinkSlots,
  fillSlotsFromCategory,
  slotFromSound,
};
