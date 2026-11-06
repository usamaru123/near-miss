import * as THREE from 'three';
import { SHIP_RADIUS, SPAWN_AHEAD } from '../game/constants';
import type { ItemKind } from '../game/constants';
import type { GameState } from '../game/types';
import { applyBend } from './bend';

const SHARD_MAX = 48;
const PER_KIND = 4;
const FADE_FAR = SPAWN_AHEAD - 20;
const FADE_NEAR = SPAWN_AHEAD - 90;

export const ITEM_COLORS: Record<ItemKind, number> = {
  SHIELD: 0x2f8cff,
  NITRO: 0xff8a00,
  DOUBLE: 0xffd23c,
  WARP: 0xb04dff,
  EMP: 0xff2a3a,
};

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.25)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(c);
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    g.font = '900 78px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(text, 64, 70);
  }
  return new THREE.CanvasTexture(c);
}

function addMat<T extends THREE.Material>(m: T): T {
  return applyBend(m);
}

function basic(color: number, opacity = 1, wire = false): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(1.7),
    transparent: opacity < 1,
    opacity,
    blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: opacity >= 1,
    wireframe: wire,
    fog: false,
    side: THREE.DoubleSide,
  });
  return addMat(m);
}

function edgesOf(geo: THREE.BufferGeometry, color: number): THREE.LineSegments {
  const m = addMat(new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.4), fog: false }));
  return new THREE.LineSegments(new THREE.EdgesGeometry(geo), m);
}

function boltShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0.15, 1.0);
  s.lineTo(-0.55, -0.05);
  s.lineTo(-0.08, -0.05);
  s.lineTo(-0.2, -1.0);
  s.lineTo(0.55, 0.12);
  s.lineTo(0.08, 0.12);
  s.closePath();
  return s;
}

interface Holder {
  id: number;
  group: THREE.Group;
  body: THREE.Object3D;
  mats: THREE.Material[];
  seen: number;
}

function buildBody(kind: ItemKind, glow: THREE.Texture): { body: THREE.Group; mats: THREE.Material[] } {
  const body = new THREE.Group();
  const mats: THREE.Material[] = [];
  const col = ITEM_COLORS[kind];
  const add = (o: THREE.Object3D, m?: THREE.Material): void => {
    body.add(o);
    if (m) mats.push(m);
  };
  switch (kind) {
    case 'SHIELD': {
      const geo = new THREE.CylinderGeometry(1, 1, 0.34, 6);
      geo.rotateX(Math.PI / 2);
      const fill = basic(col, 0.42);
      add(new THREE.Mesh(geo, fill), fill);
      const e = edgesOf(geo, col);
      add(e, e.material as THREE.Material);
      const ig = new THREE.CylinderGeometry(0.55, 0.55, 0.36, 6);
      ig.rotateX(Math.PI / 2);
      const ie = edgesOf(ig, 0xbfe0ff);
      add(ie, ie.material as THREE.Material);
      break;
    }
    case 'NITRO': {
      const outer = new THREE.ConeGeometry(0.75, 1.9, 10, 1, true);
      const om = basic(col, 0.65);
      add(new THREE.Mesh(outer, om), om);
      const inner = new THREE.ConeGeometry(0.4, 1.2, 10, 1, true);
      inner.translate(0, -0.2, 0);
      const im = basic(0xffee88, 0.8);
      add(new THREE.Mesh(inner, im), im);
      const e = edgesOf(outer, col);
      add(e, e.material as THREE.Material);
      break;
    }
    case 'DOUBLE': {
      const ring = new THREE.TorusGeometry(0.95, 0.09, 8, 28);
      const rm = basic(col, 1);
      add(new THREE.Mesh(ring, rm), rm);
      const plane = new THREE.PlaneGeometry(1.7, 1.7);
      const tm = addMat(
        new THREE.MeshBasicMaterial({
          map: labelTexture('×2'),
          color: new THREE.Color(col).multiplyScalar(2),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          side: THREE.DoubleSide,
        }),
      );
      add(new THREE.Mesh(plane, tm), tm);
      break;
    }
    case 'WARP': {
      const a = new THREE.ConeGeometry(0.75, 1.0, 4, 1);
      a.translate(0, 0.5, 0);
      const b = new THREE.ConeGeometry(0.75, 1.0, 4, 1);
      b.rotateX(Math.PI);
      b.translate(0, -0.5, 0);
      const am = basic(col, 0.5);
      const bm = basic(col, 0.5);
      add(new THREE.Mesh(a, am), am);
      add(new THREE.Mesh(b, bm), bm);
      const ea = edgesOf(a, col);
      const eb = edgesOf(b, col);
      add(ea, ea.material as THREE.Material);
      add(eb, eb.material as THREE.Material);
      break;
    }
    case 'EMP': {
      const geo = new THREE.ExtrudeGeometry(boltShape(), { depth: 0.3, bevelEnabled: false });
      geo.translate(0, 0, -0.15);
      const m = basic(0xffffff, 1);
      add(new THREE.Mesh(geo, m), m);
      const e = edgesOf(geo, col);
      add(e, e.material as THREE.Material);
      const ring = new THREE.TorusGeometry(1.0, 0.06, 6, 24);
      const rm = basic(col, 1);
      add(new THREE.Mesh(ring, rm), rm);
      break;
    }
  }
  // glow halo (additive, bends with the tunnel like everything else)
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 4.2),
    addMat(
      new THREE.MeshBasicMaterial({
        map: glow,
        color: new THREE.Color(col).multiplyScalar(1.1),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    ),
  );
  halo.position.z = -0.3;
  body.userData.halo = halo;
  mats.push(halo.material as THREE.Material);
  return { body, mats };
}

