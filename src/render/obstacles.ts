import * as THREE from 'three';
import { arcLen } from '../game/angles';
import { SPAWN_AHEAD, TUNNEL_R } from '../game/constants';
import { DARK_PEAK_GAIN } from './biome';
import type { GameState } from '../game/types';
import { applyBend } from './bend';

const SEGMENTS = 28;
const POOL_SIZE = 110;
const R_OUT = TUNNEL_R;
const R_IN = TUNNEL_R - 2.2;
const FADE_START = 175;
const FADE_END = SPAWN_AHEAD - 10;

/** Inner-edge radius of column `i` (angle `phi`) for a biome's obstacle profile (DESIGN 20.1: angular / crystal / digital / flame / thin). */
function innerRadius(profile: number, i: number, phi: number): number {
  switch (profile) {
    case 1: // HEX: bevelled, a triangle wave with a 60 degree period
      return R_IN + 0.56 * Math.abs((((phi * 3) / Math.PI) % 1 + 1) % 1 - 0.5) * 2;
    case 2: // CRYSTAL: jagged teeth
      return R_IN + ((i & 1) === 0 ? 0 : 1.1);
    case 3: // DATA: blocky steps
      return R_IN + ((i * 7) % 3) * 0.4;
    case 4: // INFERNO: licking flames
      return R_IN + 0.55 * (0.5 + 0.5 * Math.sin(i * 1.7 + (i & 2)));
    case 5: // VOID: just a rim
      return R_OUT - 0.45;
    default:
      return R_IN;
  }
}

class ArcItem {
  readonly group = new THREE.Group();
  readonly fillMat: THREE.MeshBasicMaterial;
  readonly edgeMat: THREE.LineBasicMaterial;
  private readonly fillPos: Float32Array;
  private readonly edgePos: Float32Array;
  private readonly fillAttr: THREE.BufferAttribute;
  private readonly edgeAttr: THREE.BufferAttribute;

  constructor() {
    const cols = SEGMENTS + 1;
    this.fillPos = new Float32Array(cols * 4 * 3);
    this.fillAttr = new THREE.BufferAttribute(this.fillPos, 3);
    const idx: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      for (let k = 0; k < 4; k++) {
        const a = i * 4 + k;
        const b = i * 4 + ((k + 1) % 4);
        const c = (i + 1) * 4 + ((k + 1) % 4);
        const d = (i + 1) * 4 + k;
        idx.push(a, b, c, a, c, d);
      }
    }
    for (const base of [0, SEGMENTS * 4]) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', this.fillAttr);
    fillGeo.setIndex(idx);
    this.fillMat = applyBend(
      new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
      { obstacle: true },
    );
    const fill = new THREE.Mesh(fillGeo, this.fillMat);
    fill.frustumCulled = false;

    // edges: 2 faces * (2 polylines * SEGMENTS + 2 end radials) + 4 longitudinals
    const segCount = 2 * (2 * SEGMENTS + 2) + 4;
    this.edgePos = new Float32Array(segCount * 2 * 3);
    this.edgeAttr = new THREE.BufferAttribute(this.edgePos, 3);
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', this.edgeAttr);
    this.edgeMat = applyBend(new THREE.LineBasicMaterial({ color: 0xffffff, fog: false }));
    const edges = new THREE.LineSegments(edgeGeo, this.edgeMat);
    edges.frustumCulled = false;

    this.group.add(fill, edges);
    this.group.visible = false;
  }

  /** Last arc / profile this item was built for (a breathing PULSE_RING rebinds only when its gap moved). */
  a0 = NaN;
  len = NaN;
  half = NaN;
  profile = -1;

  bind(a0: number, len: number, h: number, profile: number): void {
    this.a0 = a0;
    this.len = len;
    this.half = h;
    this.profile = profile;
    const p = this.fillPos;
    let o = 0;
    for (let i = 0; i <= SEGMENTS; i++) {
      const phi = a0 + (len * i) / SEGMENTS;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const ri = innerRadius(profile, i, phi);
      p[o++] = c * ri; p[o++] = s * ri; p[o++] = h;
      p[o++] = c * R_OUT; p[o++] = s * R_OUT; p[o++] = h;
      p[o++] = c * R_OUT; p[o++] = s * R_OUT; p[o++] = -h;
      p[o++] = c * ri; p[o++] = s * ri; p[o++] = -h;
    }
    this.fillAttr.needsUpdate = true;

    const e = this.edgePos;
    o = 0;
    const put = (r: number, phi: number, z: number): void => {
      e[o++] = Math.cos(phi) * r;
      e[o++] = Math.sin(phi) * r;
      e[o++] = z;
    };
    for (const z of [h, -h]) {
      for (let i = 0; i < SEGMENTS; i++) {
        put(R_OUT, a0 + (len * i) / SEGMENTS, z);
        put(R_OUT, a0 + (len * (i + 1)) / SEGMENTS, z);
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const p0 = a0 + (len * i) / SEGMENTS;
        const p1 = a0 + (len * (i + 1)) / SEGMENTS;
        put(innerRadius(profile, i, p0), p0, z);
        put(innerRadius(profile, i + 1, p1), p1, z);
      }
      for (const [phi, i] of [[a0, 0], [a0 + len, SEGMENTS]] as const) {
        put(innerRadius(profile, i, phi), phi, z);
        put(R_OUT, phi, z);
      }
    }
    for (const [phi, i] of [[a0, 0], [a0 + len, SEGMENTS]] as const) {
      for (const r of [innerRadius(profile, i, phi), R_OUT]) {
        put(r, phi, h);
        put(r, phi, -h);
      }
    }
    this.edgeAttr.needsUpdate = true;
  }
}

