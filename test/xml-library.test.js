'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXml, findAll, decodeEntities } = require('../src/main/xml');
const {
  parseCategories,
  parseSoundlist,
  relinkSlots,
  fillSlotsFromCategory,
  resolveSource,
  pageCount,
  wrapPage,
  pageSlots,
  withStop,
} = require('../src/main/library');
const { SAMPLE_CATEGORIES, SAMPLE_SOUNDLIST } = require('./helpers');

test('xml: теги, атрибуты, сущности, вложенность', () => {
  const doc = parseXml('<?xml version="1.0"?><A x="1 &amp; 2"><B y=\'q\'/><C><D/></C></A>');
  const a = doc.children[0];
  assert.equal(a.name, 'A');
  assert.equal(a.attrs.x, '1 & 2');
  assert.deepEqual(
    a.children.map((c) => c.name),
    ['B', 'C']
  );
  assert.equal(findAll(doc, 'D').length, 1);
  assert.equal(decodeEntities('&#1055;&#x41;'), 'ПA');
});

test('xml: значение атрибута может содержать > и кириллицу', () => {
  const doc = parseXml('<S url="C:\\a>b\\звук.mp3" title="Тест"/>');
  assert.equal(doc.children[0].attrs.url, 'C:\\a>b\\звук.mp3');
});

test('library: категории с вложенностью и позициями', () => {
  const cats = parseCategories(SAMPLE_CATEGORIES);
  assert.deepEqual(
    cats.map((c) => [c.id, c.path, c.sounds.length]),
    [
      [1, 'Мемы & шутки', 2],
      [3, 'Мемы & шутки / Вложенная', 1],
      [2, 'Игры', 2],
    ]
  );
  assert.deepEqual(cats[0].sounds.map((s) => [s.pos, s.index, s.title]), [
    [1, 1, 'Bruh'],
    [2, 2, 'Vine boom'],
  ]);
  assert.equal(cats[1].sounds[0].title, 'Кто-то - Тест'); // artist - title
  assert.equal(cats[2].sounds[1].title, 'airhorn'); // нет title: имя файла без расширения
});

test('library: список всех звуков, позиция равна глобальному индексу', () => {
  const all = parseSoundlist(SAMPLE_SOUNDLIST);
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((s) => s.pos), [1, 2, 3, 4, 5]);
  assert.equal(all[2].url, 'C:\\sounds\\oof.wav');
});

test('library: relink находит звук, переехавший в другую позицию или категорию', () => {
  const cats = parseCategories(SAMPLE_CATEGORIES);
  const library = { categories: cats };
  const slots = [
    { catId: 1, pos: 2, index: 2, title: 'Vine boom', url: 'C:\\sounds\\vine boom.mp3', label: 'x', icon: '' }, // на месте
    { catId: 1, pos: 1, index: 1, title: 'Oof', url: 'C:\\SOUNDS\\OOF.wav', label: 'y', icon: '' }, // переехал в категорию 2
    { catId: null, pos: null, index: null, title: '', url: '', label: '', icon: '' },
    { catId: 2, pos: 1, index: 3, title: 'Нет такого', url: 'C:\\gone.mp3', label: 'z', icon: '' }, // пропал
  ];
  const { slots: out, changed } = relinkSlots(slots, library);
  assert.equal(changed, true);
  assert.deepEqual([out[0].catId, out[0].pos], [1, 2]);
  assert.deepEqual([out[1].catId, out[1].pos, out[1].index], [2, 1, 3]);
  assert.deepEqual([out[3].catId, out[3].pos], [2, 1]); // не нашли — не трогаем
});

test('library: fillSlotsFromCategory заполняет и очищает лишнее', () => {
  const cats = parseCategories(SAMPLE_CATEGORIES);
  const base = Array.from({ length: 12 }, () => ({ catId: 9, pos: 9, index: 9, title: 'старый', url: 'u', label: 'l', icon: '🎺' }));
  const out = fillSlotsFromCategory(cats[2], 4, base); // «Игры»: 2 звука, секторов 4
  assert.equal(out[0].title, 'Oof');
  assert.equal(out[0].icon, '🎺');
  assert.equal(out[1].title, 'airhorn');
  assert.equal(out[2].catId, null); // звуков не хватило — сектор пуст
  assert.equal(out[5].title, 'старый'); // за пределами count не трогаем
});

test('library: страницы категории, переход по кругу', () => {
  const all = { id: 'all', name: 'Все звуки', sounds: parseSoundlist(SAMPLE_SOUNDLIST) };
  assert.equal(pageCount(all, 4), 2);
  assert.equal(pageCount(all, 8), 1);
  assert.equal(pageCount({ sounds: [] }, 8), 1); // пустая категория: одна пустая страница
  assert.deepEqual([wrapPage(2, 2), wrapPage(-1, 2), wrapPage(-1, 1)], [0, 1, 0]);

  const p1 = pageSlots(all, 4, 1);
  assert.equal(p1.length, 4);
  assert.deepEqual([p1[0].catId, p1[0].pos, p1[0].index, p1[0].title], ['all', 5, 5, 'Кто-то - Тест']);
  assert.equal(p1[1].catId, null); // после последнего звука пусто
});

test('library: источник ищется по id, а при переименовании по имени', () => {
  const library = { categories: parseCategories(SAMPLE_CATEGORIES) };
  assert.equal(resolveSource({ catId: 2, name: 'Игры' }, library).name, 'Игры');
  assert.equal(resolveSource({ catId: 1, name: 'Игры' }, library).id, 2); // категории переставили
  assert.equal(resolveSource({ catId: 2, name: 'Пропала' }, library).id, 2); // имени нет: остаётся id
  assert.equal(resolveSource({ catId: 77, name: 'Пропала' }, library), null);
  assert.equal(resolveSource({ catId: null, name: '' }, library), null);
  assert.equal(resolveSource({ catId: 2, name: 'Игры' }, null), null);
});

test('library: «Стоп» всегда в нижнем секторе, звуки вокруг него', () => {
  const s = (t) => ({ catId: 1, pos: 1, index: 1, title: t, url: '', label: t, icon: '' });
  const w8 = withStop([s('a'), s('b'), s('c'), s('d'), s('e'), s('f'), s('g'), s('лишний')], 8);
  assert.equal(w8.length, 8);
  assert.deepEqual(w8.map((x) => (x.stop ? 'STOP' : x.label)), ['a', 'b', 'c', 'd', 'STOP', 'e', 'f', 'g']);

  const w4 = withStop([s('a')], 4); // звуков меньше, чем мест: дополняем пустыми
  assert.deepEqual(w4.map((x) => (x.stop ? 'STOP' : x.catId)), [1, null, 'STOP', null]);
});
