import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  RenderPass,
  VignetteEffect,
} from 'postprocessing';

const RADIAL_FRAG = /* glsl */ `
uniform float strength;
uniform vec2 center;
uniform float taps;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 d = (uv - center);
  float len = length(d);
  // blur grows toward the screen edges, vanishing point stays sharp
  vec2 dir = d * strength * smoothstep(0.02, 0.6, len);
  vec3 acc = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 10; i++) {
    if (float(i) >= taps) break;
    float t = float(i) / taps;
    float w = 1.0 - t * 0.7;
    acc += texture2D(inputBuffer, uv - dir * t).rgb * w;
    total += w;
  }
  outputColor = vec4(acc / total, inputColor.a);
}
`;

/** Radial zoom blur centred on the vanishing point. */
export class RadialBlurEffect extends Effect {
  constructor() {
    super('RadialBlurEffect', RADIAL_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['strength', new THREE.Uniform(0)],
        ['center', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['taps', new THREE.Uniform(10)],
      ]),
    });
  }
  set strength(v: number) {
    (this.uniforms.get('strength') as THREE.Uniform<number>).value = v;
  }
  /** Number of samples along the blur direction (1..10). */
  set taps(v: number) {
    (this.uniforms.get('taps') as THREE.Uniform<number>).value = v;
  }
  setCenter(x: number, y: number): void {
    (this.uniforms.get('center') as THREE.Uniform<THREE.Vector2>).value.set(x, y);
  }
}

const ZONE_FRAG = /* glsl */ `
uniform float amount;
uniform vec3 tint;
uniform float pulse;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // coloured vignette: only the screen edges are tinted, the centre (obstacles appear there) is untouched
  float r = length(uv - 0.5) * 1.4142;
  float v = smoothstep(0.5, 1.05, r);
  vec3 c = inputColor.rgb + tint * v * amount * (0.3 + 0.7 * pulse);
  outputColor = vec4(c, inputColor.a);
}
`;

/** ZONE colour vignette: additive tint at the screen edges that pulses with the beat. */
export class ZoneEffect extends Effect {
  constructor() {
    super('ZoneEffect', ZONE_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['amount', new THREE.Uniform(0)],
        ['tint', new THREE.Uniform(new THREE.Color(1, 0.5, 1))],
        ['pulse', new THREE.Uniform(0)],
      ]),
    });
  }
  set(amount: number, pulse: number): void {
    (this.uniforms.get('amount') as THREE.Uniform<number>).value = amount;
    (this.uniforms.get('pulse') as THREE.Uniform<number>).value = pulse;
  }
  setTint(r: number, g: number, b: number): void {
    (this.uniforms.get('tint') as THREE.Uniform<THREE.Color>).value.setRGB(r, g, b);
  }
}

/** Bloom (always), chromatic aberration (spikes / overdrive), vignette, noise, focus desaturation. */
export class PostFx {
  readonly composer: EffectComposer;
  private readonly bloom: BloomEffect;
  private readonly blur = new RadialBlurEffect();
  private readonly chroma: ChromaticAberrationEffect;
  private readonly vignette: VignetteEffect;
  private readonly sat: HueSaturationEffect;
  private readonly noise: NoiseEffect;
  private readonly zoneFx = new ZoneEffect();
  private spike = 0;
  /** ZONE blend 0..1, beat pulse 0..1 (scaled for reduced flash by the caller), grain strength 0..1 */
  zone = 0;
  zonePulse = 0;
  grain = 1;
  /** transient desaturation 0..1 (rank-down, ZONE BREAK) */
  desat = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomEffect({
      intensity: 1.5,
      luminanceThreshold: 0.35,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
      radius: 0.75,
    });
    this.chroma = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0005, 0.0005),
      radialModulation: true,
      modulationOffset: 0.2,
    });
    this.vignette = new VignetteEffect({ offset: 0.3, darkness: 0.55 });
    this.sat = new HueSaturationEffect({ saturation: 0, hue: 0 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    this.noise.blendMode.opacity.value = 0.07;
    this.composer.addPass(new EffectPass(camera, this.bloom));
    this.composer.addPass(new EffectPass(camera, this.blur));
    this.composer.addPass(new EffectPass(camera, this.chroma, this.sat, this.vignette, this.zoneFx, this.noise));
  }

  private w = 1;
  private h = 1;

  setSize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.composer.setSize(w, h, false);
  }

  /** Adaptive quality (DESIGN 17.6): half-resolution bloom and fewer radial-blur taps. */
  setQuality(bloomHalf: boolean, blurTaps: number): void {
    this.blur.taps = blurTaps;
    const res = (this.bloom.mipmapBlurPass as unknown as { resolution: { scale: number } }).resolution;
    const scale = bloomHalf ? 0.5 : 1;
    if (res.scale !== scale) {
      res.scale = scale;
      this.composer.setSize(this.w, this.h, false);
    }
  }

  addSpike(v: number): void {
    this.spike = Math.min(0.02, this.spike + v);
  }

  setZoneTint(r: number, g: number, b: number): void {
    this.zoneFx.setTint(r, g, b);
  }

  setBlurCenter(x: number, y: number): void {
    this.blur.setCenter(x, y);
  }

  update(dt: number, speedFrac: number, overdrive: boolean, focus: number, flashScale: number, kick = 0): void {
    // ZONE: stronger radial blur, per-beat chromatic pulse (30 % in reduced-flash mode), film grain, coloured vignette
    this.blur.strength = (0.03 + speedFrac * 0.11 + (overdrive ? 0.1 : 0) + kick + this.zone * 0.07) * (0.6 + 0.4 * flashScale);
    this.spike *= Math.exp(-dt * 7);
    this.desat *= Math.exp(-dt * 6);
    const base = overdrive ? 0.0042 : 0.0004 + speedFrac * 0.0008;
    const zoneCa = this.zone * this.zonePulse * 0.0032 * flashScale;
    const ca = (base + this.spike) * (overdrive ? flashScale * 0.5 + 0.5 : 1) + zoneCa;
    this.chroma.offset.set(ca, ca * 0.8);
    this.bloom.intensity = (overdrive ? 2.2 : 1.4 + speedFrac * 0.5) * (0.8 + 0.2 * flashScale);
    this.sat.saturation = Math.max(-0.95, -0.6 * focus - this.desat * flashScale) + this.zone * 0.12;
    this.noise.blendMode.opacity.value = 0.07 + this.zone * 0.17 * this.grain * (0.4 + 0.6 * flashScale);
    this.zoneFx.set(this.zone, this.zonePulse);
    this.vignette.darkness = 0.55 + 0.35 * focus + 0.15 * speedFrac;
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
