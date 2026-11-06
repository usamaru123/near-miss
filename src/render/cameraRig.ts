import * as THREE from 'three';
import { angDiff } from '../game/angles';
import {
  CAM_ROLL_MAX,
  FOV_MAX,
  FOV_MIN,
  FOV_OVERDRIVE,
  LAUNCH_START_FOV,
  MAX_ANG_VEL,
  FLIP_ROLL_TIME,
  SHIP_RADIUS,
  SPEED_BASE,
  SPEED_MAX,
} from '../game/constants';
import { flipInputSign } from './biome';
import { FOV_HARD_MAX, baseVfov, camZFor } from './viewFit';

const CAM_RADIUS = 2.9;
const CAM_Z = 6.5;
/** Radial distance between the camera and the ship (ship radius - camera radius). */
const SHIP_OFFSET = SHIP_RADIUS - CAM_RADIUS;

/** Follows the ship angle (ship stays at screen bottom; the tunnel rolls), with lag, tilt, FOV and trauma shake. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private ang = 0;
  private tilt = 0;
  private fov = FOV_MIN;
  private fovKickV = 0;
  private trauma = 0;
  private time = 0;
  private readonly target = new THREE.Vector3(0, 0, -40);
  /** Portrait widening (deg) added on top of the speed-driven FOV; 0 on landscape. */
  private fovOffset = 0;
  private camZ = CAM_Z;
  /** SS / SSS / ZONE rattle the camera more (DESIGN 18.3); 1 = normal */
  rumbleBoost = 1;
  /** FLIP (DESIGN 20.2): 0 = upright, 1 = upside down; the roll takes FLIP_ROLL_TIME seconds either way */
  private flipTarget = 0;
  private flipP = 0;

  setFlip(on: boolean): void {
    this.flipTarget = on ? 1 : 0;
  }

  /** Roll about the view axis in radians (0 .. pi), eased. */
  get flipRoll(): number {
    const p = this.flipP;
    return Math.PI * p * p * (3 - 2 * p);
  }

  /** Multiplier for the steering input so that left is always screen-left, whatever the roll. */
  get inputSign(): number {
    return flipInputSign(this.flipRoll);
  }

  /** Jump to a flip state without the animation (reset / tests). */
  snapFlip(on: boolean): void {
    this.flipTarget = this.flipP = on ? 1 : 0;
  }

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV_MIN, aspect, 0.1, 420);
    this.setAspect(aspect);
  }

  /** Base vertical FOV for the current aspect, before the speed boost (DESIGN 17.2). */
  get fovBase(): number {
    return FOV_MIN + this.fovOffset;
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    const base = baseVfov(a, FOV_MIN);
    this.fovOffset = base - FOV_MIN;
    // landscape keeps the original camera; portrait pulls back only if the ship would exceed 12 % of the short side
    this.camZ = a >= 1 ? CAM_Z : camZFor(base, a, CAM_Z, SHIP_OFFSET);
    this.camera.fov = base;
    this.camera.updateProjectionMatrix();
  }

  reset(theta: number): void {
    this.ang = theta;
    this.tilt = 0;
    this.trauma = 0;
  }

  /** Launch punch: start narrow, snap out to the normal FOV with an overshoot. */
  launch(scale: number): void {
    this.fov = LAUNCH_START_FOV;
    this.fovKickV = 16 * scale;
    this.trauma = Math.min(1, this.trauma + 0.7 * scale);
  }

  fovKick(deg: number): void {
    this.fovKickV += deg;
  }

  addTrauma(t: number): void {
    this.trauma = Math.min(1, this.trauma + t);
  }

  get currentTrauma(): number {
    return this.trauma;
  }

  /** `xsK`: how far the camera follows the cross-section's radius at the ship's angle (1 = round tunnel). */
  update(theta: number, angVel: number, baseSpeed: number, overdrive: boolean, dt: number, shakeScale: number, fovBoost = 0, xsK = 1): void {
    this.time += dt;
    if (this.flipP !== this.flipTarget) {
      const step = dt / FLIP_ROLL_TIME;
      this.flipP = this.flipP < this.flipTarget ? Math.min(this.flipTarget, this.flipP + step) : Math.max(this.flipTarget, this.flipP - step);
    }
    const roll = this.flipRoll;
    this.ang += angDiff(this.ang, theta) * (1 - Math.exp(-dt * 11));
    const tiltTarget = Math.max(-1, Math.min(1, angVel / MAX_ANG_VEL)) * CAM_ROLL_MAX * Math.cos(roll);
    this.tilt += (tiltTarget - this.tilt) * (1 - Math.exp(-dt * 6));

    const speedFrac = Math.max(0, Math.min(1, (baseSpeed - SPEED_BASE) / (SPEED_MAX - SPEED_BASE)));
    const fovTarget = (overdrive ? FOV_OVERDRIVE : FOV_MIN + (FOV_MAX - FOV_MIN) * speedFrac) + fovBoost;
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-dt / 0.1));
    this.fovKickV *= Math.exp(-dt * 3.5);
    const fovNow = Math.min(FOV_HARD_MAX, this.fov + this.fovKickV + this.fovOffset);
    if (Math.abs(this.camera.fov - fovNow) > 0.02) {
      this.camera.fov = fovNow;
      this.camera.updateProjectionMatrix();
    }

    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const shake = this.trauma * this.trauma * shakeScale;
    const t = this.time * 38;
    const sx = (Math.sin(t * 1.13) + Math.sin(t * 2.31 + 1.7) * 0.5) * 0.45 * shake;
    const sy = (Math.sin(t * 1.71 + 3.1) + Math.sin(t * 2.93) * 0.5) * 0.45 * shake;
    const sr = Math.sin(t * 1.37 + 0.5) * 0.09 * shake;

    // constant speed-proportional rumble (separate from event shake)
    const rum = (0.01 + 0.03 * speedFrac) * (overdrive ? 1.6 : 1) * shakeScale * this.rumbleBoost;
    const rt = this.time * 173;
    const rx = (Math.sin(rt) + Math.sin(rt * 1.7 + 1.1) * 0.6) * rum;
    const ry = (Math.sin(rt * 1.3 + 2.0) + Math.sin(rt * 2.1) * 0.6) * rum;

    const c = Math.cos(this.ang);
    const s = Math.sin(this.ang);
    this.camera.position.set(c * CAM_RADIUS * xsK, s * CAM_RADIUS * xsK, this.camZ);
    this.camera.up.set(-c, -s, 0);
    this.camera.lookAt(this.target);
    this.camera.translateX(sx + rx);
    this.camera.translateY(sy + ry);
    this.camera.rotateZ(this.tilt + sr + roll);
  }
}
