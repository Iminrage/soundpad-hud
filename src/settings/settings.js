(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);

  let cfg = null;
  let categories = [];
  let libError = null;
  let saveTimer = null;
  let recording = null; // какой хоткей записываем: 'main', 'cats' или null
  let toastTimer = null;

  // ------------------------------------------------------------ утилиты

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  }

  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = bad ? 'show bad' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 2800);
  }

  const findCat = (id) => categories.find((c) => String(c.id) === String(id));
  const soundCount = () => cfg.sectors - 1; // один сектор колеса всегда «Стоп»

  function hotkeyText(hk) {
    const parts = [];
    if (hk.ctrl) parts.push('Ctrl');
    if (hk.alt) parts.push('Alt');
    if (hk.shift) parts.push('Shift');
    if (hk.meta) parts.push('Win');
    if (!hk.modsOnly) parts.push(hk.name || `#${hk.keycode}`);
    return parts.join(' + ');
  }

  // ------------------------------------------------------------ сохранение

  async function patch(p) {
    cfg = await api.setConfig(p);
    return cfg;
  }

  function queueSaveSlots() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSlots, 250);
  }

  async function flushSlots() {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    cfg = await api.setConfig({ slots: cfg.slots });
  }

  // ------------------------------------------------------------ секторы

  function assignSound(i, cat, sound) {
    const slot = cfg.slots[i];
    const autoLabel = !slot.label || slot.label === slot.title.slice(0, 40);
    cfg.slots[i] = {
      ...slot,
      catId: cat.id,
      pos: sound.pos,
      index: sound.index,
      title: sound.title,
      url: sound.url,
      label: autoLabel ? sound.title.slice(0, 40) : slot.label,
    };
  }

  function clearSlot(i) {
    cfg.slots[i] = { catId: null, pos: null, index: null, title: '', url: '', label: '', icon: cfg.slots[i].icon };
  }

  function slotRow(i) {
    const slot = cfg.slots[i];
    const cat = slot.catId != null ? findCat(slot.catId) : null;
    const orphan = slot.catId != null && !cat; // библиотека недоступна или категория пропала

    const icon = h('input', { type: 'text', class: 'icon', maxlength: '4', placeholder: '🔊', title: 'Иконка (эмодзи или символ)' });
    icon.value = slot.icon;
    icon.addEventListener('input', () => {
      cfg.slots[i].icon = icon.value;
      queueSaveSlots();
    });

    const label = h('input', { type: 'text', maxlength: '40', placeholder: 'Название на колесе' });
    label.value = slot.label;
    label.addEventListener('input', () => {
      cfg.slots[i].label = label.value;
      queueSaveSlots();
    });

    const catSel = h(
      'select',
      { title: 'Категория' },
      h('option', { value: '', text: '— не выбрано —' }),
      categories.map((c) => h('option', { value: String(c.id), text: `${c.path} (${c.sounds.length})` }))
    );
    catSel.value = cat ? String(cat.id) : '';

    const sndSel = h('select', { title: 'Звук' });
    if (cat) {
      cat.sounds.forEach((s) => sndSel.append(h('option', { value: String(s.pos), text: `${s.pos}. ${s.title}` })));
      sndSel.value = String(slot.pos);
      if (sndSel.value !== String(slot.pos)) {
        sndSel.prepend(h('option', { value: String(slot.pos), text: `${slot.title || 'звук'} (не найден в библиотеке)` }));
        sndSel.value = String(slot.pos);
      }
    } else if (orphan) {
      sndSel.append(h('option', { value: '', text: `${slot.title || 'звук'} (библиотека недоступна)` }));
      sndSel.disabled = true;
      catSel.disabled = true;
    } else {
      sndSel.disabled = true;
    }

    catSel.addEventListener('change', () => {
      const c = findCat(catSel.value);
      if (!c || !c.sounds.length) clearSlot(i);
      else assignSound(i, c, c.sounds[0]);
      renderSlots();
      queueSaveSlots();
    });

    sndSel.addEventListener('change', () => {
      const c = findCat(catSel.value);
      const s = c && c.sounds.find((x) => String(x.pos) === sndSel.value);
      if (!s) return;
      assignSound(i, c, s);
      label.value = cfg.slots[i].label;
      queueSaveSlots();
    });

    const play = h('button', {
      title: 'Проиграть',
      text: '▶',
      onclick: async () => {
        await flushSlots();
        const r = await api.testSlot(i);
        toast(r.ok ? 'Отправлено в Soundpad' : `Не получилось: ${r.error}`, !r.ok);
      },
    });
    const clear = h('button', {
      class: 'ghost',
      title: 'Очистить сектор',
      text: '✕',
      onclick: () => {
        clearSlot(i);
        renderSlots();
        queueSaveSlots();
      },
    });

    return h('div', { class: 'slot' }, h('span', { class: 'num', text: String(i + 1) }), icon, label, catSel, sndSel, play, clear);
  }

  function renderSlots() {
    const box = $('slots');
    box.replaceChildren();
    for (let i = 0; i < soundCount(); i++) box.append(slotRow(i));
  }

  function renderFillCats() {
    const sel = $('fillCat');
    sel.replaceChildren(...categories.map((c) => h('option', { value: String(c.id), text: `${c.path} (${c.sounds.length})` })));
    $('fillBtn').disabled = !categories.length;
  }

  function renderSource() {
    const sel = $('source');
    const src = cfg.source;
    const cat = src.catId != null ? findCat(src.catId) : null;
    sel.replaceChildren(
      h('option', { value: '', text: 'Свои звуки (настраиваются ниже)' }),
      ...categories.map((c) => h('option', { value: String(c.id), text: `Вся категория: ${c.path} (${c.sounds.length})` }))
    );
    if (src.catId != null && !cat) {
      sel.append(h('option', { value: String(src.catId), text: `Вся категория: ${src.name || src.catId} (нет в библиотеке)` }));
    }
    sel.value = src.catId == null ? '' : String(src.catId);
    $('manual').hidden = src.catId != null;

    let hint = 'Свои звуки: одна страница, выбери звук для каждого сектора ниже.';
    if (cat) {
      const pages = Math.max(1, Math.ceil(cat.sounds.length / soundCount()));
      hint =
        `Звуков ${cat.sounds.length}, страниц ${pages} по ${soundCount()}. ` +
        'Прокрутка мыши при открытом колесе листает страницы (вниз — следующая).';
    } else if (src.catId != null) {
      hint = 'Категория сейчас недоступна: колесо будет пустым, пока Soundpad не отдаст библиотеку.';
    }
    $('sourceHint').textContent = hint;
  }

  function renderLibStatus() {
    const total = categories.filter((c) => c.id !== 'all').reduce((n, c) => n + c.sounds.length, 0);
    $('libStatus').textContent = categories.length
      ? `Библиотека: категорий ${categories.length}, звуков в категориях ${total}.`
      : libError
        ? `Библиотека недоступна: ${libError}`
        : 'Библиотека ещё не загружена. Запусти Soundpad.';
  }

  async function loadLib(force) {
    const r = await api.getLibrary(force);
    categories = r.library ? r.library.categories : [];
    libError = r.error;
    renderFillCats();
    renderSource();
    renderLibStatus();
    renderSlots();
  }

  // ------------------------------------------------------------ хоткей

  function renderHotkey() {
    const recMain = recording === 'main';
    const recCats = recording === 'cats';
    $('hotkeyLabel').textContent = recMain ? 'Нажми комбинацию…' : hotkeyText(cfg.hotkey);
    $('hotkeyLabel').classList.toggle('rec', recMain);
    $('recordBtn').textContent = recMain ? 'Отмена (Esc)' : 'Изменить';
    $('recordBtn').disabled = recCats;
    $('catHotkeyLabel').textContent = recCats ? 'Нажми комбинацию…' : cfg.catHotkey ? hotkeyText(cfg.catHotkey) : 'не задан';
    $('catHotkeyLabel').classList.toggle('rec', recCats);
    $('catRecordBtn').textContent = recCats ? 'Отмена (Esc)' : 'Изменить';
    $('catRecordBtn').disabled = recMain;
    $('catClearBtn').disabled = !cfg.catHotkey || !!recording;
    const bare = !cfg.hotkey.ctrl && !cfg.hotkey.alt && !cfg.hotkey.shift && !cfg.hotkey.meta;
    $('hotkeyHint').classList.toggle('warn', bare);
  }

  async function toggleRecording(target) {
    if (recording) {
      await api.cancelRecord();
      recording = null;
    } else {
      recording = target;
      await api.recordHotkey(target);
    }
    renderHotkey();
  }

  async function renderStats() {
    const s = await api.statsSummary();
    $('statsInfo').textContent = s.sounds ? `звуков ${s.sounds}, проигрываний ${s.plays}` : 'пока ничего не сыграно';
    $('statsClear').disabled = !s.sounds;
  }

  // ------------------------------------------------------------ статус

  async function pollStatus() {
    try {
      const s = await api.getStatus();
      const badge = $('status');
      badge.className = s.online ? 'badge on' : 'badge off';
      badge.textContent = s.online ? `Soundpad ${s.version} · RC ${s.rcVersion}` : 'Soundpad: нет связи';
      badge.title = s.online ? '' : s.error || '';
    } catch {
      /* окно закрывается */
    }
    setTimeout(pollStatus, 3000);
  }

  // ------------------------------------------------------------ привязка контролов

  /** Значения контролов из cfg: при старте и после сброса раздела. */
  function fillControls() {
    $('mode').value = cfg.mode;
    $('sectors').value = String(cfg.sectors);
    $('deadzone').value = String(cfg.deadzone);
    $('sensitivity').value = String(cfg.sensitivity);
    $('lineRender').checked = cfg.lines.render;
    $('lineCapture').checked = cfg.lines.capture;
    $('debug').checked = cfg.debug;
    $('grabFocus').checked = cfg.grabFocus;
    $('showTips').checked = cfg.showTips;
    $('showHints').checked = cfg.showHints;
    $('deadzoneOut').textContent = cfg.deadzone;
    $('sensitivityOut').textContent = Number(cfg.sensitivity).toFixed(1);
    $('stayOpen').checked = cfg.stayOpen;
    $('stayOpen').disabled = cfg.mode !== 'hold'; // в toggle колесо и так не закрывается отпусканием
    renderHotkey();
  }

  function bindControls() {
    fillControls();

    document.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const section = btn.dataset.reset;
        if (section === 'wheel' && !confirm('Сбросить колесо звуков? Все выбранные вручную звуки сотрутся.')) return;
        if (section === 'binds') recording = null; // main отменяет запись бинда сам
        clearTimeout(saveTimer); // несохранённые правки секторов больше не нужны
        saveTimer = null;
        cfg = await api.resetSection(section);
        fillControls();
        renderSource();
        renderSlots();
        toast('Раздел сброшен к настройкам по умолчанию');
      });
    });

    $('mode').addEventListener('change', async () => {
      await patch({ mode: $('mode').value });
      $('stayOpen').disabled = cfg.mode !== 'hold';
    });
    $('stayOpen').addEventListener('change', () => patch({ stayOpen: $('stayOpen').checked }));
    $('sectors').addEventListener('change', async () => {
      await flushSlots();
      await patch({ sectors: Number($('sectors').value) });
      renderSource(); // число страниц зависит от числа секторов
      renderSlots();
    });
    $('source').addEventListener('change', async () => {
      const c = findCat($('source').value);
      await patch({ source: c ? { catId: c.id, name: c.name } : { catId: null, name: '' } });
      renderSource();
    });
    $('deadzone').addEventListener('input', () => {
      $('deadzoneOut').textContent = $('deadzone').value;
      patch({ deadzone: Number($('deadzone').value) });
    });
    $('sensitivity').addEventListener('input', () => {
      $('sensitivityOut').textContent = Number($('sensitivity').value).toFixed(1);
      patch({ sensitivity: Number($('sensitivity').value) });
    });

    const saveLines = async () => {
      const next = await patch({ lines: { render: $('lineRender').checked, capture: $('lineCapture').checked } });
      $('lineRender').checked = next.lines.render; // хотя бы одна линия всегда включена
      $('lineCapture').checked = next.lines.capture;
    };
    $('lineRender').addEventListener('change', saveLines);
    $('lineCapture').addEventListener('change', saveLines);
    $('debug').addEventListener('change', () => patch({ debug: $('debug').checked }));
    $('grabFocus').addEventListener('change', () => patch({ grabFocus: $('grabFocus').checked }));
    $('showTips').addEventListener('change', () => patch({ showTips: $('showTips').checked }));
    $('showHints').addEventListener('change', () => patch({ showHints: $('showHints').checked }));
    $('openData').addEventListener('click', () => api.openDataFolder());
    $('statsClear').addEventListener('click', async () => {
      if (!confirm('Очистить счёт частых звуков? Папка «Частые» опустеет.')) return;
      await api.clearStats();
      await renderStats();
      toast('Счёт частых звуков очищен');
    });

    $('recordBtn').addEventListener('click', () => toggleRecording('main'));
    $('catRecordBtn').addEventListener('click', () => toggleRecording('cats'));
    $('catClearBtn').addEventListener('click', async () => {
      await patch({ catHotkey: null });
      renderHotkey();
    });

    $('refreshBtn').addEventListener('click', async () => {
      await loadLib(true);
      toast(categories.length ? 'Библиотека обновлена' : 'Soundpad не отвечает', !categories.length);
    });

    $('fillBtn').addEventListener('click', () => {
      const c = findCat($('fillCat').value);
      if (!c) return;
      for (let i = 0; i < soundCount(); i++) {
        if (c.sounds[i]) {
          cfg.slots[i] = { ...cfg.slots[i], label: '', title: '' }; // метка подставится из названия звука
          assignSound(i, c, c.sounds[i]);
        } else {
          clearSlot(i);
        }
      }
      renderSlots();
      queueSaveSlots();
      toast('Секторы заполнены');
    });
  }

  // ------------------------------------------------------------ события из main

  api.onHotkeyRecorded(({ target, hotkey }) => {
    recording = null;
    if (target === 'cats') cfg.catHotkey = hotkey;
    else cfg.hotkey = hotkey;
    renderHotkey();
    const same = cfg.catHotkey && hotkeyText(cfg.catHotkey) === hotkeyText(cfg.hotkey);
    if (same) toast('Бинды колёс совпадают: откроется только колесо звуков', true);
    else toast('Бинд сохранён');
  });
  api.onHotkeyRecordCancel(() => {
    recording = null;
    renderHotkey();
  });
  api.onLibraryChanged(() => loadLib(false));
  api.onConfigChanged((next) => {
    if (JSON.stringify(next.source) !== JSON.stringify(cfg.source)) {
      cfg.source = next.source; // main перепривязал категорию-источник
      renderSource();
    }
    // свои же сохранения не перерисовываем, чтобы не сбивать фокус; чужие (релинк звуков) применяем
    if (JSON.stringify(next.slots) !== JSON.stringify(cfg.slots) && saveTimer === null) {
      cfg = next;
      renderSlots();
    }
  });

  // ------------------------------------------------------------ старт

  (async () => {
    cfg = await api.getConfig();
    bindControls();
    await loadLib(false);
    renderStats();
    window.addEventListener('focus', renderStats); // окно прячется в трей, а счёт растёт, пока оно скрыто
    pollStatus();
  })();
})();
