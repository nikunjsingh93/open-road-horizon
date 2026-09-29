import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared uniforms (fog / atmosphere / wind) used by every patched material
// ---------------------------------------------------------------------------
export const U = {
  uFogA: { value: new THREE.Color(0.55, 0.65, 0.8) },   // fog colour away from the sun
  uFogB: { value: new THREE.Color(0.9, 0.8, 0.7) },     // fog colour towards the sun
  uSunDirW: { value: new THREE.Vector3(0.4, 0.8, 0.2).normalize() },
  uFogDensity: { value: 0.00028 },
  uFogHeightK: { value: 0.0011 },
  uCamPos: { value: new THREE.Vector3() },
  uCamRot: { value: new THREE.Matrix3() },
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector3(1, 0, 0.4) },       // dir.xz, strength
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uSkyAmb: { value: new THREE.Color(0.3, 0.4, 0.6) },
  uWet: { value: 0.0 },
  uSeason: { value: 0 },      // 0 summer, 1 autumn, 2 winter
  uSnow: { value: 0 },        // ground snow cover 0..1
  uCar: { value: new THREE.Vector4(0, 0, 0, -1) },   // car xz + forward xz, used to clear ground cover under the car
};

export const GLSL_NOISE = /* glsl */`
float hash11(float p){ p = fract(p*.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.-15.)+10.);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
// value noise with analytic-ish derivative (xy) and value (z), range ~[0,1]
vec3 vnoiseD(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.-15.)+10.);
  vec2 du = 30.*f*f*(f*(f-2.)+1.);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  float k0 = a, k1 = b-a, k2 = c-a, k4 = a-b-c+d;
  return vec3(du*(vec2(k1,k2) + k4*u.yx), k0 + k1*u.x + k2*u.y + k4*u.x*u.y);
}
float fbm2(vec2 p){ float s=0., a=.5; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.1,3.7); a*=.5;} return s; }
`;

// ---------------------------------------------------------------------------
// Custom aerial-perspective fog injected into materials
// ---------------------------------------------------------------------------
const FOG_VERT_PARS = /* glsl */`varying vec3 vFogVP; uniform float uTime; uniform vec3 uWind; uniform vec4 uCar;`;
const FOG_VERT = /* glsl */`vFogVP = mvPosition.xyz;`;
const FOG_FRAG_PARS = /* glsl */`
uniform vec3 uFogA; uniform vec3 uFogB; uniform vec3 uSunDirW;
uniform float uFogDensity; uniform float uFogHeightK;
uniform vec3 uCamPos; uniform mat3 uCamRot; uniform vec3 uSunColor; uniform float uTime;
varying vec3 vFogVP;
vec3 applyAerial(vec3 col, vec3 vp){
  float dist = length(vp);
  vec3 dw = uCamRot * vp;
  float dy = dw.y;
  float k = uFogHeightK;
  float y0 = uCamPos.y;
  float h = abs(dy) > 0.02 ? (exp(-k*y0) - exp(-k*(y0+dy))) / (k*dy) : exp(-k*y0);
  h = max(h, 0.0);
  float f = 1.0 - exp(-uFogDensity * dist * h * 1.0);
  f = clamp(f, 0.0, 1.0);
  vec3 dir = dw / max(dist, 1e-3);
  float c = max(dot(dir, uSunDirW), 0.0);
  vec3 fc = mix(uFogA, uFogB, pow(c, 4.0));
  fc += uFogB * pow(c, 24.0) * 0.6;
  return mix(col, fc, f);
}
`;

// Patch a MeshStandardMaterial-like material with the common stuff. `extra(shader)` can further customise.
export const hooks = { csm: null };

// three/addons CSM ships an out-of-date copy of lights_fragment_begin (misses the r18x DFG / multi-scatter setup, which zeroes
// all specular lighting). Keep three's own chunk and splice only CSM's cascaded directional-light block into it.
export function makeCSMSafe(createCSM) {
  const core = THREE.ShaderChunk.lights_fragment_begin;
  const csm = createCSM();
  const cs = THREE.ShaderChunk.lights_fragment_begin;
  const a = core.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = core.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
  const c = cs.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_CSM )');
  const d = cs.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
  if (a > 0 && b > a && c > 0 && d > c) THREE.ShaderChunk.lights_fragment_begin = core.slice(0, a) + cs.slice(c, d) + core.slice(b);
  else console.warn('CSM chunk merge failed; specular lighting may be missing');
  return csm;
}

