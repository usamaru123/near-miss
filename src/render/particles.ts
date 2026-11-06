import * as THREE from 'three';
import { TUNNEL_R } from '../game/constants';
import { applyBend } from './bend';

const LINE_COUNT = 520;
const LINE_DEPTH = 260;
const DEBRIS_MAX = 420;

/** Speed lines: pooled line segments streaming toward the camera. */
export class SpeedLines {
  readonly object: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly attr: THREE.BufferAttribute;
  private readonly ang = new Float32Array(LINE_COUNT);
  private readonly rad = new Float32Array(LINE_COUNT);
  private readonly z = new Float32Array(LINE_COUNT);
  private readonly len = new Float32Array(LINE_COUNT);
  private readonly mat: THREE.LineBasicMaterial;
  private seed = 12345;
  /** adaptive quality: fraction of the lines that are drawn (DESIGN 17.6) */
  scale = 1;

  constructor() {
    this.pos = new Float32Array(LINE_COUNT * 6);
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.attr);
    this.mat = applyBend(new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }));
    this.object = new THREE.LineSegments(geo, this.mat);
    this.object.frustumCulled = false;
    for (let i = 0; i < LINE_COUNT; i++) this.respawn(i, -Math.random() * LINE_DEPTH);
  }

  private rnd(): number {
    // tiny LCG; visuals only
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private respawn(i: number, z: number): void {
    this.ang[i] = this.rnd() * Math.PI * 2;
    this.rad[i] = 1.2 + this.rnd() * (TUNNEL_R - 1.6);
    this.z[i] = z;
    this.len[i] = 0.5 + this.rnd() * 1.5;
  }

  /** `boost` doubles the lines at S rank and above (DESIGN 18.3). */
  update(dt: number, speed: number, speedFrac: number, overdrive: boolean, color: THREE.Color, boost = 1): void {
    const active = Math.min(LINE_COUNT, Math.floor((60 + 200 * speedFrac) * (overdrive ? 1.3 : 1) * this.scale * boost));
    const stretch = 0.012 + speedFrac * 0.03 + (overdrive ? 0.02 : 0);
    const p = this.pos;
    for (let i = 0; i < active; i++) {
      let z = this.z[i] + speed * dt;
      if (z > 6) {
        this.respawn(i, -LINE_DEPTH - this.rnd() * 40);
        z = this.z[i];
      } else this.z[i] = z;
      const len = this.len[i] * speed * stretch;
      const c = Math.cos(this.ang[i]) * this.rad[i];
      const s = Math.sin(this.ang[i]) * this.rad[i];
      const o = i * 6;
      p[o] = c; p[o + 1] = s; p[o + 2] = z;
      p[o + 3] = c; p[o + 4] = s; p[o + 5] = z - len;
    }
    this.attr.needsUpdate = true;
    this.object.geometry.setDrawRange(0, active * 2);
    this.mat.color.copy(color);
    this.mat.opacity = 0.25 + 0.5 * speedFrac + (overdrive ? 0.2 : 0);
  }
}

/** Debris / sparks via a single InstancedMesh with typed-array particle state. */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly px = new Float32Array(DEBRIS_MAX);
  private readonly py = new Float32Array(DEBRIS_MAX);
  private readonly pz = new Float32Array(DEBRIS_MAX);
  private readonly vx = new Float32Array(DEBRIS_MAX);
  private readonly vy = new Float32Array(DEBRIS_MAX);
  private readonly vz = new Float32Array(DEBRIS_MAX);
  private readonly life = new Float32Array(DEBRIS_MAX);
  private readonly maxLife = new Float32Array(DEBRIS_MAX);
  private readonly size = new Float32Array(DEBRIS_MAX);
  private readonly cr = new Float32Array(DEBRIS_MAX);
  private readonly cg = new Float32Array(DEBRIS_MAX);
  private readonly cb = new Float32Array(DEBRIS_MAX);
  private count = 0;
  /** adaptive quality: multiplier for the number of particles per emit (DESIGN 17.6) */
  scale = 1;

  constructor() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = applyBend(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    }));
    this.mesh = new THREE.InstancedMesh(geo, mat, DEBRIS_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_MAX * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
  }

  emit(
    x: number, y: number, z: number,
    n: number, speed: number, life: number, size: number,
    r: number, g: number, b: number,
    flowZ = 0,
  ): void {
    const total = this.scale < 1 ? Math.ceil(n * this.scale) : n;
    for (let k = 0; k < total && this.count < DEBRIS_MAX; k++) {
      const i = this.count++;
      const u = Math.random() * Math.PI * 2;
      const v = Math.random() * 2 - 1;
      const w = Math.sqrt(1 - v * v);
      const sp = speed * (0.35 + Math.random() * 0.9);
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = Math.cos(u) * w * sp;
      this.vy[i] = Math.sin(u) * w * sp;
      this.vz[i] = v * sp + flowZ;
      const l = life * (0.6 + Math.random() * 0.8);
      this.life[i] = l; this.maxLife[i] = l;
      this.size[i] = size * (0.5 + Math.random());
      this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
    }
  }

  update(dt: number): void {
    let i = 0;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const col = (this.mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.count;
        if (i !== last) {
          this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
          this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
          this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last]; this.size[i] = this.size[last];
          this.cr[i] = this.cr[last]; this.cg[i] = this.cg[last]; this.cb[i] = this.cb[last];
        }
        continue;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const f = this.life[i] / this.maxLife[i];
      const s = this.size[i] * (0.3 + 0.7 * f);
      const o = i * 16;
      m[o] = s; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = s; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = s; m[o + 11] = 0;
      m[o + 12] = this.px[i]; m[o + 13] = this.py[i]; m[o + 14] = this.pz[i]; m[o + 15] = 1;
      col[i * 3] = this.cr[i] * f * 2;
      col[i * 3 + 1] = this.cg[i] * f * 2;
      col[i * 3 + 2] = this.cb[i] * f * 2;
      i++;
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
}
