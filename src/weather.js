import * as THREE from 'three';
import { U, LITE } from './gfx.js';
import { clamp } from './noise.js';

export const WEATHER_PRESETS = {
  clear:    { cloud: 0.42, overcast: 0.0,  rain: 0.0, fog: 0.0, snow: 0.0 },
  partly:   { cloud: 0.62, overcast: 0.12, rain: 0.0, fog: 0.0, snow: 0.0 },
  overcast: { cloud: 0.92, overcast: 0.75, rain: 0.0, fog: 0.25, snow: 0.0 },
  rain:     { cloud: 1.0,  overcast: 0.9,  rain: 0.75, fog: 0.5, snow: 0.0 },
  snow:     { cloud: 1.0,  overcast: 0.8,  rain: 0.0, fog: 0.4, snow: 1.0 },
  storm:    { cloud: 1.0,  overcast: 1.0,  rain: 1.0, fog: 0.65, snow: 0.0 },
  fog:      { cloud: 0.7,  overcast: 0.45, rain: 0.0, fog: 1.0, snow: 0.0 },
};

const rainVert = /* glsl */`
uniform float uTime; uniform vec3 uCam; uniform vec3 uVel; uniform float uIntensity; uniform float uLen; uniform float uSnowMode;
attribute vec3 aSeed;
varying float vA;
void main(){
  vec3 box = vec3(46.0, 26.0, 46.0);
  float speed = mix(16.0 + aSeed.z * 6.0, 1.6 + aSeed.z * 1.4, uSnowMode);
  vec3 p0 = aSeed * box;
  // fall along -y, drift with wind, relative to car velocity
  vec3 v = vec3(uVel.x * 0.0 + 2.0, -speed, 1.0) - uVel;
  vec3 base = vec3(aSeed.x, aSeed.y, aSeed.z) * 0.0;
  vec3 pos = vec3(hash(aSeed.xy) , hash(aSeed.yz + 3.1), hash(aSeed.zx + 7.7)) * box;
  pos += v * uTime;
  pos.xz += vec2(sin(uTime * 0.8 + aSeed.x * 40.0), cos(uTime * 0.65 + aSeed.y * 40.0)) * 0.9 * uSnowMode;
  pos = mod(pos - (uCam - box * 0.5), box) + (uCam - box * 0.5);
  float end = position.x; // 0 = head, 1 = tail
  vec3 dir = normalize(v);
  pos -= dir * end * uLen * (0.6 + aSeed.z * 0.8);
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float distA = 1.0 - smoothstep(6.0, 34.0, length(mv.xyz));
  float keep = step(aSeed.x, uIntensity);
  vA = (1.0 - end) * mix(0.55, 0.9, uSnowMode) * distA * keep;
}`;

export class Weather {
  constructor(scene, sky, game) {
    this.sky = sky; this.game = game; this.scene = scene;
    this.state = { cloud: 0.5, overcast: 0, rain: 0, fog: 0, snow: 0 };
    this.snowAccum = 0; this.seasonSnow = 0;
    this.target = { ...this.state };
    this.name = 'clear';
    this.wet = 0;
    this.wind = 0.5;
    // rain streaks
    const N = 5200;
    const seeds = new Float32Array(N * 2 * 3), pos = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const a = Math.random(), b = Math.random(), c = Math.random();
      for (let k = 0; k < 2; k++) {
        seeds.set([a, b, c], (i * 2 + k) * 3);
        pos.set([k, 0, 0], (i * 2 + k) * 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uIntensity: { value: 0 }, uLen: { value: 0.6 }, uSnowMode: { value: 0 } },
      vertexShader: `float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }\n` + rainVert,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(vec3(0.75, 0.82, 0.9), vA); ${LITE.on ? '#include <colorspace_fragment>' : ''} }`,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    // hash needs to be declared before use: rebuild vertex source
    this.rainMat.vertexShader = `float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }\n` + rainVert;
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    this.rain.visible = false;
    scene.add(this.rain);
  }

  set(name) {
    const p = WEATHER_PRESETS[name];
    if (!p) return;
    this.name = name;
    this.target = { ...p };
  }

  update(dt, camera, vehicle, time) {
    const s = this.state, t = this.target;
    const k = 1 - Math.exp(-dt * 0.35);
    for (const key of ['cloud', 'overcast', 'rain', 'fog', 'snow']) s[key] += ((t[key] ?? 0) - s[key]) * k;
    // snow accumulates while it falls and melts slowly otherwise
    this.snowAccum = clamp(this.snowAccum + (s.snow > 0.2 ? dt * 0.03 * s.snow : -dt * 0.008), 0, 1);
    U.uSnow.value = Math.max(this.seasonSnow, this.snowAccum);
    // wetness lags rain (road dries slowly)
    const wk = t.rain > this.wet ? 0.25 : 0.03;
    this.wet += (Math.min(1, s.rain * 1.4) - this.wet) * (1 - Math.exp(-dt * wk));
    U.uWet.value = this.wet;
    this.wind = 0.4 + s.overcast * 0.6 + s.rain * 0.4;
    U.uWind.value.set(1, 0, 0.4).normalize().multiplyScalar(0.7 + this.wind * 0.9);
    // sky
    this.sky.cover = s.cloud;
    this.sky.overcast = s.overcast;
    this.sky.fogAmount = s.fog;
    // rain visuals
    const r = this.rain;
    const precip = Math.max(s.rain, s.snow);
    r.visible = precip > 0.02;
    if (r.visible) {
      const u = this.rainMat.uniforms;
      u.uTime.value = time; u.uCam.value.copy(camera.position);
      u.uVel.value.copy(vehicle.vel).multiplyScalar(1.0);
      u.uIntensity.value = clamp(precip, 0, 1);
      u.uSnowMode.value = s.snow > s.rain ? 1 : 0;
      u.uLen.value = s.snow > s.rain ? 0.12 + vehicle.speed * 0.006 : 0.5 + vehicle.speed * 0.02;
    }
  }
}
