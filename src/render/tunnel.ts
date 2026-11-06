import * as THREE from 'three';
import { TUNNEL_R } from '../game/constants';
import { applyBend } from './bend';
import { NORMAL_LINE_PEAK, ZONE_LINE_PEAK } from './palette';

// Irregular ring spacing (8 rings per 24-unit period => >= 15 rings/s at 45 u/s) so that
// at high speed the pattern does not alias against the display refresh rate.
const PERIOD = 24;
const RING_OFFSETS = [0, 2.1, 4.6, 7.4, 10.3, 13.2, 17.5, 20.2];
const PERIODS = 15;
// 72 = a multiple of 4, 6 and 9: the corners of the square, hexagon and nine-sided cross-sections fall on vertices
const RING_SEGS = 72;
const LONG_COUNT = 36;
const LONG_LEN = PERIOD * PERIODS;
const LAMP_OFFSETS = [1.0, 6.0, 12.5, 19.0];
const LAMP_ANGLES = 8;

/** Per-biome look of the tunnel (renderer.ts blends these between biomes while the warp morphs). */
export interface TunnelVis {
  ring: number;
  long: number;
  lamp: number;
  shell: THREE.Color;
}
const DEFAULT_VIS: TunnelVis = { ring: 1, long: 1, lamp: 1, shell: new THREE.Color(0x05050f) };

/** Scrolling neon grid: rings + longitudinal lines + near-field wall lamps. Moved by dist. */
export class Tunnel {
  readonly group = new THREE.Group();
  private readonly ringMat: THREE.LineBasicMaterial;
  private readonly longMat: THREE.LineBasicMaterial;
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly scroll = new THREE.Group();
  private readonly shellMat: THREE.MeshBasicMaterial;
  private readonly shellBase = new THREE.Color(0x05050f);

  constructor() {
    const r = TUNNEL_R + 0.02;
    const ringCount = PERIODS * RING_OFFSETS.length;
    const ringPos = new Float32Array(ringCount * RING_SEGS * 2 * 3);
    let o = 0;
    for (let p = 0; p < PERIODS; p++) {
      for (const off of RING_OFFSETS) {
        const z = PERIOD - (p * PERIOD + off);
        for (let k = 0; k < RING_SEGS; k++) {
          const a0 = (k / RING_SEGS) * Math.PI * 2;
          const a1 = ((k + 1) / RING_SEGS) * Math.PI * 2;
          ringPos[o++] = Math.cos(a0) * r;
          ringPos[o++] = Math.sin(a0) * r;
          ringPos[o++] = z;
          ringPos[o++] = Math.cos(a1) * r;
          ringPos[o++] = Math.sin(a1) * r;
          ringPos[o++] = z;
        }
      }
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
    this.ringMat = applyBend(new THREE.LineBasicMaterial({ color: 0xffffff, fog: true }), true);
    const rings = new THREE.LineSegments(ringGeo, this.ringMat);
    rings.frustumCulled = false;

    o = 0;
    // longitudinals as many short segments (bend needs interior vertices)
    const SUB = 60;
    const sub = new Float32Array(LONG_COUNT * SUB * 2 * 3);
    o = 0;
    for (let i = 0; i < LONG_COUNT; i++) {
      const a = (i / LONG_COUNT) * Math.PI * 2;
      const cx = Math.cos(a) * r;
      const cy = Math.sin(a) * r;
      for (let k = 0; k < SUB; k++) {
        sub[o++] = cx; sub[o++] = cy; sub[o++] = PERIOD - (LONG_LEN * k) / SUB;
        sub[o++] = cx; sub[o++] = cy; sub[o++] = PERIOD - (LONG_LEN * (k + 1)) / SUB;
      }
    }
    const longGeo = new THREE.BufferGeometry();
    longGeo.setAttribute('position', new THREE.BufferAttribute(sub, 3));
    this.longMat = applyBend(new THREE.LineBasicMaterial({ color: 0xffffff, fog: true }), true);
    const longs = new THREE.LineSegments(longGeo, this.longMat);
    longs.frustumCulled = false;

    // Wall lamps: short bright strips flowing past the ship (near-field parallax).
    const lampCount = PERIODS * LAMP_OFFSETS.length * LAMP_ANGLES;
    const lampGeo = new THREE.BoxGeometry(0.28, 0.1, 1.8);
    this.lampMat = applyBend(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }), true);
    const lamps = new THREE.InstancedMesh(lampGeo, this.lampMat, lampCount);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let n = 0;
    for (let p = 0; p < PERIODS; p++) {
      for (let li = 0; li < LAMP_OFFSETS.length; li++) {
        for (let a = 0; a < LAMP_ANGLES; a++) {
          const ang = ((a + (li % 2) * 0.5) / LAMP_ANGLES) * Math.PI * 2;
          e.set(0, 0, ang + Math.PI / 2);
          q.setFromEuler(e);
          m.compose(
            new THREE.Vector3(Math.cos(ang) * (TUNNEL_R - 0.12), Math.sin(ang) * (TUNNEL_R - 0.12), PERIOD - (p * PERIOD + LAMP_OFFSETS[li])),
            q,
            new THREE.Vector3(1, 1, 1),
          );
          lamps.setMatrixAt(n++, m);
        }
      }
    }
    lamps.frustumCulled = false;

    // Faint dark shell so the far end of the tunnel reads as a surface rather than a void.
    this.shellMat = applyBend(new THREE.MeshBasicMaterial({ color: 0x05050f, side: THREE.BackSide, fog: true }));
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(TUNNEL_R + 0.1, TUNNEL_R + 0.1, LONG_LEN, 48, 60, true), this.shellMat);
    shell.rotation.x = Math.PI / 2;
    shell.position.z = -LONG_LEN / 2 + PERIOD;
    shell.frustumCulled = false;

    this.scroll.add(rings, longs, lamps);
    this.group.add(shell, this.scroll);
  }

  /**
   * `bright` (1 = normal) scales the whole grid: A rank and above lights the tunnel lines up (DESIGN 18.3);
   * `zone` (0..1) is the ZONE palette blend: black shell, rainbow lines (the rainbow itself is in the shader),
   * deliberately calmer than the normal lines so obstacles stand out more, not less.
   */
  update(dist: number, primary: THREE.Color, secondary: THREE.Color, pulse: number, speedFrac: number, bright = 1, zone = 0, vis: TunnelVis = DEFAULT_VIS): void {
    this.scroll.position.z = dist % PERIOD;
    const calm = 1 - zone * (1 - ZONE_LINE_PEAK / NORMAL_LINE_PEAK);
    this.ringMat.color.copy(primary).multiplyScalar((0.5 + 0.55 * pulse + 0.25 * speedFrac) * bright * calm * vis.ring);
    this.longMat.color.copy(secondary).multiplyScalar((0.28 + 0.2 * pulse) * bright * (1 + zone * 0.4) * vis.long);
    this.lampMat.color.copy(secondary).lerp(primary, 0.4).multiplyScalar(2.4 * (1 + (bright - 1) * 0.5) * (1 - zone * 0.45) * vis.lamp);
    this.shellMat.color.copy(this.shellBase).copy(vis.shell).multiplyScalar(1 - zone);
  }
}
