import * as THREE from 'three';
import { patchMaterial, GLSL_NOISE } from './gfx.js';

// Lake water: alpha / colour driven by per-vertex depth (waterY - terrainY), animated ripples via normal perturbation.
export function makeWaterMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.06, metalness: 0.0, transparent: true, depthWrite: false, envMapIntensity: 1.25,
  });
  m.userData.cacheKey = 'water';
  patchMaterial(m, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aDepth; varying float vDepth; varying vec3 vWPosW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vDepth = aDepth; vWPosW = (modelMatrix * vec4(position, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${GLSL_NOISE}
        varying float vDepth; varying vec3 vWPosW;
        float wAlpha; float wFoam;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float dpt = max(vDepth, 0.0);
          vec3 shallow = vec3(0.10, 0.28, 0.24);
          vec3 deep = vec3(0.012, 0.055, 0.085);
          float k = 1.0 - exp(-dpt * 0.35);
          diffuseColor.rgb = mix(shallow, deep, k);
          wAlpha = smoothstep(0.0, 0.5, vDepth) * (0.55 + 0.45 * k);
          // shoreline foam
          float t = uTime;
          float fn = vnoise(vWPosW.xz * 1.7 + vec2(t * 0.3, -t * 0.2));
          wFoam = (1.0 - smoothstep(0.0, 0.35, vDepth + (fn - 0.5) * 0.25)) * step(-0.05, vDepth);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.8, 0.8), wFoam * 0.55);
          diffuseColor.a = clamp(max(wAlpha, wFoam * 0.7), 0.0, 1.0);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float t = uTime;
          vec2 p = vWPosW.xz;
          vec3 n1 = vnoiseD(p * 0.35 + vec2(t * 0.12, t * 0.07));
          vec3 n2 = vnoiseD(p * 1.3 + vec2(-t * 0.25, t * 0.18));
          vec3 n3 = vnoiseD(p * 3.7 + vec2(t * 0.5, -t * 0.4));
          float wfar = smoothstep(60., 420., length(vFogVP));
          vec2 g = n1.xy * (0.5 - 0.3 * wfar) + (n2.xy * 0.14 + n3.xy * 0.035) * (1.0 - wfar);
          vec3 nw = normalize(vec3(-g.x * 0.5, 1.0, -g.y * 0.5));
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.07, 0.35, wFoam);`);
  });
  return m;
}
