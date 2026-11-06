import * as THREE from 'three';
import { arcLen } from '../game/angles';
import { OBSTACLE_THICK, SPAWN_AHEAD, TUNNEL_R } from '../game/constants';
import type { GameState } from '../game/types';
import { applyBend } from './bend';

const SEGMENTS = 28;
const POOL_SIZE = 110;
const R_OUT = TUNNEL_R;
const R_IN = TUNNEL_R - 2.2;
const FADE_START = 175;
const FADE_END = SPAWN_AHEAD - 10;

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
    this.fillMat = applyBend(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }));
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

  bind(a0: number, len: number): void {
    const h = OBSTACLE_THICK / 2;
    const p = this.fillPos;
    let o = 0;
    for (let i = 0; i <= SEGMENTS; i++) {
      const phi = a0 + (len * i) / SEGMENTS;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      p[o++] = c * R_IN; p[o++] = s * R_IN; p[o++] = h;
      p[o++] = c * R_OUT; p[o++] = s * R_OUT; p[o++] = h;
      p[o++] = c * R_OUT; p[o++] = s * R_OUT; p[o++] = -h;
      p[o++] = c * R_IN; p[o++] = s * R_IN; p[o++] = -h;
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
      for (const r of [R_OUT, R_IN]) {
        for (let i = 0; i < SEGMENTS; i++) {
          put(r, a0 + (len * i) / SEGMENTS, z);
          put(r, a0 + (len * (i + 1)) / SEGMENTS, z);
        }
      }
      for (const phi of [a0, a0 + len]) {
        put(R_IN, phi, z);
        put(R_OUT, phi, z);
      }
    }
    for (const phi of [a0, a0 + len]) {
      for (const r of [R_IN, R_OUT]) {
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

  /** `pulse` 0..1: beat pulse (strong on the downbeat, weak on the offbeat). */
  sync(state: GameState, edgeColor: THREE.Color, fillColor: THREE.Color, pulse = 0): void {
    this.frame++;
    const obs = state.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      let h = this.map.get(o.id);
      if (!h) {
        h = { id: o.id, items: [], seen: 0 };
        for (let k = 0; k < o.solids.length; k++) {
          const it = this.free.pop();
          if (!it) break;
          it.bind(o.solids[k].a, arcLen(o.solids[k].a, o.solids[k].b));
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
      const bright = fade * (0.7 + 0.5 * near) * (1 + 0.55 * pulse);
      const rot = o.omega !== 0 ? o.rot : 0;
      for (let k = 0; k < h.items.length; k++) {
        const it = h.items[k];
        it.group.position.z = o.z;
        it.group.rotation.z = rot;
        it.edgeMat.color.copy(edgeColor).multiplyScalar(bright * 1.7);
        it.fillMat.color.copy(fillColor).multiplyScalar(bright);
        it.fillMat.opacity = 0.22 + 0.3 * near;
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
