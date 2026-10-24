(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const R_OUT = 262;
  const R_IN = 122;
  const GAP_DEG = 2.6;
  const CONTENT_R = 192;
  const POP = 9; // на сколько выбранный сектор «выезжает» наружу
  const HUB_R = 104;

  const root = document.getElementById('root');
  const layer = document.getElementById('segments');
  const hubTitle = document.getElementById('hubTitle');
  const hubSub = document.getElementById('hubSub');
  const hubPage = document.getElementById('hubPage');
  const dot = document.getElementById('dot');
  const hintsEl = document.getElementById('hints');
  const tipEl = document.getElementById('tip');
  const actionsEl = document.getElementById('actions');
  const fullnameEl = document.getElementById('fullname');

  let count = 8;
  let slots = [];
  let segs = [];
  let selected = null;
  let paged = false;
  // от main, см. overlayPayload
  let ctx = { holding: true, stayOpen: false, toggle: false, canBack: false, showTips: true, showHints: true };
  let prompt = 'Выбери звук'; // в центре, когда ничего не выбрано
  let hintsKey = '';

  const polar = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    return [r * Math.sin(a), -r * Math.cos(a)]; // 0° сверху, по часовой стрелке
  };
  const f = (v) => v.toFixed(2);

  function svgEl(name, attrs = {}) {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function sectorPath(i, n) {
    const half = 180 / n;
    const a0 = i * 2 * half - half + GAP_DEG / 2;
    const a1 = i * 2 * half + half - GAP_DEG / 2;
    const [ox0, oy0] = polar(R_OUT, a0);
    const [ox1, oy1] = polar(R_OUT, a1);
    const [ix1, iy1] = polar(R_IN, a1);
    const [ix0, iy0] = polar(R_IN, a0);
    return `M${f(ox0)} ${f(oy0)} A${R_OUT} ${R_OUT} 0 0 1 ${f(ox1)} ${f(oy1)} L${f(ix1)} ${f(iy1)} A${R_IN} ${R_IN} 0 0 0 ${f(ix0)} ${f(iy0)} Z`;
  }

  function wrapLabel(text, maxChars = 11, maxLines = 2) {
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let w of words) {
      if (w.length > maxChars) w = `${w.slice(0, maxChars - 1)}…`;
      if (!cur) cur = w;
      else if (`${cur} ${w}`.length <= maxChars) cur += ` ${w}`;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.endsWith('…') ? last : `${last.slice(0, maxChars - 1)}…`;
    }
    return lines;
  }

  function build(data) {
    count = data.sectors;
    slots = data.slots;
    ctx = { ...ctx, ...(data.ctx || {}) };
    prompt = data.title || 'Выбери звук';
    paged = !!data.page;
    hubPage.textContent = data.page ? `стр. ${data.page.n}/${data.page.total}` : '';
    selected = null;
    segs = [];
    layer.replaceChildren();

    for (let i = 0; i < count; i++) {
      const slot = slots[i] || { label: '', icon: '', empty: true };
      const kind = slot.stop ? ' stop' : slot.back ? ' back' : slot.folder ? ' folder' : slot.empty ? ' empty' : '';
      const g = svgEl('g', { class: `seg${kind}` });
      g.appendChild(svgEl('path', { d: sectorPath(i, count) }));

      const icon = slot.icon || (slot.empty ? '' : '🔊');
      const lines = slot.label ? wrapLabel(slot.label) : slot.empty ? ['—'] : [];
      const blockH = (icon ? 40 : 0) + lines.length * 22;
      const [cx, cy] = polar(CONTENT_R, (360 / count) * i);
      let y = cy - blockH / 2;

      if (icon) {
        const t = svgEl('text', { class: 'ico', x: f(cx), y: f(y + 32) });
        t.textContent = icon;
        g.appendChild(t);
        y += 40;
      }
      lines.forEach((line, k) => {
        const t = svgEl('text', { class: 'lbl', x: f(cx), y: f(y + 17 + k * 22) });
        t.textContent = line;
        g.appendChild(t);
      });

      const [ux, uy] = polar(1, (360 / count) * i);
      segs.push({ g, ux, uy });
      layer.appendChild(g);
    }
  }

  const squash = (s) => String(s).trim().replace(/\s+/g, ' ');

  /** Панель над колесом: полное название выбранного звука или путь категории. */
  function setFullName(slot) {
    const full = slot && !slot.empty && !slot.stop && !slot.back ? squash(slot.full || slot.label || '') : '';
    fullnameEl.textContent = full;
    fullnameEl.hidden = !full;
  }

  // Название в центре колеса: сначала уменьшаем шрифт, потом «начало / …конец»
  const HUB_SIZES = [27, 24, 21, 18]; // px; меньше 18 уже плохо читается поверх игры
  const HUB_MAX_W = 176; // ширина строки внутри круга (r = 104) в единицах viewBox
  const HUB_LINES = 2;
  // невидимый текст с тем же классом: меряем ширину с учётом шрифта и заглавных букв
  const measureEl = svgEl('text', { class: 'hub-title', x: '0', y: '-9999', visibility: 'hidden' });
  document.getElementById('wheel').appendChild(measureEl);

  function textWidth(text, size) {
    measureEl.style.fontSize = `${size}px`;
    measureEl.textContent = text;
    return measureEl.getComputedTextLength();
  }

  /** Перенос по словам в maxLines строк шириной HUB_MAX_W; null — не влезает. */
  function wrapToWidth(text, size) {
    const lines = [];
    for (const word of squash(text).split(' ')) {
      if (textWidth(word, size) > HUB_MAX_W) return null;
      const last = lines[lines.length - 1];
      if (last !== undefined && textWidth(`${last} ${word}`, size) <= HUB_MAX_W) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
      if (lines.length > HUB_LINES) return null;
    }
    return lines;
  }

  /** Самая длинная часть text (с начала или с конца), которая влезает в строку вместе с extra. */
  function fitPart(text, size, fromEnd, extra = '') {
    let n = text.length;
    const part = (k) => (fromEnd ? text.slice(text.length - k) : text.slice(0, k));
    while (n > 0 && textWidth(fromEnd ? extra + part(n).trimStart() : part(n).trimEnd() + extra, size) > HUB_MAX_W) n--;
    // режем по границе слова, если строка от этого укоротится не больше чем вдвое:
    // «Это очень», а не «Это очень длинно»
    const cutInWord = n < text.length && (fromEnd ? text[text.length - n - 1] !== ' ' : text[n] !== ' ');
    if (cutInWord) {
      const p = part(n);
      const space = fromEnd ? p.indexOf(' ') : p.lastIndexOf(' ');
      const kept = fromEnd ? p.length - space - 1 : space;
      if (space >= 0 && kept >= p.length / 2) n = kept;
    }
    return fromEnd ? part(n).trimStart() : part(n).trimEnd();
  }

  /** Строки и размер шрифта для названия в центре. */
  function fitHub(title) {
    const text = squash(title);
    for (const size of HUB_SIZES) {
      const lines = wrapToWidth(text, size);
      if (lines) return { size, lines };
    }
    // даже самым мелким шрифтом не влезает: первая строка — начало, вторая — «…» и конец
    const size = HUB_SIZES[HUB_SIZES.length - 1];
    const head = fitPart(text, size, false);
    const tail = fitPart(text.slice(head.length), size, true, '…');
    return { size, lines: [head, `…${tail}`] };
  }

  function setHub(title, sub) {
    const { size, lines } = fitHub(title);
    const lineH = Math.round(size * 1.05);
    const startY = -((lines.length - 1) * lineH) / 2 + size * 0.35 - 4; // блок строк по центру круга
    hubTitle.style.fontSize = `${size}px`;
    hubTitle.replaceChildren();
    lines.forEach((line, k) => {
      const ts = svgEl('tspan', { x: '0', y: (startY + k * lineH).toFixed(1) });
      ts.textContent = line;
      hubTitle.appendChild(ts);
    });
    hubSub.textContent = sub;
  }

  function applySelected(idx) {
    selected = idx;
    segs.forEach((s, i) => {
      const on = i === idx;
      s.g.classList.toggle('sel', on);
      s.g.style.transform = on ? `translate(${(s.ux * POP).toFixed(1)}px, ${(s.uy * POP).toFixed(1)}px)` : 'translate(0px, 0px)';
    });
    const slot = idx == null ? null : slots[idx];
    if (!slot) setHub(prompt, '');
    else if (slot.stop) setHub('Стоп', 'Остановить звук');
    else if (slot.empty) setHub('Пусто', '');
    else setHub(slot.label || 'Без названия', slot.sub || '');
    setFullName(slot);
    renderHints(slot);
  }

  // действия в строке подсказок в этом порядке: главное — первым, «Закрыть» — последним
  const ACTIONS = [
    'Сыграть',
    'Остановить звук',
    'Открыть категорию',
    'К категориям',
    'Прослушать в наушниках',
    'Выбрать сектор',
    'Листать страницы',
    'Закрыть',
  ];

  /** Совет обычным текстом, первой строкой: что бинд можно отпустить и почему. */
  function tipText() {
    // одной строкой: иначе на экранах пониже панель уходит за край
    if (ctx.holding && ctx.stayOpen) {
      return 'Совет: бинд можно отпустить — колесо не закроется, пока не выберешь звук (включено «Не закрывать колесо»).';
    }
    if (ctx.toggle) {
      return 'Совет: клавиши можно отпустить — в режиме «Нажать бинд» колесо закроется кликом, биндом или Esc.';
    }
    return '';
  }

  /**
   * Что сейчас сделают отпускание бинда, клики, прокрутка: пары [клавиша, действие].
   * Повторяет обработку в main: mousedown (ЛКМ/ПКМ, центр), navigate, stayOpen, toggle.
   */
  function hintItems(slot) {
    const kind = !slot ? 'center' : slot.stop ? 'stop' : slot.back ? 'back' : slot.folder ? 'folder' : slot.empty ? 'empty' : 'sound';
    const items = [];
    if (ctx.holding) {
      // отпускание мимо звука при stayOpen ничего не делает: об этом говорит совет, а не строка действий
      const release = { sound: 'Сыграть', stop: 'Остановить звук' }[kind] || (ctx.stayOpen ? null : 'Закрыть');
      if (release) items.push(['Отпусти бинд', release]);
    }
    const lmb = {
      center: 'Закрыть',
      empty: 'Закрыть',
      sound: 'Сыграть',
      stop: 'Остановить звук',
      folder: 'Открыть категорию',
      back: 'К категориям',
    }[kind];
    items.push(['ЛКМ', lmb]);
    if (kind === 'sound') items.push(['Держи ПКМ', 'Прослушать в наушниках']);
    if (kind === 'center') {
      items.push(['ПКМ', ctx.canBack ? 'К категориям' : 'Закрыть']);
      items.push(['Мышь', 'Выбрать сектор'], ['← →', 'Выбрать сектор']);
    }
    if (paged) items.push(['Прокрутка', 'Листать страницы']);
    if (!ctx.holding) items.push(['Бинд', 'Закрыть']);
    items.push(['Esc', 'Закрыть']);
    return items;
  }

  /** Группирует по действию: «Сыграть: [Отпусти бинд] [ЛКМ]», без повторов одного действия. */
  function hintGroups(slot) {
    const groups = new Map();
    for (const [key, action] of hintItems(slot)) {
      if (!groups.has(action)) groups.set(action, []);
      groups.get(action).push(key);
    }
    return [...groups].sort(([a], [b]) => ACTIONS.indexOf(a) - ACTIONS.indexOf(b));
  }

  function renderHints(slot) {
    const tip = ctx.showTips ? tipText() : '';
    const groups = ctx.showHints ? hintGroups(slot) : [];
    const key = JSON.stringify([tip, groups]);
    if (key === hintsKey) return; // при движении мыши внутри сектора не перерисовываем
    hintsKey = key;
    tipEl.textContent = tip;
    tipEl.hidden = !tip;
    actionsEl.hidden = !groups.length;
    hintsEl.hidden = !tip && !groups.length;
    actionsEl.replaceChildren(
      ...groups.map(([action, keys]) => {
        const item = document.createElement('span');
        item.className = 'hint';
        const label = document.createElement('span');
        label.className = 'act';
        label.textContent = action;
        item.append(label);
        for (const k of keys) {
          const badge = document.createElement('span');
          badge.className = 'key';
          badge.textContent = k;
          item.append(badge);
        }
        return item;
      })
    );
  }

  function moveDot(state) {
    const k = (HUB_R - 18) / (state.maxRadius || 160);
    dot.setAttribute('cx', (state.vx * k).toFixed(1));
    dot.setAttribute('cy', (state.vy * k).toFixed(1));
  }

  function show(data) {
    build(data);
    applySelected(data.selected ?? null);
    dot.setAttribute('cx', '0');
    dot.setAttribute('cy', '0');
    root.classList.add('open');
  }

  /** Новая страница: секторы перерисовываются, выбор и точка остаются на месте. flip: false — без анимации. */
  function flip(data) {
    build(data);
    applySelected(data.selected ?? null);
    if (data.flip === false) return;
    layer.classList.remove('flip');
    void layer.getBBox(); // перезапуск CSS-анимации
    layer.classList.add('flip');
  }

  if (window.hud) {
    // Захват указателя: Chromium держит курсор в центре окна, а мы получаем только смещения.
    // Курсор не упирается в край экрана, а после выхода из захвата встаёт туда, где был при открытии.
    // main вызывает lockPointer через executeJavaScript с флагом жеста пользователя.
    window.lockPointer = async () => {
      try {
        await document.body.requestPointerLock({ unadjustedMovement: true }); // сырые смещения, без ускорения
      } catch {
        try {
          await document.body.requestPointerLock();
        } catch {
          /* не вышло: main продолжит брать движения из uiohook */
        }
      }
    };
    document.addEventListener('pointerlockchange', () => window.hud.pointerLock(document.pointerLockElement != null));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) window.hud.move(e.movementX, e.movementY);
    });

    window.hud.onShow(show);
    window.hud.onPage(flip);
    window.hud.onState((s) => {
      if (s.selected !== selected) applySelected(s.selected);
      moveDot(s);
    });
    window.hud.onHide(() => {
      // отпускаем курсор сразу, до того как окно спрячется и фокус вернётся игре
      if (document.pointerLockElement) document.exitPointerLock();
      root.classList.remove('open');
    });
  } else {
    // Режим предпросмотра: overlay.html можно открыть в обычном браузере, повозить мышью и покрутить колесо.
    const preview = {
      sectors: 8,
      ctx: { holding: true, stayOpen: true, toggle: false, canBack: false, showTips: true, showHints: true },
      page: { n: 1, total: 3 },
      slots: [
        { label: 'Bruh', icon: '😐' },
        { label: 'Vine boom', icon: '💥' },
        { label: 'Artist - Название трека', icon: '📢' },
        { label: 'Это очень длинное название звука, которое не помещается в центре колеса', icon: '🎺' },
        { label: 'Стоп', icon: '⏹', stop: true },
        { label: '', icon: '', empty: true },
        { label: 'Oof', icon: '😵' },
        { label: 'Сыграй ещё раз', icon: '🔁' },
      ],
    };
    show(preview);
    document.addEventListener('wheel', (e) => {
      const { n, total } = preview.page;
      const next = ((n - 1 + Math.sign(e.deltaY) + total) % total) + 1;
      preview.page = { n: next, total };
      // имитация другой страницы: звуки сдвигаются, «Стоп» (индекс 4) остаётся снизу
      const sounds = preview.slots.filter((s) => !s.stop);
      preview.slots = sounds.slice(1).concat(sounds[0]);
      preview.slots.splice(4, 0, { label: 'Стоп', icon: '⏹', stop: true });
      flip({ ...preview, selected });
    });
    document.addEventListener('mousemove', (e) => {
      const r = document.getElementById('wheel').getBoundingClientRect(); // колесо выше центра: под ним подсказки
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(x, y) < 40) return applySelected(null);
      let a = Math.atan2(x, -y);
      if (a < 0) a += Math.PI * 2;
      const w = (Math.PI * 2) / count;
      return applySelected(Math.floor(((a + w / 2) % (Math.PI * 2)) / w) % count);
    });
  }
})();
