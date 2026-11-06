import * as THREE from 'three';

/** Shared uniforms for the visual-only tunnel bend (sim stays straight). */
export const bendUniforms = {
  uBendTime: { value: 0 },
  uBendAmp: { value: 1 },
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

/** Patch a built-in material so its vertices bend with distance. Zero offset near the player. */
export function applyBend<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBendTime = bendUniforms.uBendTime;
    shader.uniforms.uBendAmp = bendUniforms.uBendAmp;
    shader.vertexShader = GLSL + shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 bendWp = modelMatrix * mvPosition;
      bendWp.xy += bendOffset(bendWp.z);
      mvPosition = viewMatrix * bendWp;
      gl_Position = projectionMatrix * mvPosition;
      `,
    );
  };
  mat.customProgramCacheKey = () => 'bend';
  return mat;
}
