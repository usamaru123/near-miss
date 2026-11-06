import { formatFull, formatScore, scoreSize, scoreTone } from '../game/format';
import { createBreakdown, multBreakdown, rankProgress } from '../game/style';
import type { Breakdown } from '../game/style';
import { FX_COLOR, HudFx } from './hudfx';
import type { Box } from './hudfx';
import {
  BREAKDOWN_MIN,
  DOUBLE_DURATION,
  HEART_BASE_BPM,
  HEART_OVERDRIVE_BONUS,
  HEART_SPEED_BPM,
  KMH_FACTOR,
  MULT_MAX,
  NITRO_DURATION,
  RANK_NAMES,
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
const POPUPS = 6;
const MAX_VISIBLE_POPUPS = 3;
const STREAKS = 144;
const CHIPS = 6;

/** Radial speed streaks drawn around the screen edges. */
class StreakField {
  private readonly cv = el<HTMLCanvasElement>('streaks');
  private readonly g = this.cv.getContext('2d');
  /** adaptive quality: fraction of the streaks that are drawn */
  scale = 1;
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

  /** `boost` doubles the streaks at S rank and above (DESIGN 18.3). */
  draw(dt: number, speedFrac: number, overdrive: boolean, color: string, boost = 1): void {
    const g = this.g;
    if (!g) return;
    this.fit();
    g.clearRect(0, 0, this.w, this.h);
    const n = Math.min(STREAKS, Math.floor(72 * (0.25 + 0.75 * speedFrac) * (overdrive ? 1 : 0.9) * this.scale * boost));
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
  private readonly odBtn = el('od-btn');
  private readonly focusFill = el('focus-fill');
  private readonly popupBox = el('popups');
  private readonly popups: HTMLElement[] = [];
  private readonly shownAt = new WeakMap<HTMLElement, number>();
  /** top edge (px) of the pop-up column and the room above the no-go circle: how many pop-ups fit */
  private popupTop = 0;
  private fitDirty = false;
  private pendingFit = 0;
  private readonly fxEls = new Map<string, HTMLElement>();
  private readonly fxLast = new Map<string, number>();
  private readonly floaterAt: number[] = [];
  private readonly floatersBox = el('floaters');
  private readonly vignette = el('vignette');
  private readonly flashEl = el('flash');
  private readonly tint = el('focus-tint');
  private readonly clutchTint = el('clutch-tint');
  private readonly paceEl = el('pace');
  private lastPace = '';
  private readonly floaters: HTMLElement[] = [];
  private readonly streaks = new StreakField();
  private readonly countdownEl = el('countdown');
  // ---- style rank + ZONE (DESIGN 18.3) ----
  readonly fx = new HudFx();
  private readonly leftCol = el('hud-left');
  private readonly rankBox = el('rank-box');
  private readonly rankLetter = el('rank-letter');
  private readonly rankFill = el('rank-fill');
  private readonly rankCaption = el('rank-caption');
  private readonly rankEdge = el('rank-edge');
  private readonly sssEdge = el('sss-edge');
  private readonly breakGlass = el('break-glass');
  private readonly chainEl = el('chain');
  private readonly zoneHud = el('zone-hud');
  private readonly zoneLvN = el('zone-lvn');
  private readonly zoneTime = el('zone-time');
  private readonly zoneBank = el('zone-bank');
  private readonly chips: HTMLElement[] = [];
  private readonly chipVals = new Array<number>(CHIPS).fill(0);
  private readonly bd: Breakdown = createBreakdown();
  private chipCount = 0;
  private chipTotal = '';
  private shownRank = 0;
  private lastRankBar = -1;
  private shownScore = 0;
  private shownBank = 0;
  private bankMag = 0;
  private settleT = 0;
  private edgeLast = -1;
  private ambientLast = -1;
  private clearEl: HTMLElement | null = null;
  private clearTarget = 0;
  private clearT = 0;
  private clearLabel = '';
  private zoneActive = false;
  private lastZoneSec = -1;
  private lastZoneLv = 0;
  private shownKmh = 0;
  private time = 0;
  private floaterIdx = 0;
  private last = { score: '', mult: '', combo: '', speed: '', bpm: '', adr: -1, focus: -1, bank: '' };
  private bpmValue = HEART_BASE_BPM;
  private flashScale_ = 1;
  get flashScale(): number {
    return this.flashScale_;
  }
  /** reduced-flash mode (0.3) calms the pulsing HUD effects */
  set flashScale(v: number) {
    this.flashScale_ = v;
    this.root.classList.toggle('calm', v < 1);
  }
  /** touch layout active: floaters stay clear of the bottom gauges and buttons */
  private touch_ = false;
  get touch(): boolean {
    return this.touch_;
  }
  set touch(v: boolean) {
    this.touch_ = v;
    this.fitPopups();
  }

  /**
   * Portrait phones: the left column (score, multiplier chain, rank, ZONE BANK) is tall and the pop-ups are centred, so the
   * pop-up column starts under it. Measured only when the column's make-up changes (chain / ZONE shown or hidden, resize).
   */
  fitPopups(): void {
    const portrait = window.innerHeight > window.innerWidth;
    if (this.touch_ && portrait && !this.root.classList.contains('hidden')) {
      const b = this.leftCol.getBoundingClientRect().bottom;
      this.popupBox.style.top = Math.max(Math.round(window.innerHeight * 0.12), Math.round(b + 8)) + 'px';
    } else this.popupBox.style.top = '';
    this.popupTop = this.popupBox.getBoundingClientRect().top;
  }

  constructor() {
    for (let i = 0; i < POPUPS; i++) {
      const d = document.createElement('div');
      d.className = 'popup off';
      d.addEventListener('animationend', (ev) => {
        // pseudo-element animations (the ZONE glitch layers) and events of a just-recycled pop-up must not hide it
        if (ev.target !== d || ev.pseudoElement) return;
        if (performance.now() - (this.shownAt.get(d) ?? 0) < 500) return;
        d.classList.add('off');
      });
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
    for (let i = 0; i < CHIPS + 1; i++) {
      const c = document.createElement('span');
      c.className = i === CHIPS ? 'chip total' : 'chip';
      this.chainEl.appendChild(c);
      this.chips.push(c);
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
    if (v) this.fitPopups();
  }

  /** Adaptive quality: thin out the speed streaks. */
  setParticleScale(s: number): void {
    this.streaks.scale = s;
    this.fx.scale = s;
  }

  get heartBpm(): number {
    return this.bpmValue;
  }

  update(s: GameState, beat: number, speedFrac: number, focusAmt: number, dt: number, color: string): void {
    this.time += dt;
    // the displayed score rolls up towards the real one (faster for small steps, slower while a ZONE pays out)
    if (s.score < this.shownScore) this.shownScore = s.score;
    else if (s.score > this.shownScore) {
      this.shownScore += (s.score - this.shownScore) * (1 - Math.exp(-dt * (this.settleT > 0 ? 2.6 : 18)));
      if (s.score - this.shownScore < Math.max(0.5, s.score * 1e-7)) this.shownScore = s.score;
    }
    if (this.settleT > 0) this.settleT = Math.max(0, this.settleT - dt);
    const score = formatScore(this.shownScore);
    if (score !== this.last.score) {
      this.last.score = score;
      this.score.textContent = score;
    }
    this.updateStyle(s, beat, dt);
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
    this.streaks.draw(dt, speedFrac, s.overdrive, color, s.style.rank >= 4 ? 2 : 1);
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
      this.odBtn.classList.toggle('ready', full);
    }
    if (s.overdrive) {
      this.adrFill.style.width = ((s.overdriveT / 5) * 100).toFixed(1) + '%';
      this.last.adr = -1;
    }
    this.adrBar.classList.toggle('od', s.overdrive);
    this.odBtn.classList.toggle('active', s.overdrive);
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
    this.clutchTint.classList.toggle('on', s.clutch.active);
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
    // the room between the pop-up column and the no-go circle decides how many fit (3 on a tall desktop, 1-2 on a phone)
    const room = window.innerHeight / 2 - 0.2 * Math.min(window.innerWidth, window.innerHeight) - this.popupTop;
    const cap = Math.max(1, Math.min(MAX_VISIBLE_POPUPS, Math.floor(room / 36)));
    if (!el || active.length >= cap) {
      // evict the oldest pop-up; the ZONE pay-out / BREAK / LOST lines are never pushed out by something else
      const keep = (p: HTMLElement): boolean => p.classList.contains('zoneclear') || p.classList.contains('zonebreak');
      const victim = active.find((p) => !keep(p));
      if (!victim && cls === 'scorebanner') return; // the 10^n banner gives way (the score itself still swells)
      el = victim ?? active[0] ?? this.popups[0];
    }
    // a recycled CLEAR pop-up stops counting up (it now shows something else)
    if (el === this.clearEl) this.clearEl = null;
    el.textContent = text;
    el.dataset.text = text;
    el.className = 'popup ' + cls;
    if (color) el.style.setProperty('--c', color);
    else el.style.removeProperty('--c');
    this.popupBox.appendChild(el);
    void el.offsetWidth;
    this.shownAt.set(el, performance.now());
    el.classList.add('show');
  }

  /** PB pace line under the score: green when ahead of the best, red when behind. null hides it. */
  setPace(diff: number | null): void {
    if (diff === null) {
      if (this.lastPace !== '') {
        this.lastPace = '';
        this.paceEl.classList.add('hidden');
      }
      return;
    }
    const d = Math.round(diff);
    const text = 'PB ' + (d >= 0 ? '+' : '−') + formatScore(Math.abs(d));
    if (text === this.lastPace) return;
    this.lastPace = text;
    this.paceEl.textContent = text;
    this.paceEl.classList.remove('hidden');
    this.paceEl.classList.toggle('up', d >= 0);
    this.paceEl.classList.toggle('down', d < 0);
  }

  clearPopups(): void {
    for (const p of this.popups) p.classList.add('off');
    this.setPace(null);
    this.clutchTint.classList.remove('on');
    this.resetStyle();
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
  floater(text: string, x: number, y: number, cls: string, points = 0): void {
    const now = performance.now();
    let live = 0;
    for (let i = 0; i < FLOATERS; i++) if (now - this.floaterAt[i] < 900) live++;
    const idx = this.floaterIdx++ % FLOATERS;
    this.floaterAt[idx] = now;
    const d = this.floaters[idx];
    d.textContent = text;
    // size follows log10(points); colour follows the size of the pay-out (DESIGN 18.5)
    d.className = points > 0 ? 'floater ' + cls + ' t-' + scoreTone(points) : 'floater ' + cls;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (points > 0) {
      // never wider than the screen: about 0.72 em per character at the base font size
      const basePx = Math.max(cls === 'insane' ? 20 : 15, Math.min(cls === 'insane' ? 36 : 26, w * (cls === 'insane' ? 0.036 : 0.026)));
      const fit = (w * 0.9) / (Math.max(8, text.length) * 0.72 * basePx);
      d.style.setProperty('--sz', Math.min(scoreSize(points), Math.max(0.7, fit)).toFixed(2));
    } else d.style.removeProperty('--sz');
    d.style.left = Math.max(70, Math.min(w - 70, x)).toFixed(0) + 'px';
    d.style.top = Math.min(this.touch ? h - 92 : h - 34, y + live * 28).toFixed(0) + 'px';
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

  // ================================================================== style rank + ZONE

  private rectOf(e: HTMLElement): Box {
    const b = e.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom };
  }

  private setRankClass(rank: number): void {
    this.rankBox.className = 'rk-' + rank;
    this.rankLetter.textContent = RANK_NAMES[rank];
    this.rankCaption.textContent = rank >= 6 ? 'MAX' : 'STYLE';
    this.shownRank = rank;
    this.rankEdge.style.setProperty('--rc', 'var(--rk' + rank + ')');
    this.bpm.classList.toggle('tremble', rank >= 6 && this.flashScale >= 1);
  }

  /** Per-frame: rank letter, progress bar, edge glows, multiplier chain, ZONE panel. */
  private updateStyle(s: GameState, beat: number, dt: number): void {
    const st = s.style;
    if (st.rank !== this.shownRank) this.setRankClass(st.rank); // silent sync (the event handlers animate)
    const prog = Math.round(rankProgress(st) * 200) / 200;
    if (prog !== this.lastRankBar) {
      this.lastRankBar = prog;
      this.rankFill.style.width = (prog * 100).toFixed(1) + '%';
      this.rankBox.classList.toggle('close', prog > 0.85 && st.rank < 6);
    }
    this.rankBox.classList.toggle('grace', st.downT > 0);

    // ambient edge light from A up; rainbow pulse on the beat at SSS / inside a ZONE
    const amb = st.rank >= 3 ? 0.1 + (st.rank - 3) * 0.05 : 0;
    const ambQ = Math.round(amb * 50) / 50;
    if (ambQ !== this.ambientLast) {
      this.ambientLast = ambQ;
      this.rankEdge.style.setProperty('--amb', ambQ.toFixed(2));
    }
    const rainbow = (st.rank >= 6 ? 0.4 : 0) + (s.zone.active ? 0.35 : 0);
    const edge = Math.round(rainbow * (0.3 + 0.7 * beat) * (0.3 + 0.7 * this.flashScale) * 50) / 50;
    if (edge !== this.edgeLast) {
      this.edgeLast = edge;
      this.sssEdge.style.opacity = edge.toFixed(2);
    }

    this.updateChain(s);
    if (this.fitDirty) {
      // the left column changed shape (chain / ZONE panel): re-measure after this frame's text is in
      this.fitDirty = false;
      this.pendingFit = 2;
    }

    // ZONE panel
    const z = s.zone;
    if (z.active !== this.zoneActive) {
      this.zoneActive = z.active;
      this.zoneHud.classList.toggle('hidden', !z.active);
      this.root.classList.toggle('in-zone', z.active);
      this.fitDirty = true;
      if (z.active) {
        this.shownBank = 0;
        this.lastZoneSec = -1;
        this.bankMag = 0;
      }
    }
    if (z.active) {
      this.shownBank += (z.bank - this.shownBank) * (1 - Math.exp(-dt * 16));
      if (z.bank - this.shownBank < Math.max(0.5, z.bank * 1e-6)) this.shownBank = z.bank;
      const bank = formatScore(this.shownBank);
      if (bank !== this.last.bank) {
        this.last.bank = bank;
        this.zoneBank.textContent = bank;
        const mag = this.shownBank >= 10 ? Math.floor(Math.log10(this.shownBank)) : 0;
        if (mag > this.bankMag) retrigger(this.zoneBank, 'bump');
        this.bankMag = mag;
      }
      if (z.lv !== this.lastZoneLv) {
        this.lastZoneLv = z.lv;
        this.zoneLvN.textContent = 'ZONE Lv.' + z.lv;
        this.zoneHud.dataset.lv = String(Math.min(8, z.lv));
      }
      const sec = Math.floor(z.t);
      if (sec !== this.lastZoneSec) {
        this.lastZoneSec = sec;
        this.zoneTime.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
      }
    }

    // CLEAR count-up
    if (this.clearEl) {
      this.clearT += dt;
      const u = Math.min(1, this.clearT / 1.5);
      const e = 1 - Math.pow(1 - u, 3);
      this.clearEl.textContent = this.clearLabel + formatScore(this.clearTarget * e);
      if (u >= 1) {
        this.clearEl = null;
        retrigger(this.score, 'swell');
      }
    }
    if (this.pendingFit > 0 && --this.pendingFit === 0) this.fitPopups();
    this.fx.update(dt);
    if (this.fx.arrived > 0) {
      if (this.fx.arrived >= 4) retrigger(this.score, 'jolt');
      this.fx.arrived = 0;
    }
  }

  /** Multiplier chain "x8 x3 x5 x2 = x240" next to the score once the total passes x10, each factor popping in. */
  private updateChain(s: GameState): void {
    const bd = multBreakdown(s, this.bd);
    const show = bd.total >= BREAKDOWN_MIN;
    if (!show) {
      if (this.chipCount !== 0) {
        this.chipCount = 0;
        this.chainEl.classList.add('hidden');
        this.chipTotal = '';
        this.chipVals.fill(0);
        this.fitDirty = true;
      }
      return;
    }
    if (this.chipCount === 0) this.chainEl.classList.remove('hidden');
    for (let i = 0; i < CHIPS; i++) {
      const v = i < bd.count ? bd.factors[i] : 0;
      if (v !== this.chipVals[i]) {
        const chip = this.chips[i];
        this.chipVals[i] = v;
        if (v === 0) chip.classList.add('hidden');
        else {
          chip.classList.remove('hidden');
          chip.textContent = '×' + (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
          retrigger(chip, 'in');
        }
      }
    }
    if (bd.count !== this.chipCount) this.fitDirty = true;
    this.chipCount = bd.count;
    const tot = '= ×' + formatScore(Math.round(bd.total));
    if (tot !== this.chipTotal) {
      this.chipTotal = tot;
      const c = this.chips[CHIPS];
      c.textContent = tot;
      retrigger(c, 'in');
      c.classList.toggle('big', bd.total >= 100);
      this.fitDirty = true;
    }
  }

  /** Back to a clean slate (new run / title). */
  resetStyle(): void {
    this.fx.clear();
    this.clearEl = null;
    this.shownScore = 0;
    this.shownBank = 0;
    this.settleT = 0;
    this.zoneActive = false;
    this.zoneHud.classList.add('hidden');
    this.root.classList.remove('in-zone');
    this.chainEl.classList.add('hidden');
    this.chipCount = 0;
    this.chipVals.fill(0);
    this.chipTotal = '';
    this.setRankClass(0);
    this.lastRankBar = -1;
    this.edgeLast = -1;
    this.sssEdge.style.opacity = '0';
    this.breakGlass.classList.remove('go');
    this.last.score = '';
    this.lastZoneLv = 0;
  }

  /** Rank-up: the old letter shatters into glass, the new one slams in from 2.5x with chromatic aberration. */
  rankUp(rank: number, from: number): void {
    const old = this.rectOf(this.rankLetter);
    this.fx.shards(old, from, 10 + from * 3);
    this.setRankClass(rank);
    this.lastRankBar = -1;
    retrigger(this.rankLetter, 'slam');
    retrigger(this.rankBox, 'hit');
    this.rankEdge.style.setProperty('--rc', 'var(--rk' + rank + ')');
    retrigger(this.rankEdge, 'burst');
    this.fx.spark(this.rectOf(this.rankLetter), rank >= 6 ? FX_COLOR.rainbow : rank, 8 + rank * 4);
  }

  /** Rank-down: the letter cracks and drops. */
  rankDown(rank: number, from: number): void {
    this.fx.shards(this.rectOf(this.rankLetter), from, 6);
    this.setRankClass(rank);
    this.lastRankBar = -1;
    retrigger(this.rankLetter, 'crack');
  }

  zoneEnter(): void {
    this.popup('ZONE', 'zone');
    if (this.flashScale >= 1) this.flash('#ffffff', 0.85);
    retrigger(this.root, 'zone-hit');
    this.fx.spark(this.rectOf(this.rankLetter), FX_COLOR.rainbow, 30);
  }

  zoneLevel(lv: number): void {
    retrigger(this.zoneHud, 'lvup');
    this.fx.spark(this.rectOf(this.zoneBank), FX_COLOR.gold, 14 + lv * 2);
    this.popup('ZONE Lv.' + lv + '  ×' + (lv + 1), 'zonelv');
  }

  /** CLEAR: the whole BANK is paid; "ZONE CLEAR +123,456" counts up while light grains fly to the score. */
  zoneClear(bank: number): void {
    const from = this.rectOf(this.zoneBank);
    const to = this.rectOf(this.score);
    this.fx.fly(from, to, 70 + Math.min(80, Math.round(Math.log10(Math.max(10, bank)) * 6)), FX_COLOR.rainbow);
    this.fx.fly(from, to, 30, FX_COLOR.gold);
    this.popup('ZONE CLEAR +0', 'zoneclear');
    const popups = this.popups;
    this.clearEl = popups.find((p) => p.classList.contains('zoneclear') && !p.classList.contains('off')) ?? null;
    this.clearTarget = bank;
    this.clearT = 0;
    this.clearLabel = 'ZONE CLEAR +';
    this.settleT = 1.6;
  }

  /** BREAK: glass cracks over the edges of the screen, red banner, half the BANK is paid. */
  zoneBreak(paid: number): void {
    this.popup('ZONE BREAK  +' + formatScore(paid), 'zonebreak');
    retrigger(this.breakGlass, 'go');
    retrigger(this.root, 'shake');
    this.fx.spark(this.rectOf(this.zoneBank), 3, 24);
    this.fx.shards(this.rectOf(this.zoneBank), 5, 14);
    this.settleT = 1.0;
    if (this.flashScale >= 1) this.flash('#ff2030', 0.35);
  }

  /** Died inside a ZONE: the BANK is gone. */
  zoneLost(bank: number): void {
    this.popup('ZONE LOST  −' + formatScore(bank), 'zonebreak');
    this.fx.shards(this.rectOf(this.zoneBank), 5, 20);
    retrigger(this.root, 'shake');
  }

  /** Score passed 10^n: banner in the top band and the score swells. */
  scoreBanner(exp: number): void {
    // 1,000,000!! ... up to 10^11 in full digits, units beyond (a 30-digit banner would not fit)
    this.popup((exp <= 11 ? formatFull(Math.pow(10, exp)) : formatScore(Math.pow(10, exp))) + '!!', 'scorebanner');
    retrigger(this.score, 'swell');
    this.fx.spark(this.rectOf(this.score), FX_COLOR.rainbow, 18);
  }
}
