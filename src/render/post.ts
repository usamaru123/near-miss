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
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 d = (uv - center);
  float len = length(d);
  // blur grows toward the screen edges, vanishing point stays sharp
  vec2 dir = d * strength * smoothstep(0.02, 0.6, len);
  vec3 acc = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 10; i++) {
    float t = float(i) / 10.0;
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
      ]),
    });
  }
  set strength(v: number) {
    (this.uniforms.get('strength') as THREE.Uniform<number>).value = v;
  }
  setCenter(x: number, y: number): void {
    (this.uniforms.get('center') as THREE.Uniform<THREE.Vector2>).value.set(x, y);
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
  private spike = 0;

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
    this.composer.addPass(new EffectPass(camera, this.chroma, this.sat, this.vignette, this.noise));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  addSpike(v: number): void {
    this.spike = Math.min(0.02, this.spike + v);
  }

  setBlurCenter(x: number, y: number): void {
    this.blur.setCenter(x, y);
  }

  update(dt: number, speedFrac: number, overdrive: boolean, focus: number, flashScale: number, kick = 0): void {
    this.blur.strength = (0.03 + speedFrac * 0.11 + (overdrive ? 0.1 : 0) + kick) * (0.6 + 0.4 * flashScale);
    this.spike *= Math.exp(-dt * 7);
    const base = overdrive ? 0.0042 : 0.0004 + speedFrac * 0.0008;
    const ca = (base + this.spike) * (overdrive ? flashScale * 0.5 + 0.5 : 1);
    this.chroma.offset.set(ca, ca * 0.8);
    this.bloom.intensity = (overdrive ? 2.2 : 1.4 + speedFrac * 0.5) * (0.8 + 0.2 * flashScale);
    this.sat.saturation = -0.6 * focus;
    this.vignette.darkness = 0.55 + 0.35 * focus + 0.15 * speedFrac;
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
