import * as THREE from 'three';
import { U, GLSL_NOISE, LITE } from './gfx.js';

// ------------------------------- CPU atmosphere (for light / fog colours) -------------------------------
const RP = 6371e3, RA = 6471e3;
const kRlh = [5.5e-6, 13.0e-6, 22.4e-6], kMie = 21e-6, shRlh = 8e3, shMie = 1.2e3, gMie = 0.758;

function rsi(r0, rd, sr) {
  const a = rd[0] * rd[0] + rd[1] * rd[1] + rd[2] * rd[2];
  const b = 2 * (rd[0] * r0[0] + rd[1] * r0[1] + rd[2] * r0[2]);
  const c = r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2] - sr * sr;
  const d = b * b - 4 * a * c;
  if (d < 0) return [1e5, -1e5];
  const sq = Math.sqrt(d);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}

export function atmosphereCPU(r, sun, iSun = 22, steps = 14, jsteps = 6, alt = 100) {
  const r0 = [0, RP + alt, 0];
  const len = Math.hypot(...r); r = r.map(v => v / len);
  const p = rsi(r0, r, RA);
  const pl = rsi(r0, r, RP);
  if (pl[0] > 0) p[1] = Math.min(p[1], pl[0]);
  if (p[0] > p[1]) return [0, 0, 0];
  const stepSize = (p[1] - p[0]) / steps;
  let t = 0, odR = 0, odM = 0;
  const totR = [0, 0, 0], totM = [0, 0, 0];
  const mu = r[0] * sun[0] + r[1] * sun[1] + r[2] * sun[2];
  const pRlh = 3 / (16 * Math.PI) * (1 + mu * mu);
  const gg = gMie * gMie;
  const pMie = 3 / (8 * Math.PI) * ((1 - gg) * (mu * mu + 1)) / (Math.pow(1 + gg - 2 * mu * gMie, 1.5) * (2 + gg));
  for (let i = 0; i < steps; i++) {
    const ip = [r0[0] + r[0] * (t + stepSize * 0.5), r0[1] + r[1] * (t + stepSize * 0.5), r0[2] + r[2] * (t + stepSize * 0.5)];
    const h = Math.hypot(...ip) - RP;
    const dR = Math.exp(-h / shRlh) * stepSize, dM = Math.exp(-h / shMie) * stepSize;
    odR += dR; odM += dM;
    const js = rsi(ip, sun, RA)[1] / jsteps;
    let jt = 0, jR = 0, jM = 0;
    for (let j = 0; j < jsteps; j++) {
      const jp = [ip[0] + sun[0] * (jt + js * 0.5), ip[1] + sun[1] * (jt + js * 0.5), ip[2] + sun[2] * (jt + js * 0.5)];
      const jh = Math.hypot(...jp) - RP;
      jR += Math.exp(-jh / shRlh) * js; jM += Math.exp(-jh / shMie) * js;
      jt += js;
    }
    for (let c = 0; c < 3; c++) {
      const attn = Math.exp(-(kMie * (odM + jM) + kRlh[c] * (odR + jR)));
      totR[c] += dR * attn; totM[c] += dM * attn;
    }
    t += stepSize;
  }
  return [0, 1, 2].map(c => iSun * (pRlh * kRlh[c] * totR[c] + pMie * kMie * totM[c]));
}

// transmittance of sunlight from ground to space
export function sunTransmittance(sun, alt = 100) {
  const r0 = [0, RP + alt, 0];
  if (sun[1] < -0.12) return [0, 0, 0];
  const len = rsi(r0, sun, RA)[1];
  const steps = 24; const ss = len / steps;
  let oR = 0, oM = 0;
  for (let i = 0; i < steps; i++) {
    const p = [r0[0] + sun[0] * (i + .5) * ss, r0[1] + sun[1] * (i + .5) * ss, r0[2] + sun[2] * (i + .5) * ss];
    const h = Math.hypot(...p) - RP;
    oR += Math.exp(-h / shRlh) * ss; oM += Math.exp(-h / shMie) * ss;
  }
  return [0, 1, 2].map(c => Math.exp(-(kMie * 1.1 * oM + kRlh[c] * oR)));
}

