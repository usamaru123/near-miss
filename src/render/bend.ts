import * as THREE from 'three';
import { XS_MAX_EDGES } from './biome';

/** Shared uniforms for the visual-only tunnel bend and cross-section (sim stays straight and round). */
export const bendUniforms = {
  uBendTime: { value: 0 },
  uBendAmp: { value: 1 },
  /** ZONE palette blend 0..1 and the hue offset of the flowing rainbow (tunnel materials only) */
  uZone: { value: 0 },
  uZoneHue: { value: 0 },
  /**
   * Cross-section (DESIGN 20.1, visual only): two shapes and the morph between them. A shape is either a circle of
   * relative radius uXsR* (n = 0) or a convex polygon given as n half-planes (nx, ny, d).
   */
  uXsEdgesA: { value: new Float32Array(XS_MAX_EDGES * 3) },
  uXsNA: { value: 0 },
  uXsRA: { value: 1 },
  uXsEdgesB: { value: new Float32Array(XS_MAX_EDGES * 3) },
  uXsNB: { value: 0 },
  uXsRB: { value: 1 },
  uXsMix: { value: 0 },
  /** Obstacle fill style (biome look) and the tunnel line dash amount. */
  uObsStyle: { value: 0 },
  uDash: { value: 0 },
};

const GLSL = /* glsl */ `
uniform float uBendTime;
uniform float uBendAmp;
uniform vec3 uXsEdgesA[${XS_MAX_EDGES}];
uniform float uXsNA;
uniform float uXsRA;
uniform vec3 uXsEdgesB[${XS_MAX_EDGES}];
uniform float uXsNB;
uniform float uXsRB;
uniform float uXsMix;
vec2 bendOffset(float z) {
  float d = max(0.0, -z - 12.0);
  float w = smoothstep(0.0, 190.0, d);
  w *= w;
  float ph = d * 0.011;
  float x = sin(uBendTime * 0.23 + ph) * 15.0 + sin(uBendTime * 0.11 + ph * 1.9 + 1.3) * 9.0;
  float y = sin(uBendTime * 0.17 + ph * 1.3 + 2.0) * 8.0;
  return vec2(x, y) * w * uBendAmp;
}
float xsPolyA(vec2 u) {
  float r = 1e6;
  for (int i = 0; i < ${XS_MAX_EDGES}; i++) {
    if (float(i) >= uXsNA) break;
    vec3 e = uXsEdgesA[i];
    float c = e.x * u.x + e.y * u.y;
    if (c > 1e-4) r = min(r, e.z / c);
  }
  return r;
}
float xsPolyB(vec2 u) {
  float r = 1e6;
  for (int i = 0; i < ${XS_MAX_EDGES}; i++) {
    if (float(i) >= uXsNB) break;
    vec3 e = uXsEdgesB[i];
    float c = e.x * u.x + e.y * u.y;
    if (c > 1e-4) r = min(r, e.z / c);
  }
  return r;
}
/** relative radius of the cross-section in the direction u (mirrors xsRadius() in biome.ts) */
float xsScale(vec2 u) {
  float a = uXsNA > 0.5 ? xsPolyA(u) : uXsRA;
  float b = uXsNB > 0.5 ? xsPolyB(u) : uXsRB;
  return mix(a, b, uXsMix);
}
`;

const RAINBOW_FRAG_HEAD = /* glsl */ `
uniform float uZone;
uniform float uZoneHue;
uniform float uDash;
varying float vZoneZ;
`;

const OBSTACLE_FRAG_HEAD = /* glsl */ `
uniform float uObsStyle;
varying vec3 vObsPos;
`;

export interface BendOptions {
  /** tunnel materials: ZONE rainbow + DATA STREAM dashes */
  rainbow?: boolean;
  /** obstacle fills: biome pattern */
  obstacle?: boolean;
}

