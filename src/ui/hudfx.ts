import { hsl, RANK_COLORS } from '../render/palette';

/**
 * HUD-space particles on one 2D canvas (DESIGN 18.3): glass shards of the old rank letter, the light grains that fly
 * from the ZONE BANK to the score on CLEAR, and bursts. Everything is pooled in typed arrays; nothing is allocated
 * per frame and the canvas is only touched while something is alive.
 */
const MAX = 220;
const K_SHARD = 0;
const K_FLY = 1;
const K_SPARK = 2;

/**
 * Pre-built fill styles (the index is stored per particle): 0..6 the rank colours, 7 white, 8 gold,
 * then a 12-step rainbow starting at 9.
 */
const PALETTE: string[] = [];
const RAINBOW_N = 12;
(function build() {
  for (const c of RANK_COLORS) PALETTE.push('#' + c.toString(16).padStart(6, '0'));
  PALETTE.push('#ffffff', '#ffd45a');
  const rgb = [0, 0, 0];
  const h = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  for (let i = 0; i < RAINBOW_N; i++) {
    hsl(i / RAINBOW_N, 1, 0.6, rgb);
    PALETTE.push('#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]));
  }
})();
const RAINBOW_AT = 9;
/** Colour ids for the spawn calls: a rank index (0..6) works too. */
export const FX_COLOR = { white: 7, gold: 8, rainbow: RAINBOW_AT };

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

export class HudFx {
  private readonly cv = document.getElementById('hudfx') as HTMLCanvasElement;
  private readonly g = this.cv.getContext('2d');
  private readonly kind = new Uint8Array(MAX);
  private readonly col = new Uint8Array(MAX);
  private readonly x = new Float32Array(MAX);
  private readonly y = new Float32Array(MAX);
  private readonly vx = new Float32Array(MAX);
  private readonly vy = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly max = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly rot = new Float32Array(MAX);
  private readonly vr = new Float32Array(MAX);
  // fly particles: quadratic bezier x0,y0 -> cx,cy -> x1,y1
  private readonly x0 = new Float32Array(MAX);
  private readonly y0 = new Float32Array(MAX);
  private readonly cx = new Float32Array(MAX);
  private readonly cy = new Float32Array(MAX);
  private readonly x1 = new Float32Array(MAX);
  private readonly y1 = new Float32Array(MAX);
  private n = 0;
  private w = 0;
  private h = 0;
  private dirty = false;
  /** adaptive quality: fraction of the particles that are spawned */
  scale = 1;
  /** fly-in arrivals since the last read (the HUD swells the score on arrival) */
  arrived = 0;

  private fit(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.cv.width = w;
      this.cv.height = h;
    }
  }

  private slot(): number {
    if (this.n >= MAX) return -1;
    return this.n++;
  }

  clear(): void {
    this.n = 0;
    if (this.dirty) {
      this.g?.clearRect(0, 0, this.w, this.h);
      this.dirty = false;
    }
  }

  /** The old rank letter bursts into glass shards. */
  shards(box: Box, color: number, count = 16): void {
    const total = Math.max(4, Math.round(count * this.scale));
    for (let i = 0; i < total; i++) {
      const s = this.slot();
      if (s < 0) return;
      this.kind[s] = K_SHARD;
      this.col[s] = color;
      this.x[s] = box.l + Math.random() * (box.r - box.l);
      this.y[s] = box.t + Math.random() * (box.b - box.t);
      const ang = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 260;
      this.vx[s] = Math.cos(ang) * sp + 60;
      this.vy[s] = Math.sin(ang) * sp - 120;
      this.size[s] = 5 + Math.random() * 11;
      this.rot[s] = Math.random() * 6.28;
      this.vr[s] = (Math.random() - 0.5) * 16;
      this.life[s] = this.max[s] = 0.7 + Math.random() * 0.5;
    }
    this.dirty = true;
  }

  /** Grains of light flying from the BANK to the score. */
  fly(from: Box, to: Box, count: number, color: number, spread = 0.9): void {
    const total = Math.max(6, Math.round(count * this.scale));
    for (let i = 0; i < total; i++) {
      const s = this.slot();
      if (s < 0) return;
      this.kind[s] = K_FLY;
      this.col[s] = color === FX_COLOR.rainbow ? RAINBOW_AT + (i % RAINBOW_N) : color;
      this.x0[s] = from.l + Math.random() * (from.r - from.l);
      this.y0[s] = from.t + Math.random() * (from.b - from.t);
      this.x1[s] = to.l + Math.random() * (to.r - to.l);
      this.y1[s] = to.t + Math.random() * (to.b - to.t);
      const mx = (this.x0[s] + this.x1[s]) / 2;
      const my = (this.y0[s] + this.y1[s]) / 2;
      this.cx[s] = mx + (Math.random() - 0.5) * 220 * spread;
      this.cy[s] = my + (Math.random() - 0.2) * 160 * spread;
      this.size[s] = 2.5 + Math.random() * 3.5;
      // negative life = delay before it leaves the bank
      this.max[s] = 0.55 + Math.random() * 0.35;
      this.life[s] = this.max[s] + Math.random() * 0.9;
    }
    this.dirty = true;
  }

  /** Small radial burst (rank letter slam, ZONE level-up). */
  spark(box: Box, color: number, count: number): void {
    const total = Math.max(3, Math.round(count * this.scale));
    for (let i = 0; i < total; i++) {
      const s = this.slot();
      if (s < 0) return;
      this.kind[s] = K_SPARK;
      this.col[s] = color === FX_COLOR.rainbow ? RAINBOW_AT + (i % RAINBOW_N) : color;
      this.x[s] = (box.l + box.r) / 2;
      this.y[s] = (box.t + box.b) / 2;
      const ang = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 200;
      this.vx[s] = Math.cos(ang) * sp;
      this.vy[s] = Math.sin(ang) * sp;
      this.size[s] = 2 + Math.random() * 3;
      this.life[s] = this.max[s] = 0.4 + Math.random() * 0.4;
    }
    this.dirty = true;
  }

  update(dt: number): void {
    if (this.n === 0) {
      if (this.dirty) {
        this.g?.clearRect(0, 0, this.w, this.h);
        this.dirty = false;
      }
      return;
    }
    const g = this.g;
    if (!g) return;
    this.fit();
    g.clearRect(0, 0, this.w, this.h);
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      const k = this.kind[i];
      if (this.life[i] <= -0.0001 && k !== K_FLY) {
        this.remove(i);
        continue;
      }
      if (k === K_FLY) {
        const u = 1 - this.life[i] / this.max[i]; // < 0 while waiting at the bank
        if (u >= 1) {
          this.arrived++;
          this.remove(i);
          continue;
        }
        if (u < 0) {
          i++;
          continue;
        }
        const e = u * u * (3 - 2 * u);
        const a = 1 - e;
        const px = a * a * this.x0[i] + 2 * a * e * this.cx[i] + e * e * this.x1[i];
        const py = a * a * this.y0[i] + 2 * a * e * this.cy[i] + e * e * this.y1[i];
        g.globalAlpha = 0.35 + 0.65 * Math.min(1, u * 4);
        g.fillStyle = PALETTE[this.col[i]];
        const s = this.size[i] * (1 - 0.4 * e);
        g.fillRect(px - s, py - s, s * 2, s * 2);
        i++;
        continue;
      }
      const f = Math.max(0, this.life[i] / this.max[i]);
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      if (k === K_SHARD) {
        this.vy[i] += 900 * dt;
        this.rot[i] += this.vr[i] * dt;
        const s = this.size[i];
        const c = Math.cos(this.rot[i]) * s;
        const sn = Math.sin(this.rot[i]) * s;
        g.globalAlpha = Math.min(1, f * 1.6);
        g.fillStyle = PALETTE[this.col[i]];
        g.beginPath();
        g.moveTo(this.x[i] + c, this.y[i] + sn);
        g.lineTo(this.x[i] - sn * 0.8, this.y[i] + c * 0.8);
        g.lineTo(this.x[i] - c * 0.7, this.y[i] - sn * 0.7);
        g.closePath();
        g.fill();
      } else {
        g.globalAlpha = f;
        g.fillStyle = PALETTE[this.col[i]];
        const s = this.size[i];
        g.fillRect(this.x[i] - s / 2, this.y[i] - s / 2, s, s);
      }
      i++;
    }
    g.globalAlpha = 1;
  }

  private remove(i: number): void {
    const l = --this.n;
    if (i === l) return;
    this.kind[i] = this.kind[l]; this.col[i] = this.col[l];
    this.x[i] = this.x[l]; this.y[i] = this.y[l]; this.vx[i] = this.vx[l]; this.vy[i] = this.vy[l];
    this.life[i] = this.life[l]; this.max[i] = this.max[l]; this.size[i] = this.size[l];
    this.rot[i] = this.rot[l]; this.vr[i] = this.vr[l];
    this.x0[i] = this.x0[l]; this.y0[i] = this.y0[l]; this.cx[i] = this.cx[l]; this.cy[i] = this.cy[l];
    this.x1[i] = this.x1[l]; this.y1[i] = this.y1[l];
  }

  /** Particles alive (diagnostics). */
  get alive(): number {
    return this.n;
  }
}
