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
import { ClutchArrow, GhostShip, TimingRing } from './beatfx';
import { CameraRig } from './cameraRig';
import { PickupRings, ShieldBubble, shockRadius } from './fx';
import { ITEM_COLORS, ItemView } from './items';
import {
  NORMAL_BG,
  NORMAL_EDGE_GAIN,
  RANK_COLORS,
  ZONE_BG,
  ZONE_EDGE_GAIN,
  ZONE_OBSTACLE_EDGE,
  ZONE_OBSTACLE_FILL,
  hsl,
  zoneFadeStep,
} from './palette';
import { ObstacleView } from './obstacles';
import { Debris, SpeedLines } from './particles';
import { PostFx } from './post';
import { settingsFor } from './quality';
import type { QualitySettings } from './quality';
import { Ship } from './ship';
import { Tunnel } from './tunnel';
import { Afterimages, RibbonField } from './zonefx';

export interface ViewState {
  /** 0.3 when reduced-flash is on, else 1 */
  flashScale: number;
  /** beat pulse 0..1 from the sim's beat clock (strong on the downbeat, weak on the offbeat) */
  beat: number;
  /** ghost of the best run (null = none) */
  ghost: { visible: boolean; theta: number; z: number } | null;
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
  private readonly ghost = new GhostShip();
  private readonly clutchArrow = new ClutchArrow();
  private readonly timingRing = new TimingRing();
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
  /** adaptive quality (DESIGN 17.6) */
  readonly quality: QualitySettings = settingsFor(0, { tier: 0, dprCap: 2, bloomHalf: false, blurTaps: 10, particleScale: 1, ribbonScale: 1, afterimages: 3, grainScale: 1 });
  // ---- style rank + ZONE (DESIGN 18.3) ----
  private readonly ribbons = new RibbonField();
  private readonly after = new Afterimages();
  private zoneAmt = 0;
  private lastBar = -1;
  private readonly bgNormal = new THREE.Color(NORMAL_BG);
  private readonly bgZone = new THREE.Color(ZONE_BG);
  private readonly obsEdge = new THREE.Color();
  private readonly obsFill = new THREE.Color();
  private readonly zoneEdge = new THREE.Color(ZONE_OBSTACLE_EDGE);
  private readonly zoneFill = new THREE.Color(ZONE_OBSTACLE_FILL);
  private readonly rgbTmp = [0, 0, 0];
  private readonly bg = new THREE.Color(NORMAL_BG);
  private readonly box = new THREE.Box3();
  private readonly corner = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this.pixelRatio());
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
    this.scene.add(this.tunnel.group, this.obstacles.group, this.items.group, this.ship.group, this.lines.object, this.debris.mesh, this.rings.group, this.ghost.group, this.clutchArrow.group, this.timingRing.mesh, this.ribbons.mesh, this.after.group);
    this.post = new PostFx(this.renderer, this.scene, this.rig.camera);
    this.resize();
  }

  /** Device pixel ratio capped by the current quality tier (the cap is 2 at full quality, as before). */
  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.quality.dprCap);
  }

  /** Apply quality tier `tier` (0 = full): DPR cap, bloom resolution, blur taps, particle counts. */
  setQuality(tier: number): void {
    settingsFor(tier, this.quality);
    const q = this.quality;
    this.post.setQuality(q.bloomHalf, q.blurTaps);
    this.lines.scale = q.particleScale;
    this.debris.scale = q.particleScale;
    this.ribbons.scale = q.ribbonScale;
    this.after.count = q.afterimages;
    this.post.grain = q.grainScale;
    this.resize();
  }

  /** Re-fit when the window size changed without a resize event (iOS toolbar / rotation quirks). */
  checkSize(): void {
    if (window.innerWidth !== this.width || window.innerHeight !== this.height) this.resize();
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio());
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
    this.ghost.update(false, 0, 0, 0, 1);
    this.timingRing.hide();
    this.after.clear();
    this.zoneAmt = 0;
    this.lastBar = -1;
    this.post.desat = 0;
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
      case 'beatStreak':
        this.shipPos(state);
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0x7df9ff), 4.5, 0.5);
        this.post.addSpike(0.006 * f);
        break;
      case 'clutchStart':
        this.rig.addTrauma(0.3);
        this.post.addSpike(0.01 * f);
        this.rig.fovKick(-6 * (0.4 + 0.6 * f));
        break;
      case 'clutchSuccess':
        this.shipPos(state);
        this.rig.addTrauma(0.9);
        this.post.addSpike(0.02 * f);
        this.rig.fovKick(14 * (0.4 + 0.6 * f));
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0xff3b4e), 7, 0.6);
        this.burst(state, 80, 14, 1.0, 0.3);
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
      case 'rankUp': {
        this.shipPos(state);
        const c = this.tmpColor.setHex(RANK_COLORS[e.rank]);
        // rings stay small and see-through: they are around the ship, close to the camera, and must not hide obstacles
        this.rings.emit(this.px, this.py, c, 3.5 + e.rank * 0.35, 0.45, 0.6);
        if (e.rank >= 5) this.rings.emit(this.px, this.py, c, 6, 0.6, 0.4);
        this.debris.emit(this.px, this.py, 0, 14 + e.rank * 6, 9 + e.rank, 0.7, 0.13, c.r, c.g, c.b, state.speed * 0.4);
        this.rig.addTrauma(0.12 + e.rank * 0.05);
        // the chromatic-aberration flash of the new letter also shakes the whole picture a little
        this.post.addSpike((0.005 + e.rank * 0.0018) * f);
        this.rig.fovKick((1.5 + e.rank * 0.8) * (0.4 + 0.6 * f));
        break;
      }
      case 'rankDown':
        this.post.desat = 0.9;
        this.rig.addTrauma(0.25);
        this.post.addSpike(0.004 * f);
        break;
      case 'zoneEnter': {
        this.shipPos(state);
        this.triggerShock(0xffe9a8, 0.8, 1.8);
        const c = this.tmpColor;
        for (let i = 0; i < 3; i++) {
          hsl(i / 3, 1, 0.6, this.rgbTmp);
          c.setRGB(this.rgbTmp[0], this.rgbTmp[1], this.rgbTmp[2]);
          this.rings.emit(this.px, this.py, c, 3.5 + i * 1.6, 0.45 + i * 0.15, 0.5);
          this.debris.emit(this.px, this.py, 0, 22, 12 + i * 3, 0.9, 0.14, this.rgbTmp[0], this.rgbTmp[1], this.rgbTmp[2], state.speed * 0.45);
        }
        this.rig.addTrauma(0.95);
        this.post.addSpike(0.02 * f);
        this.rig.fovKick(14 * (0.4 + 0.6 * f));
        this.blurKick = 0.5 * f;
        break;
      }
      case 'zoneLevel':
        this.shipPos(state);
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0xffe9a8), 5, 0.5, 0.5);
        this.rig.addTrauma(0.35);
        this.post.addSpike(0.008 * f);
        this.rig.fovKick(6 * (0.4 + 0.6 * f));
        break;
      case 'zoneClear':
        this.shipPos(state);
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0xffe9a8), 6, 0.6, 0.5);
        this.debris.emit(this.px, this.py, 0, 60, 14, 1.0, 0.14, 1, 0.85, 0.3, state.speed * 0.45);
        this.rig.addTrauma(0.5);
        this.post.addSpike(0.012 * f);
        break;
      case 'zoneBreak':
        this.shipPos(state);
        this.rings.emit(this.px, this.py, this.tmpColor.setHex(0xff2030), 5.5, 0.5, 0.5);
        this.debris.emit(this.px, this.py, 0, 50, 15, 0.9, 0.14, 1, 0.15, 0.2, state.speed * 0.4);
        this.post.desat = 1;
        this.rig.addTrauma(0.8);
        this.post.addSpike(0.016 * f);
        break;
      case 'scoreMilestone':
        this.triggerShock(0xffee66, 0.4, 1.2);
        this.rig.fovKick(8 * (0.4 + 0.6 * f));
        this.rig.addTrauma(0.3);
        this.post.addSpike(0.008 * f);
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

  private updateBeatFx(state: GameState, view: ViewState, realDt: number): void {
    // timing ring on the next obstacle (only while the grid holds: boosts shift the arrival times)
    let next = null as GameState['obstacles'][number] | null;
    const obs = state.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.z < 0 && (next === null || o.z > next.z)) next = o;
    }
    if (next && state.alive && !state.overdrive && state.nitroT <= 0) {
      this.timingRing.update(next.beat - state.beatPos, next.z, this.edge, true);
    } else this.timingRing.hide();
    const g = view.ghost;
    if (g) this.ghost.update(g.visible && state.alive, g.theta, g.z, 0, realDt);
    else this.ghost.update(false, 0, 0, 0, realDt);
    this.clutchArrow.update(state.clutch.active && state.alive, state.clutch.dir, state.theta, realDt);
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

  /** Largest on-screen extent of the ship body as a fraction of the short screen side (debug / layout test). */
  shipScreenFraction(): number {
    this.ship.group.updateMatrixWorld(true);
    this.rig.camera.updateMatrixWorld(true);
    this.box.setFromObject(this.ship.body);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.corner.set(i & 1 ? this.box.max.x : this.box.min.x, i & 2 ? this.box.max.y : this.box.min.y, i & 4 ? this.box.max.z : this.box.min.z);
      this.corner.project(this.rig.camera);
      const x = (this.corner.x * 0.5 + 0.5) * this.width;
      const y = (-this.corner.y * 0.5 + 0.5) * this.height;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return Math.max(maxX - minX, maxY - minY) / Math.min(this.width, this.height);
  }

  /** ZONE palette blend 0..1 (debug / tests). */
  get zoneAmount(): number {
    return this.zoneAmt;
  }

  get speedBlurScale(): number {
    return this.blurKick;
  }

  get focusAmount(): number {
    return this.focusAmt;
  }

  frame(state: GameState, realDt: number, view: ViewState): void {
    this.checkSize();
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
    this.focusAmt += ((state.focusActive || state.clutch.active ? 1 : 0) - this.focusAmt) * (1 - Math.exp(-realDt * 9));
    this.nitroAmt += ((state.nitroT > 0 && state.alive ? 1 : 0) - this.nitroAmt) * (1 - Math.exp(-realDt * 8));

    // ---- style rank / ZONE world changes (DESIGN 18.3) ----
    const rank = state.alive ? state.style.rank : 0;
    const zoneOn = state.alive && state.zone.active;
    // the palette snaps over ~0.12 s, or fades over 0.5 s in reduced-flash mode
    const zStep = zoneFadeStep(realDt, view.flashScale < 1);
    this.zoneAmt = zoneOn ? Math.min(1, this.zoneAmt + zStep) : Math.max(0, this.zoneAmt - zStep);
    const zone = this.zoneAmt;
    this.bg.copy(this.bgNormal).lerp(this.bgZone, zone);
    (this.scene.background as THREE.Color).copy(this.bg);
    (this.scene.fog as THREE.Fog).color.copy(this.bg);
    bendUniforms.uZone.value = zone;
    bendUniforms.uZoneHue.value = state.beatPos * 0.0625 + this.time * 0.04;
    // A and above light the tunnel lines up
    const lineBright = 1 + Math.max(0, rank - 2) * 0.12;
    this.obsEdge.copy(this.edge).lerp(this.zoneEdge, zone);
    this.obsFill.copy(this.secondary).lerp(this.zoneFill, zone);

    bendUniforms.uBendTime.value = this.time;
    this.tunnel.update(state.dist, this.primary, this.secondary, view.beat, speedFrac, lineBright, zone);
    this.obstacles.sync(state, this.obsEdge, this.obsFill, view.beat, NORMAL_EDGE_GAIN + (ZONE_EDGE_GAIN - NORMAL_EDGE_GAIN) * zone);
    this.ribbons.update(realDt, this.time, state.dist, zone, state.zone.lv, view.beat, view.flashScale);
    this.after.update(realDt, state.theta, state.angVel, state.alive ? zone : 0, view.flashScale);
    this.items.sync(state, this.edge, sdt);
    this.bubble.update(state.shield && state.alive, realDt);
    this.updateBeatFx(state, view, realDt);
    this.rings.update(realDt);
    this.lines.update(sdt, state.speed, speedFrac, state.overdrive, this.edge, rank >= 4 ? 2 : 1);

    if (state.alive) {
      this.ship.update(state.theta, state.angVel, realDt, this.edge, state.overdrive || this.nitroAmt > 0.5, speedFrac + this.nitroAmt * 0.3, state.overdrive || this.nitroAmt > 0.5);
      // thrust sparks
      const x = Math.cos(state.theta) * SHIP_RADIUS;
      const y = Math.sin(state.theta) * SHIP_RADIUS;
      this.debris.emit(x, y, 0.8, 1, 1.5, 0.28, 0.13, this.primary.r, this.primary.g, this.primary.b, state.speed * 0.55);
      if (zone > 0.5) {
        // rainbow aura trail
        hsl((this.time * 0.7) % 1, 1, 0.6, this.rgbTmp);
        this.debris.emit(x, y, 0.4, 2, 2.4, 0.5, 0.2, this.rgbTmp[0], this.rgbTmp[1], this.rgbTmp[2], state.speed * 0.5);
      }
    }
    this.debris.update(state.alive ? sdt : realDt * 0.3);

    // ZONE: FOV +8 deg and a small kick at every bar line; SS and above rattle the camera more
    const bar = Math.floor(state.beatPos / 4);
    if (zoneOn && this.lastBar >= 0 && bar !== this.lastBar) this.rig.fovKick(2.5 * (0.4 + 0.6 * view.flashScale));
    this.lastBar = bar;
    this.rig.rumbleBoost = 1 + (rank >= 5 ? 0.7 : 0) + (rank >= 6 ? 0.6 : 0) + zone * 0.5;
    this.rig.update(state.theta, state.angVel, state.baseSpeed, state.overdrive, realDt, view.flashScale, this.nitroAmt * 12 * (0.5 + 0.5 * view.flashScale) + zone * 8);
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
    this.post.zone = zone;
    this.post.zonePulse = view.beat;
    hsl((this.time * 0.25) % 1, 1, 0.55, this.rgbTmp);
    this.post.setZoneTint(this.rgbTmp[0], this.rgbTmp[1], this.rgbTmp[2]);
    this.post.update(realDt, speedFrac, state.overdrive, this.focusAmt, view.flashScale, this.blurKick + this.nitroAmt * 0.09);
    this.post.render(realDt);
  }
}