// ------------------------------- Sky dome shader -------------------------------
const skyVert = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww; // far plane
}`;

const skyFrag = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir; uniform vec3 uMoonDir;
uniform float uTime; uniform float uCover; uniform float uEnv;
uniform vec3 uSunRad; uniform vec3 uGround; uniform float uNight;
uniform float uHaze; uniform float uOvercast;
${GLSL_NOISE}
#define PI 3.14159265
vec2 rsi(vec3 r0, vec3 rd, float sr){
  float a = dot(rd,rd), b = 2.*dot(rd,r0), c = dot(r0,r0)-sr*sr, d = b*b-4.*a*c;
  if (d < 0.) return vec2(1e5,-1e5);
  return vec2((-b-sqrt(d))/(2.*a), (-b+sqrt(d))/(2.*a));
}
vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun, float iSun, float rPlanet, float rAtmos, vec3 kRlh, float kMie, float shRlh, float shMie, float g){
  vec2 p = rsi(r0, r, rAtmos);
  if (p.x > p.y) return vec3(0);
  p.y = min(p.y, rsi(r0, r, rPlanet).x);
  const int iSteps = 14; const int jSteps = 5;
  float iStep = (p.y - p.x)/float(iSteps);
  float iTime = 0.;
  vec3 totR = vec3(0), totM = vec3(0);
  float odR = 0., odM = 0.;
  float mu = dot(r, pSun), mumu = mu*mu, gg = g*g;
  float pR = 3./(16.*PI)*(1.+mumu);
  float pM = 3./(8.*PI)*((1.-gg)*(mumu+1.))/(pow(1.+gg-2.*mu*g,1.5)*(2.+gg));
  for (int i=0;i<iSteps;i++){
    vec3 ip = r0 + r*(iTime + iStep*.5);
    float h = length(ip) - rPlanet;
    float dR = exp(-h/shRlh)*iStep, dM = exp(-h/shMie)*iStep;
    odR += dR; odM += dM;
    float jStep = rsi(ip, pSun, rAtmos).y/float(jSteps);
    float jT = 0., jR = 0., jM = 0.;
    for (int j=0;j<jSteps;j++){
      vec3 jp = ip + pSun*(jT + jStep*.5);
      float jh = length(jp) - rPlanet;
      jR += exp(-jh/shRlh)*jStep; jM += exp(-jh/shMie)*jStep;
      jT += jStep;
    }
    vec3 attn = exp(-(kMie*(odM+jM) + kRlh*(odR+jR)));
    totR += dR*attn; totM += dM*attn;
    iTime += iStep;
  }
  return iSun*(pR*kRlh*totR + pM*kMie*totM);
}

// --- clouds: layered 2D fbm slabs with fake self-shadowing ---
float cloudDens(vec2 uv, float cover, int oct){
  float s = 0., a = .55, n = 0.;
  vec2 p = uv;
  for (int i=0;i<6;i++){
    if (i >= oct) break;
    s += a*vnoise(p); n += a; p = p*2.11 + vec2(3.7, 9.2); a *= .5;
  }
  s /= n;
  return smoothstep(1.0 - cover, 1.0 - cover + .5, s + (cover-.5)*.2);
}
vec4 cloudLayer(vec3 rd, vec3 sd, float alt, float scale, float cover, vec2 wind, vec3 ambCol, vec3 sunCol){
  if (rd.y < 0.015) return vec4(0);
  float t = alt / rd.y;
  vec2 p = rd.xz * t;
  vec2 uv = p / scale + wind * uTime;
  float d = cloudDens(uv, cover, 5);
  if (d < 0.003) return vec4(0);
  vec2 toSun = sd.xz / max(sd.y, .12);
  float d2 = cloudDens(uv + toSun*.10, cover, 3);
  float d3 = cloudDens(uv + toSun*.28, cover, 2);
  float shade = clamp(1. - (d2*.6 + d3*.7) + .35*(1.-d), 0., 1.);
  float thick = smoothstep(0.0, 1.0, d);
  vec3 lit = sunCol * (0.35 + 1.35*shade) ;
  vec3 col = ambCol*(0.55 + .6*(1.-thick*.6)) + lit * (0.45 + 0.55*(1.-d*.5));
  float sunDot = max(dot(rd, sd), 0.);
  col += sunCol * pow(sunDot, 12.) * (1. - thick*.5) * .6;   // forward-scatter silver lining
  float fade = smoothstep(0.015, 0.20, rd.y);
  return vec4(col, d * fade);
}

void main(){
  vec3 rd = normalize(vDir);
  vec3 sd = normalize(uSunDir);
  vec3 r0 = vec3(0., 6371e3 + 100., 0.);
  vec3 kR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
  vec3 rdA = normalize(vec3(rd.x, max(rd.y, 0.0008), rd.z));
  vec3 col = atmosphere(rdA, r0, sd, 22., 6371e3, 6471e3, kR, 21e-6, 8e3, 1.2e3, .758);
  col = col / (1.0 + 0.10 * col);     // soften the solar aureole before it clips
  // haze tint
  col = mix(col, vec3(dot(col, vec3(.333))) * vec3(1., 1.02, 1.06), uHaze);
  float horizon = smoothstep(-0.03, 0.02, rd.y);
  // below horizon: blend to ground colour
  if (uEnv > .5) { col = col / (1.0 + 0.45 * col); col = mix(uGround, col, horizon); }
  vec3 outc = col + vec3(0.0026, 0.0046, 0.0085) * uNight * (1.0 + 1.5*exp(-abs(rd.y)*4.0));
  if (uEnv < .5) {
    // stars
    if (uNight > 0.01 && rd.y > -0.02) {
      vec3 p = rd * 150.;
      vec3 id = floor(p);
      vec3 f = fract(p) - .5;
      float h = hash12(id.xy + id.z*37.1);
      vec2 o = hash22(id.xy*1.7 + id.z) - .5;
      float st = (1.-smoothstep(.0,.05, length(f.xy*.5 + f.z*.2 - o*.4))) * step(.972, h);
      outc += vec3(.8,.85,1.) * st * uNight * (0.3+1.2*h) * 1.6 * smoothstep(0., .1, rd.y);
    }
    // moon
    float md = dot(rd, normalize(uMoonDir));
    float moon = smoothstep(.99985, .99992, md);
    outc = mix(outc, vec3(1.2,1.2,1.15)*uNight, moon * step(0., uMoonDir.y+.05));
    outc += vec3(.6,.7,.9) * pow(max(md,0.), 300.) * .25 * uNight;
    // clouds (two layers)
    vec3 ambC = (col*.5 + vec3(.20,.24,.32) * (1.0 - uNight*.93)) ;
    ambC = max(ambC, vec3(.01));
    vec3 sunC = uSunRad * 1.05;
    vec4 c1 = cloudLayer(rd, sd, 2400., 3600., uCover, vec2(.0022,.0008), ambC, sunC);
    vec4 c2 = cloudLayer(rd, sd, 7000., 9000., uCover*.75, vec2(.004,.0014), ambC*.9, sunC*.95);
    outc = mix(outc, c2.rgb, c2.a*.7);
    outc = mix(outc, c1.rgb, c1.a);
    { float ovr = uOvercast; vec3 gc = vec3(dot(outc, vec3(0.3333))); outc = mix(outc, gc * 0.78, ovr * 0.8); }
    // sun disc
    float sdot = dot(rd, sd);
    float disc = smoothstep(.99997, .99999, sdot) * (1.-c1.a*.95) * (1. - uOvercast);
    outc += uSunRad * disc * 9.;
  }
  gl_FragColor = vec4(outc, 1.);
}`;