export function patchMaterial(mat, extra) {
  if (hooks.csm) hooks.csm.setupMaterial(mat);   // must run first: it replaces onBeforeCompile
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, {
      uFogA: U.uFogA, uFogB: U.uFogB, uSunDirW: U.uSunDirW, uFogDensity: U.uFogDensity,
      uCar: U.uCar, uFogHeightK: U.uFogHeightK, uCamPos: U.uCamPos, uCamRot: U.uCamRot, uTime: U.uTime, uWind: U.uWind,
      uSunColor: U.uSunColor, uSkyAmb: U.uSkyAmb, uWet: U.uWet, uSeason: U.uSeason, uSnow: U.uSnow,
    });
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', FOG_VERT_PARS + '\n#include <common>');
    vs = vs.replace('#include <fog_vertex>', FOG_VERT);
    fs = fs.replace('#include <common>', FOG_FRAG_PARS + '\n#include <common>');
    fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAerial(gl_FragColor.rgb, vFogVP);');
    shader.vertexShader = vs; shader.fragmentShader = fs;
    if (extra) extra(shader, renderer);
  };
  mat.customProgramCacheKey = () => (mat.userData.cacheKey || mat.type) + (mat.defines ? JSON.stringify(mat.defines) : '');
  return mat;
}

export function updateCommonUniforms(camera, time) {
  U.uCamPos.value.copy(camera.position);
  camera.updateMatrixWorld();
  U.uCamRot.value.setFromMatrix4(camera.matrixWorld);
  U.uTime.value = time;
}

// ---------------------------------------------------------------------------
// Final grade / tone-map pass (ACES-ish), vignette, subtle grain, chromatic aberration
// ---------------------------------------------------------------------------
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uSat: { value: 1.08 },
    uContrast: { value: 1.06 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.018 },
    uTime: { value: 0 },
    uCA: { value: 0.0005 },
    uSpeed: { value: 0.0 },
    uSunScreen: { value: new THREE.Vector3(0.5, 0.5, 0) }, // xy screen pos, z visibility
    uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
    uRays: { value: 0.16 },
    uLift: { value: new THREE.Color(0.0, 0.004, 0.012) },
    uGain: { value: new THREE.Color(1.03, 1.0, 0.96) },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: /* glsl */`
  uniform sampler2D tDiffuse; uniform float uExposure, uSat, uContrast, uVignette, uGrain, uTime, uCA, uSpeed;
  uniform vec3 uSunScreen; uniform vec3 uSunColor; uniform vec3 uLift; uniform vec3 uGain; uniform float uRays;
  varying vec2 vUv;
  vec3 aces(vec3 x){ // Narkowicz fit
    const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0., 1.);
  }
  vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1./2.4)) - 0.055, step(0.0031308, c)); }
  float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main(){
    vec2 uv = vUv;
    vec2 cc = uv - 0.5;
    float r2 = dot(cc, cc);
    // radial "speed" blur + chromatic aberration
    vec2 dirc = cc * (uCA * (1.0 + r2*6.0));
    vec3 col;
    if (uSpeed > 0.001) {
      col = vec3(0.0); float wsum = 0.0;
      for (int i = 0; i < 6; i++) {
        float t = float(i)/5.0;
        vec2 o = cc * uSpeed * t;
        float w = 1.0 - t*0.6;
        col.r += texture2D(tDiffuse, uv - o - dirc).r * w;
        col.g += texture2D(tDiffuse, uv - o).g * w;
        col.b += texture2D(tDiffuse, uv - o + dirc).b * w;
        wsum += w;
      }
      col /= wsum;
    } else {
      col.r = texture2D(tDiffuse, uv - dirc).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + dirc).b;
    }
    // crepuscular rays: radial accumulation of very bright pixels towards the sun
    if (uSunScreen.z > 0.02 && uRays > 0.0) {
      vec2 toS = uSunScreen.xy - uv;
      vec2 stp = toS / 22.0 * 0.85;
      float jit = h12(gl_FragCoord.xy + fract(uTime) * 13.1);
      vec2 tc = uv + stp * jit;
      float dec = 1.0; vec3 ray = vec3(0.0);
      for (int i = 0; i < 22; i++) {
        tc += stp;
        vec3 sm = texture2D(tDiffuse, tc).rgb;
        float lm = dot(sm, vec3(0.3333));
        ray += sm * min(1.0, 3.5 / max(lm, 1e-3)) * smoothstep(1.2, 3.0, lm) * dec;
        dec *= 0.93;
      }
      col += ray * (0.035 * uRays) * uSunScreen.z * mix(vec3(1.0), uSunColor * 1.2, 0.6);
    }
    col *= uExposure;
    // sun glare (screen-space)
    if (uSunScreen.z > 0.0) {
      vec2 sp = (uv - uSunScreen.xy) * vec2(1.0, 0.6);
      float d = length(sp);
      float g = exp(-d*5.0)*0.08 + exp(-d*22.0)*0.12 + exp(-d*90.0)*0.25;
      col += uSunColor * g * uSunScreen.z * 0.22;
    }
    col = col * uGain + uLift;
    {
      float lum = max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      vec3 perCh = aces(col);
      float lumT = aces(vec3(lum)).x;
      vec3 lumPres = col * (lumT / lum);
      lumPres /= max(1.0, max(lumPres.r, max(lumPres.g, lumPres.b)));
      col = mix(perCh, lumPres, 0.55);
    }
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, uSat);
    col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
    col = toSRGB(col);
    col *= 1.0 - uVignette * smoothstep(0.15, 0.95, r2 * 2.6);
    float g = h12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
    col += g * uGrain;
    gl_FragColor = vec4(col, 1.0);
  }`,
};
