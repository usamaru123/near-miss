import {
  DOUBLE_DURATION,
  HEART_BASE_BPM,
  HEART_OVERDRIVE_BONUS,
  HEART_SPEED_BPM,
  KMH_FACTOR,
  MULT_MAX,
  NITRO_DURATION,
  TIERS,
  WARP_DURATION,
} from '../game/constants';
import type { GameState } from '../game/types';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing #' + id);
  return e as T;
}

function retrigger(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

const FLOATERS = 8;
const POPUPS = 4;
const MAX_VISIBLE_POPUPS = 3;
const STREAKS = 72;

/** Radial speed streaks drawn around the screen edges. */
class StreakField {
  private readonly cv = el<HTMLCanvasElement>('streaks');
  private readonly g = this.cv.getContext('2d');
  private readonly ang = new Float32Array(STREAKS);
  private readonly prog = new Float32Array(STREAKS);
  private readonly spd = new Float32Array(STREAKS);
  private w = 0;
  private h = 0;

  constructor() {
    for (let i = 0; i < STREAKS; i++) {
      this.ang[i] = Math.random() * Math.PI * 2;
      this.prog[i] = Math.random();
      this.spd[i] = 0.6 + Math.random() * 0.8;
    }
  }

  private fit(): void {
    const w = Math.max(1, Math.floor(window.innerWidth / 2));
    const h = Math.max(1, Math.floor(window.innerHeight / 2));
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.cv.width = w;
      this.cv.height = h;
    }
  }

  draw(dt: number, speedFrac: number, overdrive: boolean, color: string): void {
    const g = this.g;
    if (!g) return;
    this.fit();
    g.clearRect(0, 0, this.w, this.h);
    const n = Math.floor(STREAKS * (0.25 + 0.75 * speedFrac) * (overdrive ? 1 : 0.9));
    const cx = this.w / 2;
    const cy = this.h / 2;
    const maxR = Math.hypot(cx, cy);
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      let p = this.prog[i] + dt * this.spd[i] * (0.8 + speedFrac * 2.4 + (overdrive ? 1.2 : 0));
      if (p > 1) {
        p -= 1;
        this.ang[i] = Math.random() * Math.PI * 2;
      }
      this.prog[i] = p;
      const r0 = (0.5 + 0.55 * p * p) * maxR;
      const len = (0.04 + speedFrac * 0.2) * maxR * (0.4 + p);
      const c = Math.cos(this.ang[i]);
      const s = Math.sin(this.ang[i]);
      g.globalAlpha = Math.min(1, p * 1.6) * (0.25 + 0.5 * speedFrac);
      g.beginPath();
      g.moveTo(cx + c * r0, cy + s * r0);
      g.lineTo(cx + c * (r0 + len), cy + s * (r0 + len));
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  clear(): void {
    this.fit();
    this.g?.clearRect(0, 0, this.w, this.h);
  }
}

/** DOM overlay HUD. Writes to the DOM only when a displayed value changes. */
export class Hud {
  private readonly root = el('hud');
  private readonly score = el('score');
  private readonly mult = el('mult');
  private readonly combo = el('combo');
  private readonly speed = el('speed-val');
  private readonly bpm = el('bpm-val');
  private readonly heart = el('heart');
  private readonly adrFill = el('adr-fill');
  private readonly adrBar = el('adr-bar');
  private readonly odLabel = el('od-label');
  private readonly focusFill = el('focus-fill');
  private readonly popupBox = el('popups');
  private readonly popups: HTMLElement[] = [];
  private readonly fxEls = new Map<string, HTMLElement>();
  private readonly fxLast = new Map<string, number>();
  private readonly floaterAt: number[] = [];
  private readonly floatersBox = el('floaters');
  private readonly vignette = el('vignette');
  private readonly flashEl = el('flash');
  private readonly tint = el('focus-tint');
  private readonly floaters: HTMLElement[] = [];
  private readonly streaks = new StreakField();
  private readonly countdownEl = el('countdown');
  private shownKmh = 0;
  private time = 0;
  private floaterIdx = 0;
  private last = { score: '', mult: '', combo: '', speed: '', bpm: '', adr: -1, focus: -1 };
  private bpmValue = HEART_BASE_BPM;
  flashScale = 1;

  constructor() {
    for (let i = 0; i < POPUPS; i++) {
      const d = document.createElement('div');
      d.className = 'popup off';
      d.addEventListener('animationend', () => d.classList.add('off'));
      this.popupBox.appendChild(d);
      this.popups.push(d);
    }
    for (const k of ['SHIELD', 'NITRO', 'DOUBLE', 'WARP']) {
      const e = document.querySelector<HTMLElement>('.fx[data-k=' + k + ']');
      if (e) {
        this.fxEls.set(k, e);
        this.fxLast.set(k, -2);
      }
    }
    for (let i = 0; i < FLOATERS; i++) {
      this.floaterAt.push(-1e9);
      const d = document.createElement('div');
      d.className = 'floater';
      this.floatersBox.appendChild(d);
      this.floaters.push(d);
    }
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  get heartBpm(): number {
    return this.bpmValue;
  }

  update(s: GameState, beat: number, speedFrac: number, focusAmt: number, dt: number, color: string): void {
    this.time += dt;
    const score = String(Math.floor(s.score));
    if (score !== this.last.score) {
      this.last.score = score;
      this.score.textContent = score;
    }
    const mult = '×' + s.multiplier;
    if (mult !== this.last.mult) {
      this.last.mult = mult;
      this.mult.textContent = mult;
      this.mult.classList.toggle('max', s.multiplier >= MULT_MAX);
      retrigger(this.mult, 'pop');
    }
    const combo = 'COMBO ' + s.combo;
    if (combo !== this.last.combo) {
      this.last.combo = combo;
      this.combo.textContent = combo;
      this.combo.classList.toggle('dim', s.combo === 0);
    }
    // rolling speedometer: displayed value chases the real one; shakes at high speed
    const target = s.speed * KMH_FACTOR;
    this.shownKmh += (target - this.shownKmh) * (1 - Math.exp(-dt * 9));
    const kmh = String(Math.round(this.shownKmh));
    if (kmh !== this.last.speed) {
      this.last.speed = kmh;
      this.speed.textContent = kmh;
    }
    const shake = Math.max(0, speedFrac - 0.35) * 5 * this.flashScale + (s.overdrive ? 1.5 * this.flashScale : 0);
    if (shake > 0.05) {
      this.speed.style.transform =
        'translate(' + ((Math.random() - 0.5) * shake).toFixed(1) + 'px,' + ((Math.random() - 0.5) * shake).toFixed(1) + 'px)';
    } else this.speed.style.transform = '';
    this.streaks.draw(dt, speedFrac, s.overdrive, color);
    this.bpmValue = HEART_BASE_BPM + s.speed * HEART_SPEED_BPM + (s.overdrive ? HEART_OVERDRIVE_BONUS : 0);
    const bpm = String(Math.round(this.bpmValue));
    if (bpm !== this.last.bpm) {
      this.last.bpm = bpm;
      this.bpm.textContent = bpm;
    }
    const adr = Math.round(s.adrenaline * 200) / 200;
    if (adr !== this.last.adr) {
      this.last.adr = adr;
      this.adrFill.style.width = (adr * 100).toFixed(1) + '%';
      const full = s.adrenaline >= 0.999 && !s.overdrive;
      this.adrBar.classList.toggle('full', full);
      this.odLabel.classList.toggle('show', full);
    }
    if (s.overdrive) {
      this.adrFill.style.width = ((s.overdriveT / 5) * 100).toFixed(1) + '%';
      this.last.adr = -1;
    }
    this.adrBar.classList.toggle('od', s.overdrive);
    const focus = Math.round(s.focus * 200) / 200;
    if (focus !== this.last.focus) {
      this.last.focus = focus;
      this.focusFill.style.width = (focus * 100).toFixed(1) + '%';
    }
    this.root.classList.toggle('od-on', s.overdrive);
    this.root.classList.toggle('focus-on', s.focusActive);
    // red pulsing vignette at speed, white-hot in overdrive
    const pulse = 0.55 + 0.45 * beat;
    const v = (speedFrac * speedFrac * 0.4 + (s.overdrive ? 0.35 : 0)) * pulse * (0.5 + 0.5 * this.flashScale);
    this.vignette.style.opacity = v.toFixed(3);
    this.tint.style.opacity = (focusAmt * 0.85).toFixed(3);
    this.setEffect('SHIELD', s.shield ? 100 : -1);
    this.setEffect('NITRO', s.nitroT > 0 ? (s.nitroT / NITRO_DURATION) * 100 : -1);
    this.setEffect('DOUBLE', s.doubleT > 0 ? (s.doubleT / DOUBLE_DURATION) * 100 : -1);
    this.setEffect('WARP', s.warpT > 0 ? (s.warpT / WARP_DURATION) * 100 : -1);
  }

  private setEffect(kind: string, pct: number): void {
    const e = this.fxEls.get(kind);
    if (!e) return;
    const q = pct < 0 ? -1 : Math.round(pct);
    if (this.fxLast.get(kind) === q) return;
    this.fxLast.set(kind, q);
    if (q < 0) e.classList.add('hidden');
    else {
      e.classList.remove('hidden');
      e.style.setProperty('--p', String(q));
    }
  }

  /**
   * Big text lives in the top band (12%..28% of the screen height) and stacks vertically.
   * Nothing is ever drawn in the central no-go circle (DESIGN 14).
   */
  popup(text: string, cls: string, color?: string): void {
    const active = this.popups.filter((p) => !p.classList.contains('off'));
    let el = this.popups.find((p) => p.classList.contains('off'));
    if (!el || active.length >= MAX_VISIBLE_POPUPS) el = active[0] ?? this.popups[0];
    el.textContent = text;
    el.className = 'popup ' + cls;
    if (color) el.style.setProperty('--c', color);
    else el.style.removeProperty('--c');
    this.popupBox.appendChild(el);
    void el.offsetWidth;
    el.classList.add('show');
  }

  clearPopups(): void {
    for (const p of this.popups) p.classList.add('off');
  }

  itemPopup(text: string, color: string): void {
    this.popup(text, 'item', color);
  }

  clearStreaks(): void {
    this.streaks.clear();
  }

  resetSpeed(v: number): void {
    this.shownKmh = v;
  }

  milestone(text: string): void {
    this.popup(text, 'milestone');
  }

  countdown(text: string | null, go = false): void {
    const c = this.countdownEl;
    if (text === null) {
      c.classList.add('hidden');
      return;
    }
    c.classList.remove('hidden');
    c.textContent = text;
    c.classList.remove('tick', 'go');
    void c.offsetWidth;
    c.classList.add(go ? 'go' : 'tick');
  }

  beat(): void {
    retrigger(this.heart, 'beat');
  }

  popScore(): void {
    retrigger(this.score, 'pop');
  }

  flash(color: string, strength: number): void {
    this.flashEl.style.background = color;
    this.flashEl.style.setProperty('--o', (strength * this.flashScale).toFixed(3));
    retrigger(this.flashEl, 'fade');
  }

  /** Floating score text: just below the ship, stacked downwards when several are alive. */
  floater(text: string, x: number, y: number, cls: string): void {
    const now = performance.now();
    let live = 0;
    for (let i = 0; i < FLOATERS; i++) if (now - this.floaterAt[i] < 900) live++;
    const idx = this.floaterIdx++ % FLOATERS;
    this.floaterAt[idx] = now;
    const d = this.floaters[idx];
    d.textContent = text;
    d.className = 'floater ' + cls;
    const w = window.innerWidth;
    const h = window.innerHeight;
    d.style.left = Math.max(70, Math.min(w - 70, x)).toFixed(0) + 'px';
    d.style.top = Math.min(h - 34, y + live * 28).toFixed(0) + 'px';
    void d.offsetWidth;
    d.classList.add('go');
  }

  tierBanner(tier: number): void {
    const t = TIERS[tier - 1];
    this.popup('TIER ' + tier + ' // ' + t.name, 'tier', t.rainbow ? '#ffffff' : '#' + t.primary.toString(16).padStart(6, '0'));
  }

  overdriveBanner(on: boolean): void {
    if (on) this.popup('OVERDRIVE', 'od');
  }
}
