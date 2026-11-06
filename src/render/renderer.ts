import * as THREE from 'three';
import {
  FOG_FAR,
  SHAKE,
  SHIP_RADIUS,
  SPEED_BASE,
  SPEED_MAX,
  TIERS,
} from '../game/constants';
import type { GameEvent, GameState } from '../game/types';
import { bendUniforms } from './bend';
import { CameraRig } from './cameraRig';
import { PickupRings, ShieldBubble, shockRadius } from './fx';
import { ITEM_COLORS, ItemView } from './items';
import { ObstacleView } from './obstacles';
import { Debris, SpeedLines } from './particles';
import { PostFx } from './post';
import { Ship } from './ship';
import { Tunnel } from './tunnel';

export interface ViewState {
  /** 0.3 when reduced-flash is on, else 1 */
  flashScale: number;
  /** beat pulse 0..1 from the music */
  beat: number;
}

const WHITE = new THREE.Color(0xffffff);

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  private readonly post: PostFx;
  private readonly tunnel = new Tunnel();
  private readonly obstacles = new ObstacleView();
  private readonly ship = new Ship();
  private readonly items = new ItemView();
  private readonly bubble = new ShieldBubble();
  private readonly rings = new PickupRings();
  private readonly tmpColor = new THREE.Color();
  private nitroAmt = 0;
  private shockPeak = 0.55;
  private shockBright = 1;
  private readonly lines = new SpeedLines();
  private readonly debris = new Debris();
  private readonly primary = new THREE.Color(0x00f0ff);
  private readonly secondary = new THREE.Color(0xff2bd6);
  private readonly targetP = new THREE.Color();
  private readonly targetS = new THREE.Color();
  private readonly edge = new THREE.Color();
  private readonly proj = new THREE.Vector3();
  private time = 0;
  private focusAmt = 0;
  private width = 1;
  private height = 1;
  private flashScale = 1;
  private readonly shock: THREE.Mesh;
  private readonly shockMat: THREE.MeshBasicMaterial;
  private shockT = 1;
  private blurKick = 0;
  private readonly blurProj = new THREE.Vector3(0, 0, -60);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x02020a, 1);
    this.scene.background = new THREE.Color(0x02020a);
    this.scene.fog = new THREE.Fog(0x02020a, 25, FOG_FAR);
    this.rig = new CameraRig(1);
    this.shockMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.shock = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), this.shockMat);
    this.shock.visible = false;
    this.shock.renderOrder = 10;
    this.rig.camera.add(this.shock);
    this.scene.add(this.rig.camera);
    this.ship.group.add(this.bubble.group);
    this.scene.add(this.tunnel.group, this.obstacles.group, this.items.group, this.ship.group, this.lines.object, this.debris.mesh, this.rings.group);
    this.post = new PostFx(this.renderer, this.scene, this.rig.camera);
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.post.composer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.rig.setAspect(w / h);
  }

  reset(state: GameState): void {
    this.obstacles.clear();
    this.items.clear();
    this.rings.clear();
    this.nitroAmt = 0;
    this.debris.clear();
    this.ship.setVisible(true);
    this.rig.reset(state.theta);
  }

  onEvent(e: GameEvent, state: GameState): void {
    const f = this.flashScale;
    switch (e.type) {
      case 'nearMiss':
        this.rig.addTrauma(SHAKE.nearMiss);
        this.post.addSpike(0.006 * f);
        break;
      case 'insane':
        this.rig.addTrauma(SHAKE.insane);
        this.post.addSpike(0.013 * f);
        break;
      case 'smash':
        this.rig.addTrauma(SHAKE.smash);
        this.post.addSpike(0.008 * f);
        this.burst(state, 46, 16, 0.9, 0.35);
        break;
      case 'tierUp':
        this.rig.addTrauma(SHAKE.tierUp);
        this.post.addSpike(0.01 * f);
        break;
      case 'overdriveStart':
        this.rig.addTrauma(0.35);
        this.post.addSpike(0.016 * f);
        break;
      case 'shard': {
        this.shipPos(state);
        this.tmpColor.copy(this.edge);
        this.rings.emit(this.px, this.py, this.tmpColor, 1.6, 0.28);
        this.debris.emit(this.px, this.py, 0, 6, 5, 0.35, 0.12, this.edge.r, this.edge.g, this.edge.b, state.speed * 0.4);
        break;
      }
      case 'perfectChain':
        this.shipPos(state);
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0xffee66), 5.5, 0.7);
        this.debris.emit(this.px, this.py, 0, 40, 10, 0.8, 0.22, 1, 0.9, 0.3, state.speed * 0.4);
        this.post.addSpike(0.008 * f);
        break;
      case 'powerup': {
        this.shipPos(state);
        const c = this.tmpColor.setHex(ITEM_COLORS[e.kind]);
        this.rings.emit(this.px, this.py, c, 4.5, 0.55);
        this.rings.emit(this.px, this.py, c, 7.5, 0.8);
        this.debris.emit(this.px, this.py, 0, 50, 12, 0.9, 0.24, c.r, c.g, c.b, state.speed * 0.4);
        this.rig.addTrauma(e.kind === 'EMP' ? 0.9 : 0.25);
        this.post.addSpike((e.kind === 'EMP' ? 0.018 : 0.01) * f);
        if (e.kind === 'NITRO') this.rig.fovKick(9 * (0.4 + 0.6 * f));
        if (e.kind === 'EMP') this.triggerShock(0xff4a5a, 0.9, 1.4);
        break;
      }
      case 'shieldBreak':
        this.shipPos(state);
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0x66b4ff), 6, 0.5);
        this.debris.emit(this.px, this.py, 0, 70, 15, 0.9, 0.22, 0.4, 0.75, 1, state.speed * 0.4);
        this.debris.emit(this.px, this.py, 0, 22, 9, 0.7, 0.3, 1, 1, 1, state.speed * 0.4);
        this.rig.addTrauma(0.4);
        this.post.addSpike(0.012 * f);
        break;
      case 'emp':
        this.rig.addTrauma(0.8);
        break;
      case 'death':
        this.rig.addTrauma(SHAKE.death);
        this.post.addSpike(0.02 * f);
        this.burst(state, 130, 11, 3.2, 0.4);
        this.ship.setVisible(false);
        break;
      default:
        break;
    }
  }

  /** Launch punch (countdown GO / retry). */
  launch(): void {
    this.rig.launch(0.5 + 0.5 * this.flashScale);
    this.blurKick = 0.35 * this.flashScale;
    this.post.addSpike(0.012 * this.flashScale);
  }

  /** Speed milestone: expanding shockwave ring from screen center + FOV punch. */
  milestone(): void {
    this.triggerShock(0xffffff, 0.45, 0.6);
    this.rig.fovKick(16 * (0.4 + 0.6 * this.flashScale));
    this.rig.addTrauma(0.5);
    this.blurKick = 0.3 * this.flashScale;
    this.post.addSpike(0.015 * this.flashScale);
  }

  private px = 0;
  private py = 0;
  private shipPos(state: GameState): void {
    this.px = Math.cos(state.theta) * SHIP_RADIUS;
    this.py = Math.sin(state.theta) * SHIP_RADIUS;
  }

  /** Expanding screen ring; always begins outside the central no-go circle and is transparent in the middle. */
  private triggerShock(hex: number, peak: number, bright: number): void {
    this.shockT = 0;
    this.shock.visible = true;
    this.shockPeak = peak;
    this.shockBright = bright;
    this.shockMat.color.setHex(hex);
    this.shockHex = hex;
  }
  private shockHex = 0xffffff;

  private burst(state: GameState, n: number, speed: number, life: number, size: number): void {
    const x = Math.cos(state.theta) * SHIP_RADIUS;
    const y = Math.sin(state.theta) * SHIP_RADIUS;
    this.debris.emit(x, y, 0, n, speed, life, size, this.primary.r, this.primary.g, this.primary.b, state.speed * 0.5);
    this.debris.emit(x, y, 0, Math.floor(n / 3), speed * 1.4, life * 0.7, size * 0.6, 1, 1, 1, state.speed * 0.5);
  }

  /** Ship position on screen in CSS pixels. */
  shipScreen(out: { x: number; y: number }): void {
    this.proj.copy(this.ship.group.position).project(this.rig.camera);
    out.x = (this.proj.x * 0.5 + 0.5) * this.width;
    out.y = (-this.proj.y * 0.5 + 0.5) * this.height;
  }

  get speedBlurScale(): number {
    return this.blurKick;
  }

  get focusAmount(): number {
    return this.focusAmt;
  }

  frame(state: GameState, realDt: number, view: ViewState): void {
    this.time += realDt;
    this.flashScale = view.flashScale;
    const sdt = realDt * state.timeScale;
    const speedFrac = Math.max(0, Math.min(1, (state.baseSpeed - SPEED_BASE) / (SPEED_MAX - SPEED_BASE)));

    // palette
    if (state.overdrive) {
      this.targetP.setHex(0xff1030);
      this.targetS.setHex(0xffffff);
    } else {
      const tier = TIERS[state.tier - 1];
      if (tier.rainbow) {
        this.targetP.setHSL((this.time * 0.12) % 1, 1, 0.55);
        this.targetS.setHSL((this.time * 0.12 + 0.5) % 1, 1, 0.55);
      } else {
        this.targetP.setHex(tier.primary);
        this.targetS.setHex(tier.secondary);
      }
    }
    const k = 1 - Math.exp(-realDt * 7);
    this.primary.lerp(this.targetP, k);
    this.secondary.lerp(this.targetS, k);
    this.edge.copy(this.primary).lerp(WHITE, 0.5);

    // focus amount (eased)
    this.focusAmt += ((state.focusActive ? 1 : 0) - this.focusAmt) * (1 - Math.exp(-realDt * 9));
    this.nitroAmt += ((state.nitroT > 0 && state.alive ? 1 : 0) - this.nitroAmt) * (1 - Math.exp(-realDt * 8));

    bendUniforms.uBendTime.value = this.time;
    this.tunnel.update(state.dist, this.primary, this.secondary, view.beat, speedFrac);
    this.obstacles.sync(state, this.edge, this.secondary);
    this.items.sync(state, this.edge, sdt);
    this.bubble.update(state.shield && state.alive, realDt);
    this.rings.update(realDt);
    this.lines.update(sdt, state.speed, speedFrac, state.overdrive, this.edge);

    if (state.alive) {
      this.ship.update(state.theta, state.angVel, realDt, this.edge, state.overdrive || this.nitroAmt > 0.5, speedFrac + this.nitroAmt * 0.3, state.overdrive || this.nitroAmt > 0.5);
      // thrust sparks
      const x = Math.cos(state.theta) * SHIP_RADIUS;
      const y = Math.sin(state.theta) * SHIP_RADIUS;
      this.debris.emit(x, y, 0.8, 1, 1.5, 0.28, 0.13, this.primary.r, this.primary.g, this.primary.b, state.speed * 0.55);
    }
    this.debris.update(state.alive ? sdt : realDt * 0.3);

    this.rig.update(state.theta, state.angVel, state.baseSpeed, state.overdrive, realDt, view.flashScale, this.nitroAmt * 12 * (0.5 + 0.5 * view.flashScale));
    // shockwave ring (screen space, radius in half-short-side units; see fx.ts)
    if (this.shockT < 1) {
      this.shockT = Math.min(1, this.shockT + realDt / 0.8);
      const e = 1 - (1 - this.shockT) * (1 - this.shockT);
      const cam = this.rig.camera;
      const hh = 3 * Math.tan((cam.fov * Math.PI) / 360);
      const shortHalf = Math.min(hh, hh * cam.aspect);
      const sc = shockRadius(e) * shortHalf;
      this.shock.scale.set(sc, sc, 1);
      this.shock.position.set(0, 0, -3);
      const fadeIn = Math.min(1, this.shockT / 0.12);
      this.shockMat.opacity = fadeIn * (1 - this.shockT) * this.shockPeak * (0.4 + 0.6 * view.flashScale);
      this.shockMat.color.setHex(this.shockHex).multiplyScalar(this.shockBright);
      if (this.shockT >= 1) this.shock.visible = false;
    }
    this.blurKick *= Math.exp(-realDt * 4);
    this.blurProj.set(0, 0, -60).project(this.rig.camera);
    this.post.setBlurCenter(this.blurProj.x * 0.5 + 0.5, this.blurProj.y * 0.5 + 0.5);
    this.post.update(realDt, speedFrac, state.overdrive, this.focusAmt, view.flashScale, this.blurKick + this.nitroAmt * 0.09);
    this.post.render(realDt);
  }
}
