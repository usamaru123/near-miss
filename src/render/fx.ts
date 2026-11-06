import * as THREE from 'three';

/** Fraction of the screen's short side used as the diameter of the central no-go circle (DESIGN 14). */
export const NOGO_DIAMETER_FRAC = 0.4;

/**
 * Screen-space shockwave ring radius, in units of the half short side, at progress e in 0..1.
 * The ring (inner edge = 0.9 x radius) always starts outside the central no-go circle.
 */
export function shockRadius(e: number): number {
  return 0.52 + e * 1.5;
}
/** Inner edge of the ring relative to its radius (RingGeometry(0.9, 1)). */
export const SHOCK_INNER = 0.9;
/** Radius of the no-go circle in units of the half short side. */
export const NOGO_RADIUS_HALF = NOGO_DIAMETER_FRAC;

/** Translucent energy bubble around the ship (SHIELD). */
export class ShieldBubble {
  readonly group = new THREE.Group();
  private readonly fillMat: THREE.MeshBasicMaterial;
  private readonly wireMat: THREE.MeshBasicMaterial;
  private t = 0;
  private amt = 0;

  constructor() {
    const geo = new THREE.IcosahedronGeometry(0.86, 1);
    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0x3a96ff,
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.wireMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x66b4ff).multiplyScalar(1.1),
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const a = new THREE.Mesh(geo, this.fillMat);
    const b = new THREE.Mesh(geo, this.wireMat);
    b.scale.setScalar(1.01);
    this.group.add(a, b);
    this.group.visible = false;
  }

  update(on: boolean, dt: number): void {
    this.t += dt;
    this.amt += ((on ? 1 : 0) - this.amt) * (1 - Math.exp(-dt * 14));
    this.group.visible = this.amt > 0.02;
    if (!this.group.visible) return;
    const s = this.amt * (1 + 0.05 * Math.sin(this.t * 9));
    this.group.scale.set(s * 1.0, s * 0.8, s * 1.5);
    this.group.rotation.set(this.t * 0.9, this.t * 1.3, 0);
    this.fillMat.opacity = 0.06 * this.amt;
    this.wireMat.opacity = 0.3 * this.amt;
  }
}

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  life: number;
  max: number;
}

/** Pooled expanding rings in world space around the ship (pickups, shard flashes). */
export class PickupRings {
  readonly group = new THREE.Group();
  private readonly rings: Ring[] = [];
  private idx = 0;

  constructor(n = 10) {
    const geo = new THREE.RingGeometry(0.8, 1, 40);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 1, life: 0.5, max: 4 });
    }
  }

  emit(x: number, y: number, color: THREE.Color, max: number, life: number): void {
    const r = this.rings[this.idx++ % this.rings.length];
    r.t = 0;
    r.life = life;
    r.max = max;
    r.mat.color.copy(color).multiplyScalar(2);
    r.mesh.position.set(x, y, 0.2);
    r.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t = Math.min(1, r.t + dt / r.life);
      const e = 1 - (1 - r.t) * (1 - r.t);
      const s = 0.4 + e * r.max;
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = (1 - r.t) * 0.9;
      if (r.t >= 1) r.mesh.visible = false;
    }
  }

  clear(): void {
    for (const r of this.rings) {
      r.t = 1;
      r.mesh.visible = false;
    }
  }
}
