import * as THREE from 'three';
import { MAX_ANG_VEL, SHIP_RADIUS, TUNNEL_R } from '../game/constants';
import { applyBend } from './bend';
import { hsl } from './palette';

const RIBBON_MAX = 10;
const RIBBON_SEG = 52;
const SEG_LEN = 1.35;
const WALL_R = TUNNEL_R - 0.4;
/** Ribbons are bright up close and fade out with distance, so they never fill the central no-go circle (DESIGN 14). */
const FADE_NEAR = 8;
const FADE_FAR = 46;
const rgb = [0, 0, 0];

/**
 * ZONE light ribbons: helices of rainbow light spiralling along the tunnel wall.
 * One InstancedMesh with RIBBON_MAX x RIBBON_SEG pooled segments; counts and colours are rewritten in place each frame.
 */
export class RibbonField {
  readonly mesh: THREE.InstancedMesh;
  private readonly m: Float32Array;
  private readonly col: Float32Array;
  private amt = 0;
  /** adaptive quality: fraction of the ribbons drawn */
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
    const n = RIBBON_MAX * RIBBON_SEG;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
    this.m = this.mesh.instanceMatrix.array as Float32Array;
    this.col = (this.mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
  }

  /**
   * @param zone 0..1 blend (fades the whole field in / out)
   * @param lv ZONE level: more ribbons per level
   * @param beat 0..1 beat pulse (ribbons swell on the beat)
   * @param flash reduced-flash scale (pulse and brightness)
   */
  update(dt: number, time: number, dist: number, zone: number, lv: number, beat: number, flash: number): void {
    this.amt += (zone - this.amt) * (1 - Math.exp(-dt * 6));
    const on = this.amt > 0.01;
    this.mesh.visible = on;
    if (!on) {
      this.mesh.count = 0;
      return;
    }
    const want = Math.max(1, Math.min(RIBBON_MAX, Math.ceil((3 + lv) * this.scale)));
    this.mesh.count = want * RIBBON_SEG;
    const m = this.m;
    const col = this.col;
    const swell = 1 + beat * 0.9 * (0.4 + 0.6 * flash);
    const spin = time * 0.9;
    let o = 0;
    let c = 0;
    for (let k = 0; k < want; k++) {
      const phase = (k / want) * Math.PI * 2;
      for (let i = 0; i < RIBBON_SEG; i++) {
        const z = 3.5 - i * SEG_LEN;
        const zw = z - dist;
        const a = phase + zw * 0.052 + spin;
        const x = Math.cos(a) * WALL_R;
        const y = Math.sin(a) * WALL_R;
        const near = z > -FADE_NEAR ? 1 : Math.max(0, 1 - (-z - FADE_NEAR) / (FADE_FAR - FADE_NEAR));
        const f = near * near * this.amt;
        // segment lies along the wall: width tangent to the circle, length along z
        const ca = Math.cos(a + Math.PI / 2);
        const sa = Math.sin(a + Math.PI / 2);
        const w = 0.16 * swell;
        const th = 0.05;
        m[o] = ca * w; m[o + 1] = sa * w; m[o + 2] = 0; m[o + 3] = 0;
        m[o + 4] = -sa * th; m[o + 5] = ca * th; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = SEG_LEN * 1.15; m[o + 11] = 0;
        m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
        o += 16;
        hsl((i * 0.011 + time * 0.25 + k / want) % 1, 1, 0.55, rgb);
        const g = f * 0.5 * (0.7 + 0.3 * Math.sin(zw * 0.35 + time * 3));
        col[c++] = rgb[0] * g;
        col[c++] = rgb[1] * g;
        col[c++] = rgb[2] * g;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.mesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
}

const AFTER_MAX = 3;
const HIST = 48;

/** Rainbow after-images of the ship (up to 3): ghosts of where it was 0.07 / 0.14 / 0.21 s ago. */
export class Afterimages {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private readonly ht = new Float32Array(HIST);
  private readonly hth = new Float32Array(HIST);
  private hi = 0;
  private time = 0;
  private amt = 0;
  /** adaptive quality: how many are drawn (0..3) */
  count = AFTER_MAX;

  constructor() {
    const geo = new THREE.ConeGeometry(0.34, 1.5, 4, 1);
    geo.rotateX(-Math.PI / 2);
    geo.scale(1.25, 0.45, 1);
    for (let i = 0; i < AFTER_MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);
    }
    this.ht.fill(-1);
  }

  clear(): void {
    this.ht.fill(-1);
    for (const m of this.meshes) m.visible = false;
    this.amt = 0;
  }

  update(dt: number, theta: number, angVel: number, zone: number, flash: number): void {
    this.time += dt;
    this.amt += (zone - this.amt) * (1 - Math.exp(-dt * 8));
    this.ht[this.hi] = this.time;
    this.hth[this.hi] = theta;
    this.hi = (this.hi + 1) % HIST;
    const on = this.amt > 0.02;
    for (let i = 0; i < AFTER_MAX; i++) {
      const mesh = this.meshes[i];
      const show = on && i < this.count;
      mesh.visible = show;
      if (!show) continue;
      // find the history sample closest to (time - lag)
      const want = this.time - 0.07 * (i + 1);
      let best = -1;
      let bd = 1e9;
      for (let k = 0; k < HIST; k++) {
        if (this.ht[k] < 0) continue;
        const d = Math.abs(this.ht[k] - want);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      const th = best >= 0 ? this.hth[best] : theta;
      mesh.position.set(Math.cos(th) * SHIP_RADIUS, Math.sin(th) * SHIP_RADIUS, 0.5 + i * 0.5);
      mesh.rotation.z = th + Math.PI / 2 - (angVel / MAX_ANG_VEL) * 0.5;
      hsl((this.time * 0.6 + i * 0.18) % 1, 1, 0.6, rgb);
      const g = 1.1 - i * 0.2;
      this.mats[i].color.setRGB(rgb[0] * g, rgb[1] * g, rgb[2] * g);
      this.mats[i].opacity = (0.5 - i * 0.12) * this.amt * (0.5 + 0.5 * flash);
    }
  }
}
