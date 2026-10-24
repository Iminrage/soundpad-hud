'use strict';

// Сколько раз звук сыгран из колёс HUD: для псевдо-категории «Частые» в колесе категорий.
// Ключ — путь к файлу в нижнем регистре: индексы в Soundpad плывут, путь нет.
// Хранится отдельно от конфига (stats.json): это данные, а не настройка, сброс раздела их не трогает.

const fs = require('fs');
const path = require('path');

const norm = (u) => String(u || '').toLowerCase();

class PlayStats {
  constructor(file, { saveDelayMs = 1000, now = () => Date.now() } = {}) {
    this.file = file;
    this.saveDelayMs = saveDelayMs;
    this.now = now;
    this.sounds = {}; // url → { count, last }
    this._timer = null;
    this.onError = () => {};
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const sounds = raw && typeof raw.sounds === 'object' ? raw.sounds : {};
      this.sounds = {};
      for (const [url, s] of Object.entries(sounds)) {
        const count = Number.isInteger(s && s.count) && s.count > 0 ? s.count : 0;
        if (count) this.sounds[norm(url)] = { count, last: Number(s.last) || 0 };
      }
    } catch {
      this.sounds = {}; // нет файла или он битый: начинаем с нуля
    }
    return this;
  }

  record(url) {
    const key = norm(url);
    if (!key) return;
    const s = this.sounds[key] || { count: 0, last: 0 };
    this.sounds[key] = { count: s.count + 1, last: this.now() };
    this._scheduleSave();
  }

  /** Счётчики по убыванию: чаще сыгранные первыми, при равенстве — недавние. */
  ranked() {
    return Object.entries(this.sounds)
      .map(([url, s]) => ({ url, ...s }))
      .sort((a, b) => b.count - a.count || b.last - a.last);
  }

  clear() {
    this.sounds = {};
    this.flush();
  }

  _scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this.saveDelayMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** Записать сейчас (атомарно, как конфиг). */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sounds: this.sounds }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.onError(e);
    }
  }
}

module.exports = { PlayStats };