/** Pooled shard diamonds (one InstancedMesh) and per-kind power-up meshes. */
export class ItemView {
  readonly group = new THREE.Group();
  private readonly shards: THREE.InstancedMesh;
  private readonly pools = new Map<ItemKind, Holder[]>();
  private frame = 0;
  private spin = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly shardColor = new THREE.Color();

  constructor() {
    const geo = new THREE.OctahedronGeometry(0.34, 0);
    geo.scale(0.8, 1.45, 0.8);
    const mat = addMat(
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.shards = new THREE.InstancedMesh(geo, mat, SHARD_MAX);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHARD_MAX * 3), 3);
    this.shards.frustumCulled = false;
    this.shards.count = 0;
    this.group.add(this.shards);

    const glow = glowTexture();
    for (const kind of Object.keys(ITEM_COLORS) as ItemKind[]) {
      const list: Holder[] = [];
      for (let i = 0; i < PER_KIND; i++) {
        const g = new THREE.Group();
        const { body, mats } = buildBody(kind, glow);
        g.add(body);
        const halo = body.userData.halo as THREE.Object3D;
        body.remove(halo);
        g.add(halo);
        g.visible = false;
        this.group.add(g);
        list.push({ id: -1, group: g, body, mats, seen: 0 });
      }
      this.pools.set(kind, list);
    }
  }

  clear(): void {
    this.shards.count = 0;
    for (const list of this.pools.values()) for (const h of list) {
      h.group.visible = false;
      h.id = -1;
    }
  }

  sync(state: GameState, primary: THREE.Color, dt: number): void {
    this.frame++;
    this.spin += dt;
    // ---- shards ----
    const sh = state.shards;
    const n = Math.min(SHARD_MAX, sh.length);
    const col = this.shards.instanceColor as THREE.InstancedBufferAttribute;
    const colArr = col.array as Float32Array;
    const d = this.dummy;
    for (let i = 0; i < n; i++) {
      const s = sh[i];
      const ahead = -s.z;
      const fade = ahead > FADE_NEAR ? Math.max(0, 1 - (ahead - FADE_NEAR) / (FADE_FAR - FADE_NEAR)) : 1;
      d.position.set(Math.cos(s.theta) * SHIP_RADIUS, Math.sin(s.theta) * SHIP_RADIUS, s.z);
      d.rotation.set(0, this.spin * 3 + s.idx * 0.7, s.theta + Math.PI / 2);
      const sc = (0.9 + 0.12 * Math.sin(this.spin * 8 + s.idx)) * fade;
      d.scale.set(sc, sc, sc);
      d.updateMatrix();
      this.shards.setMatrixAt(i, d.matrix);
      this.shardColor.copy(primary).lerp(WHITE, 0.55).multiplyScalar(2.1);
      colArr[i * 3] = this.shardColor.r;
      colArr[i * 3 + 1] = this.shardColor.g;
      colArr[i * 3 + 2] = this.shardColor.b;
    }
    this.shards.count = n;
    this.shards.instanceMatrix.needsUpdate = true;
    col.needsUpdate = true;

    // ---- power-ups ----
    for (const list of this.pools.values()) for (const h of list) h.seen = 0;
    const pw = state.powerups;
    for (let i = 0; i < pw.length; i++) {
      const p = pw[i];
      const list = this.pools.get(p.kind)!;
      let h = list.find((x) => x.id === p.id);
      if (!h) {
        h = list.find((x) => !x.group.visible);
        if (!h) continue;
        h.id = p.id;
        h.group.visible = true;
      }
      h.seen = this.frame;
      const ahead = -p.z;
      const fade = ahead > FADE_NEAR ? Math.max(0, 1 - (ahead - FADE_NEAR) / (FADE_FAR - FADE_NEAR)) : 1;
      h.group.position.set(Math.cos(p.theta) * SHIP_RADIUS, Math.sin(p.theta) * SHIP_RADIUS, p.z);
      // the item faces the centre of the tunnel; spin differs per kind
      h.group.rotation.set(0, 0, p.theta + Math.PI / 2);
      const pulse = 1 + 0.08 * Math.sin(this.spin * 6 + p.id);
      h.group.scale.setScalar(fade * pulse * 1.05);
      switch (p.kind) {
        case 'SHIELD':
          h.body.rotation.z = this.spin * 1.2;
          break;
        case 'NITRO':
          h.body.rotation.set(0, this.spin * 2.4, 0);
          break;
        case 'DOUBLE':
          h.body.rotation.y = this.spin * 2.2;
          break;
        case 'WARP':
          h.body.rotation.set(0, this.spin * 1.7, Math.sin(this.spin * 2) * 0.3);
          break;
        case 'EMP':
          h.body.rotation.y = this.spin * 2.6;
          break;
      }
    }
    for (const list of this.pools.values()) for (const h of list) {
      if (h.group.visible && h.seen !== this.frame) {
        h.group.visible = false;
        h.id = -1;
      }
    }
  }
}

const WHITE = new THREE.Color(0xffffff);