interface Holder {
  id: number;
  items: ArcItem[];
  seen: number;
}

/** What the renderer tells the obstacle view each frame (palette of the current biome, ZONE blend already applied). */
export interface ObstacleLook {
  edge: THREE.Color;
  darkEdge: THREE.Color;
  fill: THREE.Color;
  edgeGain: number;
  fillMul: number;
  /** 0..1 beat pulse */
  beat: number;
  /** ZONE palette blend 0..1 */
  zone: number;
}

/** Pooled obstacle meshes, bound to sim obstacles by id. */
export class ObstacleView {
  readonly group = new THREE.Group();
  private readonly free: ArcItem[] = [];
  private readonly map = new Map<number, Holder>();
  private holders: Holder[] = [];
  private frame = 0;

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      const it = new ArcItem();
      this.free.push(it);
      this.group.add(it.group);
    }
  }

  clear(): void {
    for (const h of this.holders) this.release(h);
    this.holders.length = 0;
    this.map.clear();
  }

  private release(h: Holder): void {
    for (const it of h.items) {
      it.group.visible = false;
      this.free.push(it);
    }
    h.items.length = 0;
  }

  /** Rebuild every live item for a new inner-edge profile (the biome changed). */
  setProfile(p: number): void {
    if (p === this.profile) return;
    this.profile = p;
    // items are re-bound lazily in sync() when their stored profile differs
  }
  private profile = 0;

  sync(state: GameState, look: ObstacleLook): void {
    this.frame++;
    const obs = state.obstacles;
    const pulse = look.beat;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      let h = this.map.get(o.id);
      if (!h) {
        h = { id: o.id, items: [], seen: 0 };
        for (let k = 0; k < o.cur.length; k++) {
          const it = this.free.pop();
          if (!it) break;
          it.bind(o.cur[k].a, arcLen(o.cur[k].a, o.cur[k].b), o.hw - 0.3, this.profile);
          it.group.visible = true;
          h.items.push(it);
        }
        this.map.set(o.id, h);
        this.holders.push(h);
      }
      h.seen = this.frame;
      const ahead = -o.z;
      const fade = ahead <= FADE_START ? 1 : Math.max(0, 1 - (ahead - FADE_START) / (FADE_END - FADE_START));
      const near = ahead < 120 ? 1 - ahead / 120 : 0;
      const dark = o.section === 'DARK' && look.zone < 0.5; // the ZONE palette overrides the biome / section look
      // DARK (DESIGN 20.2): the edges burn at 30 % of their peak and flash to the full peak on every beat
      let gain = look.edgeGain;
      let bright = fade * (0.7 + 0.5 * near) * (1 + 0.55 * pulse);
      if (dark) {
        gain = DARK_PEAK_GAIN * (0.3 + 0.7 * pulse);
        bright = fade * (0.85 + 0.3 * near);
      }
      const edge = dark ? look.darkEdge : look.edge;
      const rot = o.omega !== 0 ? o.rot : 0;
      const laser = o.kind === 'LASER';
      for (let k = 0; k < h.items.length; k++) {
        const it = h.items[k];
        const arc = o.cur[k];
        const len = arcLen(arc.a, arc.b);
        // a breathing PULSE_RING moves its gap every frame; everything else binds once (or when the biome profile changed)
        if (it.profile !== this.profile || it.half !== o.hw - 0.3 || (o.pulse !== null && (it.a0 !== arc.a || it.len !== len))) {
          it.bind(arc.a, len, o.hw - 0.3, this.profile);
        }
        it.group.position.z = o.z;
        it.group.rotation.z = rot;
        it.edgeMat.color.copy(edge).multiplyScalar(bright * gain * (laser ? 1.25 : 1));
        it.fillMat.color.copy(look.fill).multiplyScalar(bright * (dark ? 0.3 + 0.7 * pulse : 1));
        it.fillMat.opacity = (laser ? 0.5 + 0.2 * near : 0.22 + 0.3 * near) * look.fillMul;
      }
    }
    let w = 0;
    for (let i = 0; i < this.holders.length; i++) {
      const h = this.holders[i];
      if (h.seen !== this.frame) {
        this.release(h);
        this.map.delete(h.id);
      } else {
        this.holders[w++] = h;
      }
    }
    this.holders.length = w;
  }
}
