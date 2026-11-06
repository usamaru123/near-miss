import * as THREE from 'three';

/** Shared uniforms for the visual-only tunnel bend (sim stays straight). */
export const bendUniforms = {
  uBendTime: { value: 0 },
  uBendAmp: { value: 1 },
  /** ZONE palette blend 0..1 and the hue offset of the flowing rainbow (tunnel materials only) */
  uZone: { value: 0 },
  uZoneHue: { value: 0 },
};

const GLSL = /* glsl */ `
uniform float uBendTime;
uniform float uBendAmp;
vec2 bendOffset(float z) {
  float d = max(0.0, -z - 12.0);
  float w = smoothstep(0.0, 190.0, d);
  w *= w;
  float ph = d * 0.011;
  float x = sin(uBendTime * 0.23 + ph) * 15.0 + sin(uBendTime * 0.11 + ph * 1.9 + 1.3) * 9.0;
  float y = sin(uBendTime * 0.17 + ph * 1.3 + 2.0) * 8.0;
  return vec2(x, y) * w * uBendAmp;
}
`;

const RAINBOW_FRAG_HEAD = /* glsl */ `
uniform float uZone;
uniform float uZoneHue;
varying float vZoneZ;
`;

/** Patch a built-in material so its vertices bend with distance. Zero offset near the player. */
export function applyBend<T extends THREE.Material>(mat: T, rainbow = false): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBendTime = bendUniforms.uBendTime;
    shader.uniforms.uBendAmp = bendUniforms.uBendAmp;
    if (rainbow) {
      shader.uniforms.uZone = bendUniforms.uZone;
      shader.uniforms.uZoneHue = bendUniforms.uZoneHue;
      shader.fragmentShader = RAINBOW_FRAG_HEAD + shader.fragmentShader.replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          float zl = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
          vec3 rb = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.333, 0.667) + vZoneZ * 0.03 + uZoneHue));
          diffuseColor.rgb = mix(diffuseColor.rgb, rb * zl, uZone);
        }
        `,
      );
    }
    shader.vertexShader = (rainbow ? 'varying float vZoneZ;\n' : '') + GLSL + shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 bendWp = modelMatrix * mvPosition;
      bendWp.xy += bendOffset(bendWp.z);
      ${rainbow ? 'vZoneZ = bendWp.z;' : ''}
      mvPosition = viewMatrix * bendWp;
      gl_Position = projectionMatrix * mvPosition;
      `,
    );
  };
  mat.customProgramCacheKey = () => (rainbow ? 'bend-rainbow' : 'bend');
  return mat;
}
