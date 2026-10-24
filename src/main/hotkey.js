'use strict';

// Состояние хоткеев колеса. Чистая логика без зависимостей от Electron и uiohook:
// на вход подаются события клавиш (keycode + флаги модификаторов), наружу идут события
// 'open' ({ id }), 'close' ({ confirm }), 'stuck' (бинд отпущен мимо звука при stayOpen),
// 'recorded' (combo, target), 'record-cancel'.
// Хоткеев два: id 'main' (cfg.hotkey, обычное колесо) и 'cats' (cfg.catHotkey, колесо категорий,
// null — не задан). Открытое колесо закрывается своим же хоткеем.
//
// Важно: хук только слушает клавиши и не может их подавлять, поэтому сама комбинация
// всё равно доходит до игры.

const { EventEmitter } = require('events');

const MOD_GROUPS = ['ctrl', 'alt', 'shift', 'meta'];

function modsMatch(e, hk) {
  return (
    !!e.ctrlKey === !!hk.ctrl &&
    !!e.altKey === !!hk.alt &&
    !!e.shiftKey === !!hk.shift &&
    !!e.metaKey === !!hk.meta
  );
}

function comboLabel(hk) {
  const parts = [];
  if (hk.ctrl) parts.push('Ctrl');
  if (hk.alt) parts.push('Alt');
  if (hk.shift) parts.push('Shift');
  if (hk.meta) parts.push('Win');
  if (!hk.modsOnly) parts.push(hk.name || `#${hk.keycode}`);
  return parts.join(' + ');
}

class HotkeyMachine extends EventEmitter {
  /**
   * @param keys { ctrl: number[], alt: number[], shift: number[], meta: number[], escape: number }
   * @param getConfig () => { hotkey, catHotkey, mode, stayOpen }
   * @param missed () => boolean — отпускание сейчас ничего бы не выбрало (для stayOpen)
   */
  constructor({ keys, getConfig, failsafeMs = 30000, missed = () => false }) {
    super();
    this.keys = keys;
    this.getConfig = getConfig;
    this.failsafeMs = failsafeMs;
    this.missed = missed;
    this.open = false;
    // hold + stayOpen: бинд отпустили без выбора, колесо осталось открытым и ведёт себя как в toggle
    this.stuck = false;
    this.active = null; // id хоткея, который открыл колесо последним
    this.latched = false; // главная клавиша зажата: защита от автоповтора
    this.recording = false;
    this.recordTarget = 'main';
    this._timer = null;
    this._modKeys = new Set(MOD_GROUPS.flatMap((g) => keys[g]));
    this._groupOf = new Map(MOD_GROUPS.flatMap((g) => keys[g].map((k) => [k, g])));
    this._held = new Set(); // зажатые клавиши-модификаторы
    this._peak = null; // больше всего модификаторов, зажатых одновременно во время записи
  }

  /** Следим за зажатыми модификаторами сами: для комбинаций вроде Ctrl+Shift без основной клавиши. */
  _track(e, down) {
    const g = this._groupOf.get(e.keycode);
    if (g) {
      if (down) this._held.add(e.keycode);
      else this._held.delete(e.keycode);
    }
    if (!down) return;
    // keyup мог потеряться (Alt+Tab, блокировка экрана): верим флагам события, кроме группы самой клавиши
    for (const k of [...this._held]) {
      const kg = this._groupOf.get(k);
      if (kg !== g && e[`${kg}Key`] === false) this._held.delete(k);
    }
  }

  _heldGroups() {
    return new Set([...this._held].map((k) => this._groupOf.get(k)));
  }

  /** Нажатие e завершает комбинацию хоткея. */
  _isCombo(e, hk) {
    if (!hk.modsOnly) return e.keycode === hk.keycode && modsMatch(e, hk);
    if (!this._groupOf.has(e.keycode)) return false;
    const held = this._heldGroups();
    return MOD_GROUPS.every((g) => !!hk[g] === held.has(g));
  }

  /** Заданные хоткеи: [id, hotkey]. Первым идёт обычное колесо, оно выигрывает при совпадении. */
  _bindings() {
    const cfg = this.getConfig();
    return [
      ['main', cfg.hotkey],
      ['cats', cfg.catHotkey],
    ].filter(([, hk]) => hk);
  }

  _hotkey(id) {
    const found = this._bindings().find(([bid]) => bid === id);
    return found ? found[1] : null;
  }

