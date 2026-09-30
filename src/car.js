import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hooks, LITE } from './gfx.js';

export const PAINTS = {
  red: 0x9c0e16, blue: 0x0b2f6b, green: 0x0f3d2a, silver: 0x9a9da3, white: 0xdedbd2, black: 0x0c0c0e, orange: 0xc4470a, yellow: 0xd2a30a,
};

function makeMaterials() {
  const m = {};
  const Phys = LITE.on ? (o) => { const { clearcoat, clearcoatRoughness, ...rest } = o; return new THREE.MeshStandardMaterial(rest); } : (o) => new THREE.MeshPhysicalMaterial(o);
  m.CarPaint = Phys({ color: PAINTS.red, metalness: 0.2, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.18, envMapIntensity: 0.65 });
  m.Glass = Phys({ color: 0x06090c, metalness: 0.0, roughness: 0.1, transparent: true, opacity: 0.66, envMapIntensity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  m.BlackPlastic = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.55, metalness: 0.0 });
  m.Trim = new THREE.MeshStandardMaterial({ color: 0x1a1a1d, emissive: 0x0e0e10, roughness: 0.4, metalness: 0.1 });
  m.MirrorGlass = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.04, metalness: 0.85, envMapIntensity: 1.0, side: THREE.DoubleSide });
  m.Chrome = new THREE.MeshStandardMaterial({ color: 0xf2f2f4, roughness: 0.16, metalness: 1.0, envMapIntensity: 1.3 });
  m.Rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.92, metalness: 0.0 });
  m.RimAlloy = new THREE.MeshStandardMaterial({ color: 0xb9bbc0, roughness: 0.22, metalness: 1.0, envMapIntensity: 1.2 });
  m.BrakeDisc = new THREE.MeshStandardMaterial({ color: 0x55565a, roughness: 0.5, metalness: 1.0 });
  m.Caliper = new THREE.MeshStandardMaterial({ color: 0xb10d08, roughness: 0.4, metalness: 0.2 });
  m.HeadLens = Phys({ color: 0xcdd8e6, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55, envMapIntensity: 1.5, depthWrite: false });
  m.HeadLamp = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff2dc, emissiveIntensity: 1.2, roughness: 0.3 });
  m.TailLamp = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff0a05, emissiveIntensity: 0.9, roughness: 0.2 });
  m.WheelWell = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95 });
  m.Headliner = new THREE.MeshStandardMaterial({ color: 0x9a9ba0, emissive: 0x3c3d41, roughness: 0.9, side: THREE.DoubleSide });
  m.Interior = new THREE.MeshStandardMaterial({ color: 0x9a968e, emissive: 0x3a3833, roughness: 0.8 });
  m.Seat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, emissive: 0x24160c, roughness: 0.55 });
  m.Plate = new THREE.MeshStandardMaterial({ color: 0xdedbd0, roughness: 0.5 });
  m.Underbody = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95 });
  // the Blender-generated revolve/decal meshes have no guaranteed winding: render both sides (normals flip in-shader)
  for (const k of ['Trim', 'HeadLens', 'HeadLamp', 'TailLamp', 'Plate', 'Glass', 'BlackPlastic']) m[k].side = THREE.DoubleSide;
  if (hooks.csm) for (const k in m) hooks.csm.setupMaterial(m[k]);
  return m;
}