/** Patch a built-in material so its vertices bend with distance and follow the cross-section. Zero bend near the player. */
export function applyBend<T extends THREE.Material>(mat: T, opts: boolean | BendOptions = false): T {
  const o: BendOptions = typeof opts === 'boolean' ? { rainbow: opts } : opts;
  const rainbow = !!o.rainbow;
  const obstacle = !!o.obstacle;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBendTime = bendUniforms.uBendTime;
    shader.uniforms.uBendAmp = bendUniforms.uBendAmp;
    shader.uniforms.uXsEdgesA = bendUniforms.uXsEdgesA;
    shader.uniforms.uXsNA = bendUniforms.uXsNA;
    shader.uniforms.uXsRA = bendUniforms.uXsRA;
    shader.uniforms.uXsEdgesB = bendUniforms.uXsEdgesB;
    shader.uniforms.uXsNB = bendUniforms.uXsNB;
    shader.uniforms.uXsRB = bendUniforms.uXsRB;
    shader.uniforms.uXsMix = bendUniforms.uXsMix;
    let frag = shader.fragmentShader;
    if (rainbow || obstacle) frag = 'uniform float uBendTime;\n' + frag;
    if (rainbow) {
      shader.uniforms.uZone = bendUniforms.uZone;
      shader.uniforms.uZoneHue = bendUniforms.uZoneHue;
      shader.uniforms.uDash = bendUniforms.uDash;
      frag = RAINBOW_FRAG_HEAD + frag.replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          if (uDash > 0.0 && fract(vZoneZ * 0.21 - uBendTime * 1.7) > 1.0 - uDash) discard;
          float zl = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
          vec3 rb = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.333, 0.667) + vZoneZ * 0.03 + uZoneHue));
          diffuseColor.rgb = mix(diffuseColor.rgb, rb * zl, uZone);
        }
        `,
      );
    }
    if (obstacle) {
      shader.uniforms.uObsStyle = bendUniforms.uObsStyle;
      frag = OBSTACLE_FRAG_HEAD + frag.replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          float oa = atan(vObsPos.y, vObsPos.x);
          float pat = 1.0;
          if (uObsStyle > 0.5 && uObsStyle < 1.5) pat = 0.7 + 0.5 * abs(fract(oa * 0.9549 + 0.5) - 0.5) * 2.0;            // HEX: faceted bands
          else if (uObsStyle < 2.5 && uObsStyle > 1.5) pat = 0.55 + 0.7 * (0.5 + 0.5 * sin(oa * 9.0 + vObsPos.z * 0.35 + uBendTime * 2.3)); // CRYSTAL: shimmer
          else if (uObsStyle < 3.5 && uObsStyle > 2.5) pat = step(0.45, fract(vObsPos.z * 0.9 - uBendTime * 3.0)) * 0.7 + 0.45;           // DATA: scan lines
          else if (uObsStyle < 4.5 && uObsStyle > 3.5) pat = 0.75 + 0.4 * sin(uBendTime * 17.0 + oa * 5.0 + vObsPos.z * 0.3);            // INFERNO: flicker
          diffuseColor.rgb *= pat;
        }
        `,
      );
    }
    shader.fragmentShader = frag;
    shader.vertexShader =
      (rainbow ? 'varying float vZoneZ;\n' : '') +
      (obstacle ? 'varying vec3 vObsPos;\n' : '') +
      GLSL +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 bendWp = modelMatrix * mvPosition;
      ${obstacle ? 'vObsPos = bendWp.xyz;' : ''}
      float xsLen = length(bendWp.xy);
      if (xsLen > 1e-4) bendWp.xy *= xsScale(bendWp.xy / xsLen);
      bendWp.xy += bendOffset(bendWp.z);
      ${rainbow ? 'vZoneZ = bendWp.z;' : ''}
      mvPosition = viewMatrix * bendWp;
      gl_Position = projectionMatrix * mvPosition;
      `,
      );
  };
  mat.customProgramCacheKey = () => 'bend' + (rainbow ? '-rainbow' : '') + (obstacle ? '-obstacle' : '');
  return mat;
}

/** The cross-section chunk, for hand-written shaders (the ambient particles). */
export const XS_GLSL = GLSL;