  onKeyDown(e) {
    this._track(e, true);
    if (this.recording) return this._recordKeyDown(e);
    const { mode } = this.getConfig();

    if (this.open) {
      if (e.keycode === this.keys.escape) return this.close(false);
      const hk = this._hotkey(this.active);
      const again = hk && (hk.modsOnly ? this._isCombo(e, hk) : e.keycode === hk.keycode);
      if ((mode === 'toggle' || this.stuck) && again && !this.latched) {
        this.latched = true;
        return this.close(false); // повторное нажатие комбинации отменяет выбор
      }
      return undefined;
    }

    if (this.latched) return undefined;
    const hit = this._bindings().find(([, hk]) => this._isCombo(e, hk));
    if (!hit) return undefined;
    this.latched = true;
    this.active = hit[0];
    this._open();
    return undefined;
  }

  onKeyUp(e) {
    this._track(e, false);
    if (this.recording) return this._recordKeyUp(e);
    const { mode, stayOpen } = this.getConfig();
    const hk = this._hotkey(this.active);
    if (!hk) return;
    if (hk.modsOnly ? this._isRequiredModifier(e.keycode, hk) : e.keycode === hk.keycode) this.latched = false;
    if (!this.open || mode !== 'hold' || this.stuck) return;
    if (e.keycode !== hk.keycode && !this._isRequiredModifier(e.keycode, hk)) return;
    if (stayOpen && this.missed()) {
      this.stuck = true; // отпустили мимо звука: не закрываем, ждём клик, повтор бинда или Esc
      this.emit('stuck');
      return;
    }
    this.close(true);
  }

  _isRequiredModifier(keycode, hk) {
    return MOD_GROUPS.some((g) => hk[g] && this.keys[g].includes(keycode));
  }

  _open() {
    this.open = true;
    this.stuck = false;
    this._timer = setTimeout(() => this.close(false), this.failsafeMs);
    if (this._timer.unref) this._timer.unref();
    this.emit('open', { id: this.active });
  }

  /** Закрывает колесо. confirm = true — применить текущий выбор. */
  close(confirm) {
    if (!this.open) return;
    this.open = false;
    this.stuck = false;
    clearTimeout(this._timer);
    this.emit('close', { confirm: !!confirm });
  }

  /** target: 'main' или 'cats' — какой хоткей записываем; уходит вторым аргументом 'recorded'. */
  startRecording(target = 'main') {
    this.recording = true;
    this.recordTarget = target;
    this._peak = null;
  }

  cancelRecording() {
    this.recording = false;
    this._peak = null;
  }

  _recordKeyDown(e) {
    if (this._modKeys.has(e.keycode)) {
      // ждём основную клавишу, но запоминаем модификаторы: вдруг это комбинация только из них
      const held = this._heldGroups();
      if (!this._peak || held.size > this._peak.size) this._peak = held;
      return;
    }
    this.recording = false;
    this._peak = null;
    if (e.keycode === this.keys.escape) {
      this.emit('record-cancel');
      return;
    }
    // чтобы только что записанная комбинация не открыла колесо сразу; снимется отпусканием её клавиши
    this.latched = true;
    this.active = this.recordTarget;
    this.emit(
      'recorded',
      {
        ctrl: !!e.ctrlKey,
        alt: !!e.altKey,
        shift: !!e.shiftKey,
        meta: !!e.metaKey,
        keycode: e.keycode,
        modsOnly: false,
      },
      this.recordTarget
    );
  }

  /**
   * Комбинация только из модификаторов (Ctrl+Shift): записываем, когда отпустили первый из них.
   * Нужно минимум два, иначе колесо открывалось бы от каждого Ctrl.
   */
  _recordKeyUp(e) {
    if (!this._modKeys.has(e.keycode)) return;
    const peak = this._peak;
    if (!peak || peak.size < 2) {
      if (this._held.size === 0) this._peak = null;
      return;
    }
    this.recording = false;
    this._peak = null;
    this.emit(
      'recorded',
      {
        ctrl: peak.has('ctrl'),
        alt: peak.has('alt'),
        shift: peak.has('shift'),
        meta: peak.has('meta'),
        keycode: null,
        modsOnly: true,
      },
      this.recordTarget
    );
  }
}

module.exports = { HotkeyMachine, comboLabel, modsMatch };