// ---- lite sky: the atmosphere is evaluated per *vertex* of the dome (a few hundred evaluations instead of ~one per pixel),
// clouds are a single scrolling texture lookup ----
const ATMO_GLSL = skyFrag.slice(skyFrag.indexOf('vec2 rsi('), skyFrag.indexOf('// --- clouds'));
const skyLiteVert = /* glsl */`
varying vec3 vDir; varying vec3 vCol;
uniform vec3 uSunDir; uniform float uNight; uniform float uHaze;
#define PI 3.14159265
${ATMO_GLSL}
void main(){
  vDir = position;
  vec3 rd = normalize(position), sd = normalize(uSunDir);
  vec3 r0 = vec3(0., 6371e3 + 100., 0.);
  vec3 kR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
  vec3 rdA = normalize(vec3(rd.x, max(rd.y, 0.0008), rd.z));
  vec3 col = atmosphere(rdA, r0, sd, 22., 6371e3, 6471e3, kR, 21e-6, 8e3, 1.2e3, .758);
  col = col / (1.0 + 0.10 * col);
  col = mix(col, vec3(dot(col, vec3(.333))) * vec3(1., 1.02, 1.06), uHaze);
  col += vec3(0.0026, 0.0046, 0.0085) * uNight * (1.0 + 1.5*exp(-abs(rd.y)*4.0));
  vCol = col;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const skyLiteFrag = /* glsl */`
