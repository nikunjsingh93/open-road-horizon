import * as THREE from 'three';
import { U } from './gfx.js';

// ---------------------------------------------------------------------------
// Soft billboard particles (dust, tyre smoke, rain spray)
// ---------------------------------------------------------------------------
export class Particles {
  constructor(scene, max = 700) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max).fill(0);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.col = new Float32Array(max * 3); this.alpha = new Float32Array(max);
    this.aSize = new Float32Array(max); this.aAlpha = new Float32Array(max); this.aCol = new Float32Array(max * 3);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(this.aCol, 3));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aCol;
        varying float vA; varying vec3 vC; uniform float uScale;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          vA = aAlpha * smoothstep(0.15, 1.2, -mv.z); vC = aCol;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC; uniform vec3 uLight;
        void main(){
          vec2 c = gl_PointCoord - 0.5; float d = length(c) * 2.0;
          float a = smoothstep(1.0, 0.0, d); a *= a;
          gl_FragColor = vec4(vC * uLight, a * vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b; this.alpha[i] = a;
  }

  update(dt, camera, viewportH, light) {
    this.mat.uniforms.uScale.value = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.mat.uniforms.uLight.value.copy(light);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.aAlpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.life[i] = 0; this.aAlpha[i] = 0; continue; }
      const drag = Math.exp(-dt * 1.6);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag + dt * 0.25; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.aSize[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      this.aAlpha[i] = this.alpha[i] * (1 - t) * Math.min(1, t * 10);
      this.aCol[i * 3] = this.col[i * 3]; this.aCol[i * 3 + 1] = this.col[i * 3 + 1]; this.aCol[i * 3 + 2] = this.col[i * 3 + 2];
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aCol.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Skid marks (ring buffer of ribbon quads)
// ---------------------------------------------------------------------------
export class SkidMarks {
  constructor(scene, quads = 2400) {
    this.max = quads;
    this.pos = new Float32Array(quads * 4 * 3);
    this.col = new Float32Array(quads * 4 * 4);
    const idx = new Uint32Array(quads * 6);
    for (let i = 0; i < quads; i++) { const o = i * 4; idx.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], i * 6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = g;
    this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    scene.add(this.mesh);
    this.cursor = 0; this.last = [null, null, null, null];
    this.dirty = false;
    g.setDrawRange(0, 0);
    this.count = 0;
  }

  reset() { this.last = [null, null, null, null]; }

  // p: contact point (Vector3), right: lateral unit vector (world), amount 0..1
  add(i, p, right, amount) {
    const prev = this.last[i];
    if (amount <= 0.02) { this.last[i] = null; return; }
    const cur = { x: p.x, y: p.y + 0.02, z: p.z, rx: right.x, rz: right.z };
    if (prev) {
      const dx = cur.x - prev.x, dz = cur.z - prev.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 9) { this.last[i] = cur; return; }          // teleport / too far
      if (d2 < 0.09) return;                                // wait for a longer segment
      const q = this.cursor; this.cursor = (this.cursor + 1) % this.max; this.count = Math.min(this.count + 1, this.max);
      const w = 0.11, o = q * 4;
      const P = this.pos, C = this.col;
      const set = (k, x, y, z, a) => { P[(o + k) * 3] = x; P[(o + k) * 3 + 1] = y; P[(o + k) * 3 + 2] = z; C.set([0.02, 0.02, 0.02, a], (o + k) * 4); };
      const a = Math.min(0.62, amount * 0.7);
      set(0, prev.x - prev.rx * w, prev.y, prev.z - prev.rz * w, a);
      set(1, prev.x + prev.rx * w, prev.y, prev.z + prev.rz * w, a);
      set(2, cur.x - cur.rx * w, cur.y, cur.z - cur.rz * w, a);
      set(3, cur.x + cur.rx * w, cur.y, cur.z + cur.rz * w, a);
      this.dirty = true;
    }
    this.last[i] = cur;
  }

  flush() {
    if (!this.dirty) return;
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, this.count * 6);
    this.dirty = false;
  }
}