export async function loadCar(url = import.meta.env.BASE_URL + 'assets/car.glb') {
  const mats = makeMaterials();
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const wheelTemplate = model.getObjectByName('Wheel');
  wheelTemplate.parent.remove(wheelTemplate);
  const root = new THREE.Group();
  root.add(model);

  const assign = (obj, isWheel) => {
    obj.traverse(o => {
      if (!o.isMesh) return;
      const key = (o.material && o.material.name) || '';
      const m = mats[key];
      if (m) o.material = m; else console.warn('car: unmapped material', key, o.name);
      o.castShadow = key !== 'Glass' && key !== 'HeadLens';
      o.receiveShadow = true;
      o.frustumCulled = false;
    });
  };
  assign(model);
  assign(wheelTemplate, true);

  const wheels = [];
  const hw = 1.58 / 2, hl = 2.74 / 2;
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]]; // FL FR RL RR: [side, front(-z)/rear(+z)]
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    const spinner = new THREE.Group();
    const w = wheelTemplate.clone(true);
    w.position.set(0, 0, 0);
    if (corners[i][0] < 0) w.rotation.y = Math.PI;
    spinner.add(w); pivot.add(spinner); root.add(pivot);
    wheels.push({ pivot, spinner });
  }

  // lights on the body
  const spots = [];
  for (const sx of [-1, 1]) {
    const s = new THREE.SpotLight(0xfff0d8, 0, 240, 0.6, 0.75, 1.2);
    s.position.set(sx * 0.65, 0.7, -2.1);
    s.target.position.set(sx * 0.65, 0.0, -30);
    s.castShadow = false;
    root.add(s, s.target);
    spots.push(s);
  }

  // ---- driver's steering wheel + instrument cluster (animated at runtime) ----
  const cab = new THREE.Group();
  cab.position.set(-0.36, 0.895, -0.34);
  cab.rotation.x = 0.0;
  const leather = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.62, metalness: 0.0 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.35, metalness: 0.9 });
  const column = new THREE.Group();
  column.rotation.x = -0.38; // wheel plane faces the driver (tilted back)
  const spin = new THREE.Group();
  // Model-Y style wheel: plain round padded rim, one horizontal bar with a rounded centre pad, thumb rollers on the bar
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.0 });
  // rim outline: a circle with flattened top and bottom (straight runs) so the gauges above stay readable
  const RW = 0.145, HT = 0.074, HB = 0.108;
  let outline = [];
  for (let i = 0; i < 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    const x = RW * Math.cos(a), yy = RW * Math.sin(a);
    outline.push([x, Math.max(-HB, Math.min(HT, yy))]);
  }
  for (let pass = 0; pass < 3; pass++) outline = outline.map((p, i) => {   // soften the four corners a little
    const q = outline[(i + 127) % 128], r = outline[(i + 1) % 128];
    return [(q[0] + 2 * p[0] + r[0]) / 4, (q[1] + 2 * p[1] + r[1]) / 4];
  });
  const rimCurve = new THREE.CatmullRomCurve3(outline.map(p => new THREE.Vector3(p[0], p[1], 0)), true, 'centripetal');
  const rim = new THREE.Mesh(new THREE.TubeGeometry(rimCurve, 160, 0.0195, 18, true), rimMat);
  rim.scale.z = 0.82; spin.add(rim);
  const barGeo = new THREE.CapsuleGeometry(0.02, 0.23, 8, 16);
  const bar = new THREE.Mesh(barGeo, rimMat); bar.rotation.z = Math.PI / 2; bar.scale.set(1, 1, 0.72); bar.position.y = -0.012; spin.add(bar);
  const pad = new THREE.Mesh(new THREE.SphereGeometry(0.05, 32, 16), rimMat);
  pad.scale.set(1.15, 0.8, 0.55); pad.position.set(0, -0.012, 0.004); spin.add(pad);
  for (const sx of [-1, 1]) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0115, 0.008, 20), metal);
    roller.rotation.x = Math.PI / 2; roller.position.set(sx * 0.084, -0.012, 0.0155); spin.add(roller);
  }
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.02, 0.004), metal);   // 12 o'clock marker
  mark.position.set(0, HT, 0.016); spin.add(mark);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 16), leather);
  stem.rotation.x = Math.PI / 2; stem.position.z = -0.1; column.add(stem);
  column.add(spin); cab.add(column);
  // instrument cluster: canvas-textured, self-lit
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 384;
  const cx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const clusterMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.157), clusterMat);
  cluster.position.set(-0.36, 0.962, -0.64);
  cluster.rotation.x = -0.32;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.03, 0.10), leather);
  hood.position.set(-0.36, 1.049, -0.70); hood.rotation.x = 0.0;
  const cabin = new THREE.Group(); cabin.add(cab, cluster);
  root.add(cabin);
  cabin.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
  let lastDraw = -1;
  const dial = (x, y, r, val, max, ticks, label, unit) => {
    cx.save(); cx.translate(x, y);
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
    cx.lineWidth = 5; cx.strokeStyle = 'rgba(190,200,215,0.55)';
    cx.beginPath(); cx.arc(0, 0, r, a0, a1); cx.stroke();
    cx.font = 'bold 26px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillStyle = '#e8edf5';
    for (let i = 0; i <= ticks; i++) {
      const t = i / ticks, a = a0 + (a1 - a0) * t, big = true;
      const c = Math.cos(a), s = Math.sin(a), hot = label === 'rpm' && t > 0.82;
      cx.strokeStyle = hot ? '#ff4a3a' : '#dfe6f0'; cx.lineWidth = big ? 5 : 2;
      cx.beginPath(); cx.moveTo(c * (r - 4), s * (r - 4)); cx.lineTo(c * (r - 22), s * (r - 22)); cx.stroke();
      cx.fillStyle = hot ? '#ff6a5a' : '#e8edf5';
      const lab = label === 'rpm' ? String(i) : String(Math.round(max * t));
      cx.fillText(lab, c * (r - 46), s * (r - 46));
    }
    const t = Math.min(1, Math.max(0, val / max)), a = a0 + (a1 - a0) * t;
    cx.strokeStyle = '#ff8a2a'; cx.lineWidth = 7; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(Math.cos(a) * -14, Math.sin(a) * -14); cx.lineTo(Math.cos(a) * (r - 14), Math.sin(a) * (r - 14)); cx.stroke();
    cx.fillStyle = '#1a1c20'; cx.beginPath(); cx.arc(0, 0, 14, 0, 7); cx.fill();
    cx.fillStyle = '#9aa3b0'; cx.font = '22px sans-serif'; cx.fillText(unit, 0, r * 0.52);
    cx.restore();
  };
  const drawCluster = (speed, rpm, gear, unitLabel, night) => {
    cx.fillStyle = night ? '#05070a' : '#0b0d11'; cx.fillRect(0, 0, 1024, 384);
    const g = cx.createLinearGradient(0, 0, 0, 384); g.addColorStop(0, 'rgba(255,255,255,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 1024, 384);
    const smax = unitLabel === 'mph' ? 160 : 260;
    dial(240, 200, 165, speed, smax, unitLabel === 'mph' ? 8 : 13, 'spd', unitLabel);
    dial(784, 200, 165, rpm / 1000, 8, 8, 'rpm', 'x1000 rpm');
    cx.fillStyle = '#f2f6ff'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.font = 'bold 96px sans-serif'; cx.fillText(String(Math.round(speed)), 512, 150);
    cx.fillStyle = '#9aa3b0'; cx.font = '28px sans-serif'; cx.fillText(unitLabel, 512, 210);
    cx.fillStyle = '#ff8a2a'; cx.font = 'bold 84px sans-serif'; cx.fillText(gear, 512, 300);
    tex.needsUpdate = true;
  };
  drawCluster(0, 900, 'N', 'km/h', 0);

  const carMats = Object.values(mats);
  // ---- decorative traffic cars: same model, own paint materials, no lights / shadows ----
  let curEnv = null;
  const paintMats = {};
  const paintMat = (hex) => {
    if (!paintMats[hex]) {
      const m = mats.CarPaint.clone();
      m.color.setHex(hex);
      if (hooks.csm) hooks.csm.setupMaterial(m);
      if (curEnv) m.envMap = curEnv;
      paintMats[hex] = m;
    }
    return paintMats[hex];
  };
  const spawnTraffic = (hex) => {
    const group = new THREE.Group();
    const body = model.clone(true);
    body.traverse(o => {
      if (!o.isMesh) return;
      if (o.material === mats.CarPaint) o.material = paintMat(hex);
      o.castShadow = false;
    });
    group.add(body);
    const ws = [];
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group(), spinner = new THREE.Group();
      const w = wheelTemplate.clone(true);
      w.traverse(o => { if (o.isMesh) o.castShadow = false; });
      if (corners[i][0] < 0) w.rotation.y = Math.PI;
      spinner.add(w); pivot.add(spinner); group.add(pivot);
      ws.push({ pivot, spinner });
    }
    return { root: group, wheels: ws };
  };
  const api = {
    root, wheels, mats, spots, cabin, spawnTraffic,
    // steering wheel angle (rad, positive = right turn) and cluster refresh (throttled)
    setSteer(a) { spin.rotation.z = -a; },
    updateCluster(now, speed, rpm, gear, unitLabel) {
      if (now - lastDraw < 0.05) return; lastDraw = now;
      drawCluster(speed, rpm, gear, unitLabel, api.night);
    },
    // cabin view: no glass tint, hide exterior-only occluders
    setInterior(on) { root.traverse(o => { if (o.isMesh && o.material === mats.Glass) o.visible = !on; }); },

    setPaint(hex) { mats.CarPaint.color.setHex(hex); },
    // per-material reflection strength needs an explicit envMap (scene.environment ignores material.envMapIntensity)
    setEnv(tex) { curEnv = tex; for (const m of Object.values(paintMats)) { m.envMap = tex; m.needsUpdate = true; } for (const m of carMats) { const first = !m.envMap; m.envMap = tex; if (first) m.needsUpdate = true; } },
    setBrake(on) { mats.TailLamp.emissiveIntensity = on ? 4.5 : 0.9 + (api.beam ? 1.2 : 0); },
    night: 0,
    // beam: 0 off, 1 low beam, 2 high beam (night is only used for the tail-lamp glow)
    setNight(n) { api.night = n; },
    setBeam(mode) {
      api.beam = mode;
      mats.HeadLamp.emissiveIntensity = mode === 0 ? 1.0 : mode === 1 ? 3.0 : 5.5;
      mats.TailLamp.emissiveIntensity = 0.9 + (mode ? 1.2 : 0);
      for (const s of spots) {
        s.intensity = mode === 0 ? 0 : mode === 1 ? 95 : 210;
        s.angle = mode === 1 ? 0.5 : 0.36;
        s.penumbra = mode === 1 ? 0.85 : 0.6;
        s.distance = mode === 1 ? 70 : 150;
        s.target.position.y = mode === 1 ? -0.9 : 0.5;      // low beams dip towards the road
        s.target.position.z = -30;
      }
    },
    beam: 0,
  };
  return api;
}