precision highp float;
varying vec3 vDir; varying vec3 vCol;
uniform vec3 uSunDir; uniform vec3 uMoonDir; uniform float uTime; uniform float uCover; uniform vec3 uSunRad; uniform float uNight; uniform float uOvercast;
uniform sampler2D tCloud;
${GLSL_NOISE}
void main(){
  vec3 rd = normalize(vDir), sd = normalize(uSunDir);
  vec3 outc = vCol;
  if (uNight > 0.01 && rd.y > -0.02) {
    vec3 p = rd * 150.; vec3 id = floor(p); vec3 f = fract(p) - .5;
    float h = hash12(id.xy + id.z*37.1); vec2 o = hash22(id.xy*1.7 + id.z) - .5;
    float st = (1.-smoothstep(.0,.05, length(f.xy*.5 + f.z*.2 - o*.4))) * step(.972, h);
    outc += vec3(.8,.85,1.) * st * uNight * (0.3+1.2*h) * 1.6 * smoothstep(0., .1, rd.y);
    float md = dot(rd, normalize(uMoonDir));
    outc = mix(outc, vec3(1.2,1.2,1.15)*uNight, smoothstep(.9997, .99985, md) * step(0., uMoonDir.y+.05));
    outc += vec3(.6,.7,.9) * pow(max(md,0.), 300.) * .25 * uNight;
  }
  if (rd.y > 0.02) {
    vec2 uv = rd.xz / (rd.y + 0.22) * 0.55 + uTime * vec2(0.0035, 0.0012);
    float d = texture2D(tCloud, uv).r;
    d = smoothstep(1.0 - uCover, 1.0 - uCover + 0.32, d) * smoothstep(0.02, 0.25, rd.y);
    vec3 cc = vCol * 0.55 + uSunRad * 0.5 + vec3(0.10);
    cc = mix(cc, vec3(dot(cc, vec3(.333))) * 0.8, uOvercast);
    outc = mix(outc, cc, d * 0.9);
  }
  float sdot = dot(rd, sd);
  outc += uSunRad * smoothstep(.99995, .999985, sdot) * (1. - uOvercast) * 9.;
  outc += uSunRad * pow(max(sdot, 0.), 220.) * 0.35 * (1. - uOvercast);
  gl_FragColor = vec4(outc, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function makeCloudTexture() {
  const N = 256, data = new Uint8Array(N * N * 4);
  const period = (o) => 4 * (1 << o);
  let seed = 1337; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const grids = [0, 1, 2, 3].map((o) => { const p = period(o); const g = new Float32Array(p * p); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; });
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, a = 0.5, n = 0;
    for (let o = 0; o < 4; o++) {
      const p = period(o), fx = x / N * p, fy = y / N * p, ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy), g = grids[o];
      const i00 = g[(iy % p) * p + (ix % p)], i10 = g[(iy % p) * p + ((ix + 1) % p)], i01 = g[((iy + 1) % p) * p + (ix % p)], i11 = g[((iy + 1) % p) * p + ((ix + 1) % p)];
      v += a * ((i00 * (1 - tx) + i10 * tx) * (1 - ty) + (i01 * (1 - tx) + i11 * tx) * ty); n += a; a *= 0.5;
    }
    const c = Math.min(255, Math.max(0, Math.round(v / n * 255)));
    const i = (y * N + x) * 4; data[i] = data[i + 1] = data[i + 2] = c; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.hour = 16.5;
    this.yaw = -0.95;     // sun azimuth offset (radians)
    this.cover = 0.55; this.overcast = 0; this.fogAmount = 0;
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uTime: U.uTime, uCover: { value: 0.55 }, uEnv: { value: 0 },
      uSunRad: { value: new THREE.Color(1, 1, 1) },
      uGround: { value: new THREE.Color(0.1, 0.12, 0.1) },
      uNight: { value: 0 }, uHaze: { value: 0.0 }, uOvercast: { value: 0 },
    };
    this.mat = LITE.on
      ? new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, tCloud: { value: makeCloudTexture() } }, vertexShader: skyLiteVert, fragmentShader: skyLiteFrag, side: THREE.BackSide, depthWrite: false, depthTest: true })
      : new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, depthTest: true });
    this.geo = LITE.on ? new THREE.SphereGeometry(1000, 40, 20) : new THREE.SphereGeometry(1000, 48, 24);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    scene.add(this.mesh);
    this.sunDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.ambient = new THREE.Color();
    this.envScene = null;
  }

  setTime(hour) {
    this.hour = ((hour % 24) + 24) % 24;
    const a = (this.hour - 5.6) / 14.2 * Math.PI; // sunrise 5.6h, sunset 19.8h
    const lat = 0.9; // tilt of sun path (summer-ish, max elevation ~ 64 deg)
    let x = Math.cos(a), y = Math.sin(a) * Math.cos(lat) + (Math.sin(a) > 0 ? 0 : 0) , z = Math.sin(a) * Math.sin(lat) * 0.6;
    y = Math.sin(a) * 0.9 - 0.02;
    // rotate around Y by yaw
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const rx = x * c + z * s, rz = -x * s + z * c;
    this.sunDir.set(rx, y, rz).normalize();
    const sd = this.sunDir;
    this.uniforms.uSunDir.value.copy(sd);
    const md = new THREE.Vector3(-sd.x, -sd.y, -sd.z);
    this.uniforms.uMoonDir.value.copy(md);
    const T = sunTransmittance([sd.x, sd.y, sd.z]);
    const mxT = Math.max(T[0], T[1], T[2], 1e-4);
    const wb = THREE.MathUtils.smoothstep(sd.y, 0.04, 0.4) * 0.6;   // camera-like white balance for high sun
    for (let i = 0; i < 3; i++) T[i] = T[i] + (mxT - T[i]) * wb;
    const ovk = 1 - 0.9 * (this.overcast || 0);
    this.sunColor.setRGB(T[0] * ovk, T[1] * ovk, T[2] * ovk);
    this.uniforms.uSunRad.value.setRGB(T[0] * ovk, T[1] * ovk, T[2] * ovk);
    this.uniforms.uOvercast.value = this.overcast || 0;
    const night = THREE.MathUtils.smoothstep(-sd.y, 0.05, 0.25);
    this.uniforms.uNight.value = night;
    this.uniforms.uCover.value = this.cover;
    // fog + ambient colours from the atmosphere
    const sdA = [sd.x, sd.y, sd.z];
    const hz = 0.035;
    const awayDir = [-sd.x, 0, -sd.z]; const l = Math.hypot(awayDir[0], awayDir[2]) || 1;
    const away = atmosphereCPU([awayDir[0] / l, hz, awayDir[2] / l], sdA, 22, 12, 5);
    const towardDir = [sd.x, 0, sd.z]; const l2 = Math.hypot(towardDir[0], towardDir[2]) || 1;
    const toward = atmosphereCPU([towardDir[0] / l2, hz, towardDir[2] / l2], sdA, 22, 12, 5);
    const zen = atmosphereCPU([0, 1, 0], sdA, 22, 12, 5);
    const mid = atmosphereCPU([0.7, 0.7, 0], sdA, 22, 12, 5);
    U.uFogA.value.setRGB(away[0], away[1], away[2]);
    U.uFogB.value.setRGB(toward[0], toward[1], toward[2]);
    { const ov = this.overcast || 0; const gA = U.uFogA.value; const lum = (gA.r + gA.g + gA.b) / 3; U.uFogA.value.lerp(new THREE.Color(lum * 0.9, lum * 0.93, lum), ov * 0.7); U.uFogB.value.lerp(U.uFogA.value, ov); }
    // keep toward-sun fog from blowing out
    const m = Math.max(...toward); if (m > 1.35) U.uFogB.value.multiplyScalar(1.35 / m);
    this.ambient.setRGB((zen[0] * .6 + mid[0] * .4), (zen[1] * .6 + mid[1] * .4), (zen[2] * .6 + mid[2] * .4));
    U.uSkyAmb.value.copy(this.ambient);
    U.uFogDensity.value = 0.00034 * (1 + (this.fogAmount || 0) * 9);
    U.uFogHeightK.value = 0.0011 * (1 - 0.6 * (this.fogAmount || 0));
    U.uSunDirW.value.copy(sd);
    U.uSunColor.value.copy(this.sunColor);
    // ground colour used by the sky dome below the horizon and in the env map
    const gnd = this.sunColor.clone().multiplyScalar(Math.max(sd.y, 0) * 0.8 * (1 - 0.6 * (this.overcast || 0))).add(this.ambient.clone().multiplyScalar(0.5));
    gnd.multiply(new THREE.Color(0.40, 0.46, 0.24));
    this.uniforms.uGround.value.copy(gnd);
    this.elevation = sd.y;
    this.night = night;
  }

  // Build environment map (PMREM) from the dome
  buildEnv(renderer, pmrem) {
    if (!this.envScene) {
      this.envScene = new THREE.Scene();
      // the environment map (car reflections) always uses the full physical sky, it is only rebuilt when the time of day changes
      this.envMat = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, uEnv: { value: 1 } }, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, depthTest: true });
      this.envMesh = new THREE.Mesh(this.geo, this.envMat);
      this.envMesh.frustumCulled = false;
      this.envScene.add(this.envMesh);
    }
    // uniforms shared by reference except uEnv
    this.envMat.uniforms.uSunDir = this.uniforms.uSunDir;
    const rt = pmrem.fromScene(this.envScene, 0.0, 0.1, 5000);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    return rt.texture;
  }
}
