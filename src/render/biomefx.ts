import * as THREE from 'three';
import { TUNNEL_R } from '../game/constants';
import { XS_GLSL, applyBend, bendUniforms } from './bend';
import type { ParticleKind } from './biome';

const GATE_SEGS = 72;

/**
 * Warp gate (DESIGN 20.1): a glowing ring set that rushes at the ship in the second before a tier-up. It is one pooled object:
 * a see-through band plus two outlines and a trailing ghost ring, all bent and cross-sectioned by the shared vertex patch.
 */
export class WarpGate {
  readonly group = new THREE.Group();
  private readonly band: THREE.Mesh;
  private readonly bandMat: THREE.MeshBasicMaterial;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly ghost: THREE.LineLoop;
  private readonly ghostMat: THREE.LineBasicMaterial;
  private readonly lines: THREE.LineLoop[] = [];

  constructor() {
    this.bandMat = applyBend(
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.band = new THREE.Mesh(new THREE.RingGeometry(TUNNEL_R - 1.5, TUNNEL_R - 0.05, GATE_SEGS, 1), this.bandMat);
    this.band.frustumCulled = false;
    this.lineMat = applyBend(new THREE.LineBasicMaterial({ color: 0xffffff, fog: false }));
    this.ghostMat = applyBend(new THREE.LineBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    const circle = (r: number): THREE.BufferGeometry => {
      const p = new Float32Array(GATE_SEGS * 3);
      for (let i = 0; i < GATE_SEGS; i++) {
        const a = (i / GATE_SEGS) * Math.PI * 2;
        p[i * 3] = Math.cos(a) * r;
        p[i * 3 + 1] = Math.sin(a) * r;
        p[i * 3 + 2] = 0;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      return g;
    };
    for (const r of [TUNNEL_R - 0.05, TUNNEL_R - 1.5]) {
      const l = new THREE.LineLoop(circle(r), this.lineMat);
      l.frustumCulled = false;
      this.lines.push(l);
    }
    this.ghost = new THREE.LineLoop(circle(TUNNEL_R - 0.8), this.ghostMat);
    this.ghost.frustumCulled = false;
    this.group.add(this.band, ...this.lines, this.ghost);
    this.group.visible = false;
  }

  /** `amt` 0 = hidden, 1 = fully shown; `z` the gate's z (negative = ahead); `reduced` softens the strobing. */
  update(amt: number, z: number, color: THREE.Color, time: number, reduced: boolean): void {
    this.group.visible = amt > 0.01;
    if (!this.group.visible) return;
    this.group.position.z = z;
    const pulse = reduced ? 0.85 : 0.75 + 0.25 * Math.sin(time * 40);
    this.bandMat.opacity = 0.42 * amt * pulse;
    this.bandMat.color.copy(color).multiplyScalar(1.6);
    this.lineMat.color.copy(color).lerp(WHITE, 0.6).multiplyScalar(3 * amt);
    this.ghostMat.color.copy(color).multiplyScalar(2 * amt);
    this.ghost.position.z = 3.5 + 2 * Math.sin(time * 9);
    this.ghostMat.opacity = 0.5 * amt;
  }
}

const WHITE = new THREE.Color(0xffffff);

const PARTICLE_COUNT = 420;
const PARTICLE_LEN = 260;

const KIND_ID: Record<ParticleKind, number> = { none: 0, spark: 1, glint: 2, glyph: 3, ember: 4, star: 5 };

const VERT = /* glsl */ `
${XS_GLSL}
attribute vec4 aSeed;
uniform float uDist;
uniform float uTime;
uniform float uKind;
uniform float uSize;
uniform float uPx;
uniform float uAmt;
varying float vA;
varying float vShape;
void main() {
  float len = ${PARTICLE_LEN.toFixed(1)};
  float zf = aSeed.z;
  float kind = uKind;
  float r01 = 0.18 + 0.8 * sqrt(aSeed.x);
  float ang = aSeed.y * 6.28318;
  float alpha = 1.0;
  float size = 1.0;
  float shape = 0.0;
  float fall = 0.0;
  if (kind > 3.5 && kind < 4.5) {            // EMBERS: rise off the walls toward the axis, flicker
    float life = fract(uTime * 0.22 + aSeed.w);
    r01 = mix(0.97, 0.3, life) * (0.75 + 0.25 * aSeed.x);
    alpha = (1.0 - life) * (0.55 + 0.45 * sin(uTime * 23.0 + aSeed.w * 60.0));
    ang += sin(uTime * 1.3 + aSeed.w * 9.0) * 0.25;
    size = 1.0 + 1.6 * (1.0 - life);
  } else if (kind > 1.5 && kind < 2.5) {     // CRYSTAL glints: twinkle in place
    r01 = 0.55 + 0.42 * aSeed.x;
    alpha = pow(0.5 + 0.5 * sin(uTime * 3.1 + aSeed.w * 40.0), 5.0);
    size = 1.0 + 2.2 * alpha;
  } else if (kind > 2.5 && kind < 3.5) {     // DATA glyph bits: square, snap on and off, fall along the walls
    r01 = 0.72 + 0.26 * aSeed.x;
    shape = 1.0;
    fall = uTime * 36.0;
    alpha = step(0.45, fract(uTime * 2.2 + aSeed.w * 7.0));
    size = 1.5;
  } else if (kind > 4.5) {                   // VOID star dust: everywhere, tiny, steady with a slow shimmer
    r01 = 0.05 + 0.92 * aSeed.x;
    alpha = 0.55 + 0.45 * sin(uTime * 1.7 + aSeed.w * 30.0);
    size = 0.8;
  } else {
    alpha = 0.0;
  }
  float z = -len + mod(uDist + zf * len + fall, len);
  vec2 xy = vec2(cos(ang), sin(ang)) * r01 * ${(TUNNEL_R - 0.5).toFixed(2)};
  float xl = length(xy);
  if (xl > 1e-4) xy *= xsScale(xy / xl);
  xy += bendOffset(z);
  vec4 mv = viewMatrix * vec4(xy, z, 1.0);
  gl_Position = projectionMatrix * mv;
  float fog = smoothstep(len, len * 0.45, -z) * smoothstep(0.0, 10.0, -z);
  vA = alpha * fog * uAmt;
  vShape = shape;
  gl_PointSize = clamp(uSize * size * uPx * 22.0 / max(1.0, -mv.z), 1.0, 12.0 * uPx);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
varying float vShape;
void main() {
  if (vA < 0.01) discard;
  vec2 c = gl_PointCoord - 0.5;
  float d = vShape > 0.5 ? max(abs(c.x), abs(c.y)) * 1.6 : length(c) * 2.0;
  float a = (1.0 - smoothstep(0.55, 1.0, d)) * vA;
  gl_FragColor = vec4(uColor * (1.2 + a), a);
}
`;

/**
 * Ambient particles of the current biome (DESIGN 20.1): embers, crystal glints, data bits, star dust. One pooled Points object,
 * moved entirely in the vertex shader (no per-frame JS work); `scale` is the adaptive-quality particle factor.
 */
export class BiomeParticles {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo = new THREE.BufferGeometry();
  private kind: ParticleKind = 'none';
  scale = 1;

  constructor() {
    const seeds = new Float32Array(PARTICLE_COUNT * 4);
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    let s = 12345;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uBendTime: bendUniforms.uBendTime,
        uBendAmp: bendUniforms.uBendAmp,
        uXsEdgesA: bendUniforms.uXsEdgesA,
        uXsNA: bendUniforms.uXsNA,
        uXsRA: bendUniforms.uXsRA,
        uXsEdgesB: bendUniforms.uXsEdgesB,
        uXsNB: bendUniforms.uXsNB,
        uXsRB: bendUniforms.uXsRB,
        uXsMix: bendUniforms.uXsMix,
        uDist: { value: 0 },
        uTime: { value: 0 },
        uKind: { value: 0 },
        uSize: { value: 1 },
        uPx: { value: 1 },
        uAmt: { value: 0 },
        uColor: { value: new THREE.Color(0xffffff) },
      },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  setPixelRatio(px: number): void {
    this.mat.uniforms.uPx.value = px;
  }

  setKind(kind: ParticleKind, color: number): void {
    this.kind = kind;
    this.mat.uniforms.uKind.value = KIND_ID[kind];
    (this.mat.uniforms.uColor.value as THREE.Color).setHex(color);
  }

  get currentKind(): ParticleKind {
    return this.kind;
  }

  update(dist: number, time: number, amt: number): void {
    const n = Math.max(0, Math.round(PARTICLE_COUNT * this.scale));
    this.geo.setDrawRange(0, n);
    this.points.visible = amt > 0.01 && this.kind !== 'none';
    this.mat.uniforms.uDist.value = dist;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uAmt.value = amt;
  }
}
