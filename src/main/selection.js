'use strict';

// Выбор сектора по «виртуальному курсору». Курсор накапливает смещения мыши (дельты),
// а не абсолютные координаты, и ограничен кругом maxRadius. Сектор 0 стоит сверху,
// дальше по часовой стрелке.

const TAU = Math.PI * 2;

function sectorAt(x, y, count, deadzone) {
  if (Math.hypot(x, y) < deadzone) return null;
  let a = Math.atan2(x, -y); // 0 = вверх, по часовой
  if (a < 0) a += TAU;
  const w = TAU / count;
  return Math.floor(((a + w / 2) % TAU) / w) % count;
}

class WheelSelection {
  constructor() {
    this.sectors = 8;
    this.deadzone = 45;
    this.sensitivity = 1;
    this.maxRadius = 160;
    this.vx = 0;
    this.vy = 0;
  }

  configure({ sectors, deadzone, sensitivity } = {}) {
    if (sectors) this.sectors = sectors;
    if (deadzone !== undefined) this.deadzone = deadzone;
    if (sensitivity !== undefined) this.sensitivity = sensitivity;
    this.maxRadius = Math.max(160, this.deadzone + 60);
  }

  reset() {
    this.vx = 0;
    this.vy = 0;
  }

  move(dx, dy) {
    this.vx += dx * this.sensitivity;
    this.vy += dy * this.sensitivity;
    const len = Math.hypot(this.vx, this.vy);
    if (len > this.maxRadius) {
      const k = this.maxRadius / len;
      this.vx *= k;
      this.vy *= k;
    }
  }

  get selected() {
    return sectorAt(this.vx, this.vy, this.sectors, this.deadzone);
  }

  /** Клавиатурный выбор: dir = +1 по часовой, -1 против. */
  step(dir) {
    const cur = this.selected;
    const n = this.sectors;
    const next = cur === null ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
    const angle = (next * TAU) / n;
    const r = Math.min(this.maxRadius, Math.max(this.deadzone + 15, this.maxRadius * 0.75));
    this.vx = r * Math.sin(angle);
    this.vy = -r * Math.cos(angle);
  }

  snapshot() {
    return { vx: this.vx, vy: this.vy, maxRadius: this.maxRadius, selected: this.selected };
  }
}

module.exports = { WheelSelection, sectorAt };
