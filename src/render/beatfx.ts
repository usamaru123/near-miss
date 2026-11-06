import * as THREE from 'three';
import { OBSTACLE_THICK, SHIP_RADIUS, TUNNEL_R } from '../game/constants';
import { applyBend } from './bend';

const FADE_SPAN = 2; // beats before arrival at which the timing ring appears

/** Translucent wireframe replay of the best run (DESIGN 15.2). One pooled mesh set, never reallocated. */
export class GhostShip {
  readonly group = new THREE.Group();
  private readonly bodyMat: THREE.MeshBasicMaterial;
  private readonly trailMat: THREE.MeshBasicMaterial;
  private amt = 0;

  constructor() {
    const geo = new THREE.ConeGeometry(0.34, 1.5, 4, 1);
    geo.rotateX(-Math.PI / 2);
    geo.scale(1.25, 0.45, 1);
    this.bodyMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      fog: false,
    });
    const body = new THREE.Mesh(geo, this.bodyMat);
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, depthWrite: false, fog: false }),
    );
    // weak trail: a long faint cone behind the ghost
    const tg = new THREE.ConeGeometry(0.28, 1, 8, 1, true);
    tg.translate(0, 0.5, 0);
    tg.rotateX(Math.PI / 2);
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const trail = new THREE.Mesh(tg, this.trailMat);
    trail.position.z = 0.55;
    trail.scale.set(1, 1, 1.8);
    this.group.add(body, fill, trail);
    this.group.visible = false;
  }

  update(visible: boolean, theta: number, z: number, angVel: number, dt: number, rs = 1): void {
    this.amt += ((visible ? 1 : 0) - this.amt) * (1 - Math.exp(-dt * 8));
    this.group.visible = this.amt > 0.02;
    if (!this.group.visible) return;
    this.group.position.set(Math.cos(theta) * SHIP_RADIUS * rs, Math.sin(theta) * SHIP_RADIUS * rs, z);
    this.group.rotation.z = theta + Math.PI / 2 - angVel * 0.04;
    this.bodyMat.opacity = 0.25 * this.amt;
    this.trailMat.opacity = 0.045 * this.amt;
  }
}

/** Blinking red arrow beside the ship during CLUTCH: points the nearest way out. */
export class ClutchArrow {
  readonly group = new THREE.Group();
  private readonly mat: THREE.MeshBasicMaterial;
  private t = 0;

  constructor() {
    const s = new THREE.Shape();
    s.moveTo(1.1, 0);
    s.lineTo(0.1, 0.62);
    s.lineTo(0.1, 0.24);
    s.lineTo(-0.9, 0.24);
    s.lineTo(-0.9, -0.24);
    s.lineTo(0.1, -0.24);
    s.lineTo(0.1, -0.62);
    s.closePath();
    this.mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff1830).multiplyScalar(2.2),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), this.mat);
    m.renderOrder = 12;
    this.group.add(m);
    this.group.visible = false;
  }

  /** `dir` is +1 / -1 along increasing theta, 0 = hide. */
  update(active: boolean, dir: number, theta: number, dt: number, rs = 1): void {
    this.t += dt;
    const on = active && dir !== 0 && Math.floor(this.t * 12) % 2 === 0;
    this.group.visible = on;
    if (!on) return;
    // sit beside the ship along the wall, pointing in the escape direction
    const off = theta + dir * 0.34;
    this.group.position.set(Math.cos(off) * (SHIP_RADIUS * rs - 0.2), Math.sin(off) * (SHIP_RADIUS * rs - 0.2), 0.4);
    const tx = -Math.sin(theta) * dir;
    const ty = Math.cos(theta) * dir;
    this.group.rotation.z = Math.atan2(ty, tx);
    this.group.scale.setScalar(1 + 0.15 * Math.sin(this.t * 30));
  }
}

/** Ring that shrinks onto the next obstacle's outer edge and coincides with it on arrival (DESIGN 15.1). */
export class TimingRing {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor() {
    const geo = new THREE.RingGeometry(0.975, 1, 72);
    this.mat = applyBend(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /** beatsLeft: beats until the obstacle reaches the ship; z: its current position. */
  update(beatsLeft: number, z: number, color: THREE.Color, onGrid: boolean): void {
    const k = Math.max(0, Math.min(1, beatsLeft / FADE_SPAN));
    if (beatsLeft > FADE_SPAN || beatsLeft < -0.05 || !onGrid) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const r = TUNNEL_R + 0.1 + 2.6 * k;
    this.mesh.scale.set(r, r, 1);
    this.mesh.position.z = z + OBSTACLE_THICK * 0.5;
    this.mat.color.copy(color).multiplyScalar(2.2);
    // fades in as it appears, flares at the moment of arrival
    this.mat.opacity = Math.min(1, (1 - k) * 1.4 + 0.15) * 0.75;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
