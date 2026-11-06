import * as THREE from 'three';
import { MAX_ANG_VEL, SHIP_RADIUS } from '../game/constants';

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

/** Player ship: a flat dart with an edge outline and a glow sprite. */
export class Ship {
  readonly group = new THREE.Group();
  /** the opaque dart (without glow / flame); used to measure its on-screen size */
  readonly body: THREE.Mesh;
  private readonly bodyMat: THREE.MeshBasicMaterial;
  private readonly edgeMat: THREE.LineBasicMaterial;
  private readonly glowMat: THREE.SpriteMaterial;
  private bank = 0;
  private readonly flameOuter: THREE.Mesh;
  private readonly flameInner: THREE.Mesh;
  private readonly flameMatO: THREE.MeshBasicMaterial;
  private readonly flameMatI: THREE.MeshBasicMaterial;
  private flick = 0;

  constructor() {
    const geo = new THREE.ConeGeometry(0.34, 1.5, 4, 1);
    geo.rotateX(-Math.PI / 2); // tip toward -Z
    geo.scale(1.25, 0.45, 1);
    this.bodyMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const body = new THREE.Mesh(geo, this.bodyMat);
    this.body = body;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.edgeMat = edges.material as THREE.LineBasicMaterial;
    this.glowMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const glow = new THREE.Sprite(this.glowMat);
    glow.scale.set(3.2, 3.2, 1);
    glow.position.z = 0.6;
    const fg = new THREE.ConeGeometry(0.3, 1, 10, 1, true);
    fg.translate(0, 0.5, 0);
    fg.rotateX(Math.PI / 2); // base at origin, tip toward +Z (behind the ship)
    const mk = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
    this.flameMatO = mk();
    this.flameMatI = mk();
    this.flameOuter = new THREE.Mesh(fg, this.flameMatO);
    this.flameInner = new THREE.Mesh(fg, this.flameMatI);
    this.flameOuter.position.z = 0.55;
    this.flameInner.position.z = 0.55;
    this.group.add(body, edges, glow, this.flameOuter, this.flameInner);
  }

  /** `rs`: the cross-section's radius at the ship's angle relative to the round tunnel (visual only, 1 = round). */
  update(theta: number, angVel: number, dt: number, color: THREE.Color, hot: boolean, speedFrac: number, overdrive: boolean, rs = 1): void {
    this.group.position.set(Math.cos(theta) * SHIP_RADIUS * rs, Math.sin(theta) * SHIP_RADIUS * rs, 0);
    this.bank += (-(angVel / MAX_ANG_VEL) * 0.5 - this.bank) * (1 - Math.exp(-dt * 12));
    this.group.rotation.z = theta + Math.PI / 2 + this.bank;
    this.bodyMat.color.set(hot ? 0xffffff : 0xdff8ff).multiplyScalar(1.4);
    this.edgeMat.color.copy(color).multiplyScalar(2.2);
    this.glowMat.color.copy(color).multiplyScalar(1.3);
    // afterburner: longer with speed, huge in overdrive
    this.flick += dt * 60;
    const fl = 0.85 + 0.15 * Math.sin(this.flick) * Math.sin(this.flick * 2.7 + 1);
    const len = Math.min(5.2, (1.2 + speedFrac * 3.2) * (overdrive ? 1.6 : 1)) * fl;
    const w = (0.8 + speedFrac * 0.4) * (overdrive ? 1.9 : 1);
    this.flameOuter.scale.set(w, w * 0.6, len);
    this.flameInner.scale.set(w * 0.5, w * 0.3, len * 0.6);
    this.flameMatO.color.copy(color).multiplyScalar(1.8);
    this.flameMatI.color.set(0xffffff).multiplyScalar(1.6);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
