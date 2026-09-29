import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { World } from './terrain.js';
import { GradeShader, updateCommonUniforms, hooks, U, makeCSMSafe } from './gfx.js';
import { Sky } from './sky.js';
import { Ground, makeTerrainMaterial } from './ground.js';
import { FarTerrain } from './tiles.js';
import { Vehicle, Autopilot, SPEC } from './vehicle.js';
import { TreeScatter } from './scatter.js';
import { GroundCover } from './cover.js';
import { loadCar, PAINTS } from './car.js';
import { Weather } from './weather.js';
import { Roadside } from './roadside.js';
import { AudioEngine } from './audio.js';
import { Particles, SkidMarks } from './fx.js';
import { setupTouch, isTouchDevice } from './touch.js';
import { UI, loadSettings, saveSettings, timeFlowRate } from './ui.js';
import { clamp } from './noise.js';

const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const tick = () => new Promise(r => setTimeout(r, 0));

const QUALITY = {
  low:    { pr: 0.8,  msaa: 0, bloom: false, shadow: 1024, shadowFar: 200, cover: 55,  nearR: 200, farR: 900,  grass: 1.6 },
  medium: { pr: 1.0,  msaa: 2, bloom: true,  shadow: 1536, shadowFar: 300, cover: 80,  nearR: 260, farR: 1200, grass: 2.4 },
  high:   { pr: 1.25, msaa: 4, bloom: true,  shadow: 2048, shadowFar: 380, cover: 100, nearR: 300, farR: 1500, grass: 3.0 },
  ultra:  { pr: 1.75, msaa: 4, bloom: true,  shadow: 4096, shadowFar: 450, cover: 130, nearR: 380, farR: 1900, grass: 3.6 },
};

class Game {
  async init() {
    const status = (t, p) => { const e = $('lstat'); if (e) e.textContent = t; if (p != null) $('lbar').style.width = p + '%'; };
    this.settings = loadSettings();
    const S = this.settings;
    if (params.get('q')) S.quality = params.get('q');
    if (params.get('t')) S.time = parseFloat(params.get('t'));
    if (params.get('weather')) S.weather = params.get('weather');
    if (params.get('cam')) S.camera = params.get('cam');
    if (params.get('flow')) S.timeFlow = params.get('flow');
    if (params.get('season')) S.season = params.get('season');
    this.seed = params.get('seed') ? parseInt(params.get('seed')) : (S.seed || 7);
    const QP = this.QP = QUALITY[S.quality] || QUALITY.high;
    status('Preparing renderer', 4); await tick();

    const canvas = $('c');
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer = renderer;
    this.dynScale = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, QP.pr);
    this.fixedPR = !!params.get('pr');
    this.pixelRatio = this.fixedPR ? parseFloat(params.get('pr')) : this.dpr * S.renderScale;
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;

    const scene = this.scene = new THREE.Scene();
    const camera = this.camera = new THREE.PerspectiveCamera(S.fov, window.innerWidth / window.innerHeight, 0.25, 14000);
    camera.position.set(0, 5, 10);

    // --- world & sky ---
    status('Generating world', 10); await tick();
    this.world = new World(this.seed);
    this.world.ensure(9500);
    this.sky = new Sky(scene);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.hour = S.time;
    this.setTime(this.hour);

    // --- cascaded shadows (must exist before materials are created) ---
    this.csm = makeCSMSafe(() => new CSM({
      maxFar: QP.shadowFar, cascades: 3, mode: 'practical', parent: scene, camera,
      shadowMapSize: QP.shadow, lightDirection: new THREE.Vector3(-0.4, -1, -0.3).normalize(),
      lightIntensity: 3, shadowBias: -0.0003, lightNear: 1, lightFar: 2500, lightMargin: 300,
    }));
    this.csm.fade = true;
    this.csm.lights.forEach((l, i) => { l.shadow.normalBias = [0.03, 0.09, 0.25][i]; });
    hooks.csm = this.csm;
    this._csmFov = camera.fov; this._csmAspect = camera.aspect;

    status('Shaping terrain', 22); await tick();
    this.ground = new Ground(scene, this.world);
    this.far = new FarTerrain(scene, this.world, (offset) => {
      const m = makeTerrainMaterial(); m.polygonOffset = true; m.polygonOffsetFactor = offset; m.polygonOffsetUnits = offset; return m;
    });
    this.ground.terrainMat.polygonOffset = true; this.ground.terrainMat.polygonOffsetFactor = -1; this.ground.terrainMat.polygonOffsetUnits = -1;
    this.far.maxDist = 5200 * S.viewDist + 800;

    this.roadside = new Roadside(scene, this.world);
    status('Growing forests', 34); await tick();
    if (params.get('trees') !== '0') {
      this.trees = new TreeScatter(scene, this.world, { nearR: QP.nearR, farR: QP.farR * S.viewDist, lod0R: 100, season: S.season });
      status('Planting meadows', 46); await tick();
      this.cover = new GroundCover(scene, this.world, this.trees.lib, { radius: QP.cover, density: QP.grass * S.grass, season: S.season });
    }

    // --- vehicle ---
    status('Building the car', 56); await tick();
    this.vehicle = new Vehicle(this.world);
    this.vehicle.place(20, 1.7, params.get('v') ? parseFloat(params.get('v')) / 3.6 : 0);
    this.autopilot = new Autopilot(this.world, this.vehicle);
    this.auto = params.get('auto') === '1';
    this.car = await loadCar();
    if (PAINTS[S.paint]) this.car.setPaint(PAINTS[S.paint]);
    this.carRoot = new THREE.Group();
    this.carRoot.add(this.car.root);
    this.car.root.position.y = -SPEC.comH;
    scene.add(this.carRoot);
    this._qinv = new THREE.Quaternion();

    // --- effects ---
    U.uSeason.value = { summer: 0, autumn: 1, winter: 2 }[S.season] ?? 0;
    this.weather = new Weather(scene, this.sky, this);
    this.weather.seasonSnow = S.season === 'winter' ? 0.92 : 0;
    this.weather.set(S.weather);
    Object.assign(this.weather.state, this.weather.target);
    this.weather.wet = Math.min(1, this.weather.state.rain * 1.4);
    this.particles = new Particles(scene, 800);
    this.skids = new SkidMarks(scene);
    this.audio = new AudioEngine();
    this.audio.masterVol = S.volume; this.audio.musicVol = S.music;

    // camera
    this.camMode = S.camera;
    this.camDir = new THREE.Vector3(0, 0, -1);
    this._dirL = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0); this._x = new THREE.Vector3(1, 0, 0);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.shakeT = 0;
    this.look = { yaw: 0, pitch: 0, idle: 99 };   // mouse look offsets (view yaw / pitch, positive = left / up)
    this.started = false;

    // --- post ---
    status('Compiling shaders', 70); await tick();
    const size = new THREE.Vector2(); renderer.getDrawingBufferSize(size);
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: QP.msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(1);
    this.composer.setSize(size.x, size.y);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.55, 1.6);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    if (QP.bloom) this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);

    this.ui = new UI(this);
    window.addEventListener('resize', () => this.resize());
    this.setupInput();
    // touch controls appear only on touch screens (or as soon as a touch is seen)
    this.touchMode = false;
    const enableTouch = () => {
      if (this.touchMode) return;
      this.touchMode = true;
      document.body.classList.add('touch');
      setupTouch(this);
      const s = $('start').querySelector('.s'); if (s) s.textContent = 'Tap to drive';
      const k = $('start').querySelector('.k'); if (k) k.innerHTML = 'Endless procedural roads &nbsp;·&nbsp; relax, cruise, explore<br>Steer bottom-left · pedals bottom-right · drag to look';
    };
    if (isTouchDevice()) enableTouch(); else window.addEventListener('touchstart', enableTouch, { once: true, passive: true });
    $('unit').textContent = S.units === 'mph' ? 'mph' : 'km/h';
    if (!S.showHud) { $('hud').classList.add('hidden'); $('topbar').classList.add('hidden'); }

    // prime world
    status('Streaming terrain', 78); await tick();
    this.ground.prime(this.vehicle.s);
    this.updateCamera(0, true);
    this.far.primeAll(this.camera.position);
    status('Streaming forest', 88); await tick();
    if (this.trees) { this.trees.prime(this.camera.position); this.cover.prime(this.camera.position); }
    this.clock = new THREE.Clock();
    this.time = 0; this.acc = 0; this.paused = false;
    this.hudEl = $('hud');
    this.loop = this.loop.bind(this);
    window.__game = this;
    window.__snap = async (name = 'shot') => { this.composer.render(); const url = this.canvas.toDataURL('image/png'); await fetch('/__save?name=' + name, { method: 'POST', body: url }); return 'saved ' + name; };
    this.frame(0.0001);
    this.composer.render();          // warm up shaders
    status('Ready', 100);

    const begin = () => {
      $('start').style.display = 'none';
      this.started = true;
      this.captureMouse();
      if (this.touchMode) { try { const el = document.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* optional */ } }
      this.audio.start();
      this.audio.setVolume(S.volume);
    };
    if (params.get('hold') === '1') {
      this.started = true;
      $('loading').style.display = 'none';
      const r = () => { requestAnimationFrame(r); this.render(); }; r();
      return;
    }
    setTimeout(() => {
      $('loading').classList.add('done');
      $('start').style.display = 'flex';
      const go = () => { window.removeEventListener('keydown', go); $('start').removeEventListener('click', go); begin(); };
      window.addEventListener('keydown', go, { once: true }); $('start').addEventListener('click', go, { once: true });
    }, 350);
    requestAnimationFrame(this.loop);
  }

  // ---------------- settings actions ----------------
  saveSettings() { saveSettings(this.settings); }
  setTime(h) {
    this.hour = ((h % 24) + 24) % 24;
    this.sky.setTime(this.hour);
    this.envDirty = true;
  }
  setTimeOfDay(h) { this.setTime(h); this.settings.time = this.hour; this.saveSettings(); }
  setWeather(k) { this.settings.weather = k; this.weather.set(k); this.saveSettings(); this.toast('Weather: ' + k); }
  changeSeed(k) { this.settings.seed = k; this.saveSettings(); location.search = ''; }
  applyRenderScale() { this.resize(); }
  applyViewDistance() {
    const v = this.settings.viewDist;
    this.far.maxDist = 5200 * v + 800;
    if (this.trees) this.trees.farR = this.QP.farR * v;
  }
  applyGrass() {
    if (!this.cover) return;
    this.cover.density = this.QP.grass * this.settings.grass;
    for (const c of this.cover.cells.values()) this.cover.destroyCell(c);
    this.cover.cells.clear();
  }

  setPaused(p) {
    this.paused = p;
    if (this.audio.master) this.audio.master.gain.setTargetAtTime(p ? this.audio.masterVol * 0.35 : (this.audio.muted ? 0 : this.audio.masterVol), this.audio.ctx.currentTime, 0.1);
  }

  updateEnv() {
    const tex = this.sky.buildEnv(this.renderer, this.pmrem);
    this.scene.environment = tex;
    this.scene.environmentIntensity = 1.7;
    if (this.car) this.car.setEnv(tex);
    this.envDirty = false; this._envHour = this.hour; this._envOv = this.sky.overcast;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!this.fixedPR) this.pixelRatio = this.dpr * this.settings.renderScale * this.dynScale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const size = new THREE.Vector2(); this.renderer.getDrawingBufferSize(size);
    this.composer.setSize(size.x, size.y);
  }

  // ---------------- input ----------------
  setupInput() {
    this.keys = {};
    this.steerSmooth = 0;
    this.pad = { steer: 0, thr: 0, brk: 0, hb: 0, prev: [], active: false };
    window.addEventListener('keydown', (e) => {
      if (this.ui.open && e.code !== 'Escape') return;
      if (e.repeat) { this.keys[e.code] = true; return; }
      this.keys[e.code] = true;
      switch (e.code) {
        case 'Escape': case 'KeyP': this.ui.toggle(); break;
        case 'KeyC': this.auto = !this.auto; this.toast(this.auto ? 'Autopilot on' : 'Autopilot off'); break;
        case 'KeyV': this.cycleCamera(); break;
        case 'KeyR': this.recover(); break;
        case 'KeyH': this.settings.showHud = !this.settings.showHud; this.hudEl.classList.toggle('hidden'); $('topbar').classList.toggle('hidden'); this.saveSettings(); break;
        case 'KeyT': this.setTimeOfDay(Math.floor(this.hour + 1.5) % 24); this.toast(`Time ${String(Math.floor(this.hour)).padStart(2, '0')}:00`); break;
        case 'KeyG': { const order = ['clear', 'partly', 'overcast', 'rain', 'storm', 'snow', 'fog']; this.setWeather(order[(order.indexOf(this.weather.name) + 1) % order.length]); break; }
        case 'KeyM': this.toast(this.audio.toggleMute() ? 'Muted' : 'Sound on'); break;
        case 'KeyN': this.toast(this.audio.toggleMusic() ? 'Music on' : 'Music off'); break;
        case 'KeyF': $('stats').style.display = $('stats').style.display === 'block' ? 'none' : 'block'; break;
        case 'KeyK': { const ks = Object.keys(PAINTS); const i = (ks.indexOf(this.settings.paint) + 1) % ks.length; this.settings.paint = ks[i]; this.car.setPaint(PAINTS[ks[i]]); this.saveSettings(); this.toast('Paint: ' + ks[i]); break; }
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    // mouse look: pointer lock (click the game to capture, Esc to release / open the menu); dragging with the left button works without lock
    const cv = this.canvas;
    window.addEventListener('mousemove', (e) => {
      if (this.ui.open || !this.started) return;
      if (document.pointerLockElement !== cv && !(e.buttons & 1)) return;
      const k = 0.0022 * (this.settings.mouse ?? 1), L = this.look;
      L.yaw -= e.movementX * k; L.pitch -= e.movementY * k; L.idle = 0;
    });
    cv.addEventListener('mousedown', () => this.captureMouse());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === cv) { this._lockAt = performance.now(); return; }
      if (this.started && !this.ui.open && !document.hidden && performance.now() - (this._lockAt || 0) > 250) this.ui.toggle(true);
    });
    window.addEventListener('blur', () => { this.keys = {}; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.keys = {}; });
  }

  captureMouse() {
    const cv = this.canvas;
    if (!this.started || this.touchMode || this.ui.open || (this.settings.mouse ?? 1) <= 0 || document.pointerLockElement === cv || !cv.requestPointerLock) return;
    try { const p = cv.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* needs a user gesture */ }
  }

  toast(msg) { const t = $('toast'); t.textContent = msg; t.style.opacity = 1; clearTimeout(this._tt); this._tt = setTimeout(() => t.style.opacity = 0, 1800); }

  cycleCamera() {
    const modes = ['chase', 'far', 'low', 'hood', 'cockpit'];
    this.camMode = modes[(modes.indexOf(this.camMode) + 1) % modes.length];
    this.settings.camera = this.camMode; this.saveSettings();
    this.toast('Camera: ' + this.camMode);
  }

  recover() {
    const v = this.vehicle;
    v.place(v.s, v.t < 0 ? -1.7 : 1.7, Math.max(v.fwdSpeed, 0));
    this.skids.reset();
    this.camDir.set(v.fwd.x, 0, v.fwd.z).normalize();
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && [...pads].find(p => p && p.connected);
    const P = this.pad;
    if (!gp) { P.active = false; return; }
    P.active = true;
    const dz = (v) => Math.abs(v) < 0.1 ? 0 : (v - Math.sign(v) * 0.1) / 0.9;
    P.steer = dz(gp.axes[0] || 0);
    P.thr = gp.buttons[7] ? gp.buttons[7].value : 0;
    P.brk = gp.buttons[6] ? gp.buttons[6].value : 0;
    P.hb = gp.buttons[0] && gp.buttons[0].pressed ? 1 : 0;
    const edge = (i, fn) => { const on = gp.buttons[i] && gp.buttons[i].pressed; if (on && !P.prev[i]) fn(); P.prev[i] = on; };
    edge(3, () => this.cycleCamera()); edge(9, () => this.ui.toggle()); edge(2, () => { this.auto = !this.auto; this.toast(this.auto ? 'Autopilot on' : 'Autopilot off'); }); edge(1, () => this.recover());
  }

  // ---------------- simulation ----------------
  step(dt, sub = 3) {
    const k = this.keys, v = this.vehicle;
    let throttle, brake, steer, hb;
    if (this.auto) {
      const c = this.autopilot.update(dt);
      throttle = c.throttle; brake = c.brake; steer = c.steer; hb = 0;
    } else {
      throttle = (k.KeyW || k.ArrowUp) ? 1 : 0;
      brake = (k.KeyS || k.ArrowDown) ? 1 : 0;
      const target = ((k.KeyD || k.ArrowRight) ? 1 : 0) - ((k.KeyA || k.ArrowLeft) ? 1 : 0);
      const rate = target === 0 ? 5 : (Math.sign(target) === Math.sign(this.steerSmooth) || this.steerSmooth === 0 ? 2.6 : 5.5);
      this.steerSmooth += clamp(target - this.steerSmooth, -rate * dt, rate * dt);
      steer = this.steerSmooth; hb = k.Space ? 1 : 0;
      if (this.pad.active) {
        if (Math.abs(this.pad.steer) > 0.01) steer = this.pad.steer;
        throttle = Math.max(throttle, this.pad.thr); brake = Math.max(brake, this.pad.brk); hb = Math.max(hb, this.pad.hb);
      }
    }
    v.snow = U.uSnow.value; v.wet = this.weather.wet;
    v.drive(throttle, brake, steer, hb, dt);
    v.step(dt, sub);
    this.collide();
    if (v.up.y < 0.15 && v.speed < 3) this.recover();
    this.time += dt;
  }

  // tree-trunk collisions: three circles along the car body
  collide() {
    if (!this.trees) return;
    const v = this.vehicle, hit = this._hit || (this._hit = { nx: 0, nz: 0, pen: 0 });
    let worst = 0;
    for (const off of [-1.45, 0, 1.45]) {
      const cx = v.pos.x + v.fwd.x * off, cz = v.pos.z + v.fwd.z * off;
      if (!this.trees.collide(cx, cz, 0.95, hit)) continue;
      v.pos.x += hit.nx * hit.pen; v.pos.z += hit.nz * hit.pen;
      const vn = v.vel.x * hit.nx + v.vel.z * hit.nz;
      if (vn < 0) {
        v.vel.x -= hit.nx * vn * 1.18; v.vel.z -= hit.nz * vn * 1.18;
        v.vel.multiplyScalar(0.985);
        v.omega.multiplyScalar(0.9);
        worst = Math.max(worst, -vn);
      }
    }
    if (worst > 2.5) { this.crash = Math.min(1, worst / 14); this.audio.thud && this.audio.thud(this.crash); }
  }

  updateCar() {
    const v = this.vehicle;
    this.carRoot.position.copy(v.pos);
    this.carRoot.quaternion.copy(v.quat);
    const hubLocal = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const wh = v.wheels[i];
      const w = this.car.wheels[i];
      hubLocal.copy(wh.hub).sub(v.pos).applyQuaternion(this._qinv.copy(v.quat).invert());
      w.pivot.position.set(hubLocal.x, hubLocal.y + SPEC.comH, hubLocal.z);
      w.pivot.rotation.set(0, -wh.steerA, 0);
      w.spinner.rotation.x = -wh.spin;
    }
    U.uCar.value.set(v.pos.x, v.pos.z, v.fwd.x, v.fwd.z).setW(v.fwd.z);
    { const l = Math.hypot(v.fwd.x, v.fwd.z) || 1; U.uCar.value.z = v.fwd.x / l; U.uCar.value.w = v.fwd.z / l; }
    const inside = this.camMode === 'cockpit' || this.camMode === 'hood';
    if (inside !== this._inside) { this._inside = inside; this.car.setInterior(inside); }
    if (inside) {
      const st = (v.wheels[0].steerA + v.wheels[1].steerA) * 0.5;
      this.car.setSteer(st / 0.62 * 2.4);
      if (this.camMode === 'cockpit') {
        const mph = this.settings.units === 'mph';
        const g = v.gear === -1 ? 'R' : Math.abs(v.fwdSpeed) < 0.3 && v.throttle < 0.05 ? 'N' : String(v.gear);
        this.car.updateCluster(this.time, Math.abs(v.fwdSpeed) * (mph ? 2.23694 : 3.6), v.rpm, g, mph ? 'mph' : 'km/h');
      }
    }
  }

  updateCarLights() {
    const v = this.vehicle;
    this.car.setBrake(v.brake > 0.2 || v.handbrake > 0.5);
    const n = (this.sky.sunDir.y < 0.07 || (this.weather.state.overcast > 0.8 && this.sky.sunDir.y < 0.25)) ? 1 : 0;
    if (n !== this._nightLights) { this._nightLights = n; this.car.setNight(n); }
  }

  updateEffects(dt) {
    const v = this.vehicle;
    const cp = this.particles;
    const wet = this.weather.wet;
    const cpx = this._cpv || (this._cpv = new THREE.Vector3());
    for (let i = 0; i < 4; i++) {
      const wh = v.wheels[i];
      if (!wh.contact) { this.skids.add(i, wh.hub, v.right, 0); continue; }
      const slip = Math.hypot(wh.slipRatio, wh.slipAngle);
      cpx.set(wh.hub.x, wh.hub.y - SPEC.radius, wh.hub.z);
      const skid = wh.surf === 0 ? clamp((slip - 0.32) * 2.2, 0, 1) : 0;
      this.skids.add(i, cpx, v.right, skid * (v.speed > 1.5 ? 1 : 0));
      const spd = v.speed;
      if (spd < 1.0) continue;
      let rate = 0, r = 0.7, g = 0.7, b = 0.7, a = 0.3, size = 0.5, up = 0.5;
      if (wh.surf === 0) {
        if (slip > 0.55) { rate = (slip - 0.4) * 60; r = g = b = 0.85; a = 0.28; size = 0.7; }
        if (wet > 0.3 && spd > 14 && wh.drive) { rate = Math.max(rate, spd * 0.9 * wet); r = g = b = 0.8; a = 0.16 * wet; size = 0.9; up = 0.9; }
      } else {
        rate = (0.4 + slip * 3) * spd * 0.9 * (wh.surf === 2 ? 0.7 : 1);
        if (wet > 0.4) { r = 0.32; g = 0.27; b = 0.2; a = 0.18; } else if (wh.surf === 2) { r = 0.42; g = 0.4; b = 0.28; a = 0.16; } else { r = 0.66; g = 0.58; b = 0.46; a = 0.3; }
        size = 0.9;
      }
      let n = rate * dt; const whole = Math.floor(n); n = whole + (Math.random() < n - whole ? 1 : 0);
      for (let k = 0; k < n; k++) {
        cp.emit(cpx.x + (Math.random() - 0.5) * 0.3, cpx.y + 0.15, cpx.z + (Math.random() - 0.5) * 0.3,
          -v.vel.x * 0.12 + (Math.random() - 0.5) * 1.5, up + Math.random() * 0.8, -v.vel.z * 0.12 + (Math.random() - 0.5) * 1.5,
          1.1 + Math.random() * 1.2, size * 0.4, size * (1.8 + Math.random()), r, g, b, a);
      }
    }
    this.skids.flush();
    const l = this._pl || (this._pl = new THREE.Color());
    l.copy(U.uSkyAmb.value).multiplyScalar(0.55).add(U.uSunColor.value.clone().multiplyScalar(0.55 * Math.max(this.sky.sunDir.y, 0)));
    const mx = Math.max(l.r, l.g, l.b, 1e-3); l.multiplyScalar(Math.min(1, 1 / mx) * Math.min(1, mx * 1.2 + 0.08));
    this.particles.update(dt, this.camera, this.renderer.domElement.height / this.renderer.getPixelRatio(), l);
  }

  updateCamera(dt, snap = false) {
    const v = this.vehicle, cam = this.camera;
    if (this.camMode === 'free') return;
    const fwdH = new THREE.Vector3(v.fwd.x, 0, v.fwd.z).normalize();
    const velH = new THREE.Vector3(v.vel.x, 0, v.vel.z);
    let want = fwdH;
    if (velH.length() > 4 && v.fwdSpeed > 0) { velH.normalize(); want = fwdH.clone().lerp(velH, 0.55).normalize(); }
    const kd = snap ? 1 : 1 - Math.exp(-dt * 3.2);
    this.camDir.lerp(want, kd).normalize();
    {   // mouse look eases back to centre a moment after the mouse stops
      const L = this.look; L.idle += dt;
      if (L.yaw > Math.PI) L.yaw -= 2 * Math.PI; else if (L.yaw < -Math.PI) L.yaw += 2 * Math.PI;
      if (L.idle > (this.camMode === 'cockpit' || this.camMode === 'hood' ? 3.5 : 2.5)) { const k = 1 - Math.exp(-dt * 2.5); L.yaw -= L.yaw * k; L.pitch -= L.pitch * k; }
    }
    const sp = v.speed;
    const carPos = v.pos;
    let pos, look, fov = this.settings.fov + Math.min(sp * 0.14, 7);
    const m = this.camMode;
    this.crash = (this.crash || 0) * Math.exp(-dt * 3);
    const shake = this.settings.shake * (Math.min(sp / 45, 1) * (v.wheels[2].surf === 0 ? 0.6 : 1.8) + this.crash * 4);
    this.shakeT += dt;
    const sx = (Math.sin(this.shakeT * 31.1) + Math.sin(this.shakeT * 17.3 + 1.3)) * 0.5 * shake, sy = (Math.sin(this.shakeT * 27.7 + 2.1) + Math.sin(this.shakeT * 13.1)) * 0.5 * shake;
    if (m === 'chase' || m === 'far' || m === 'low') {
      const dist = m === 'far' ? 10.5 : m === 'low' ? 5.2 : 6.4, height = m === 'far' ? 3.6 : m === 'low' ? 0.85 : 1.95;
      // mouse orbit: view yaw swings the camera around the car, view pitch (up) lowers it
      const L = this.look, ya = L.yaw, el = -clamp(L.pitch, -1.05, 0.3);
      const dirL = this._dirL.copy(this.camDir).applyAxisAngle(this._up, ya);
      pos = carPos.clone().addScaledVector(dirL, -dist * Math.cos(el));
      pos.y = carPos.y - SPEC.comH + height + dist * Math.sin(el);
      look = carPos.clone().addScaledVector(this.camDir, 5.5 * Math.cos(ya)); look.y = carPos.y - SPEC.comH + (m === 'low' ? 1.0 : 1.3);
      const gy = this.world.height(pos.x, pos.z) + 0.6;
      if (pos.y < gy) pos.y = gy;
      // smooth the offset relative to the car (not the world position) so the camera never trails behind at high speed
      const offT = pos.clone().sub(carPos), lookT = look.clone().sub(carPos);
      const kh = snap ? 1 : 1 - Math.exp(-dt * 16), kv = snap ? 1 : 1 - Math.exp(-dt * (this.look.idle < 0.4 ? 14 : 5));
      if (!this.camOff) { this.camOff = offT.clone(); this.lookOff = lookT.clone(); }
      this.camOff.x += (offT.x - this.camOff.x) * kh; this.camOff.z += (offT.z - this.camOff.z) * kh; this.camOff.y += (offT.y - this.camOff.y) * kv;
      this.lookOff.x += (lookT.x - this.lookOff.x) * kh; this.lookOff.z += (lookT.z - this.lookOff.z) * kh; this.lookOff.y += (lookT.y - this.lookOff.y) * kv;
      this.camPos.copy(carPos).add(this.camOff); this.camLook.copy(carPos).add(this.lookOff);
      cam.position.copy(this.camPos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.camLook);
      cam.rotateZ(sx * 0.0016); cam.rotateX(sy * 0.0012);
    } else {
      const off = m === 'hood' ? new THREE.Vector3(0, 1.08, -1.05) : new THREE.Vector3(-0.36, 1.14, 0.09);
      const q = v.quat;
      const p = off.applyQuaternion(q).add(new THREE.Vector3(carPos.x, carPos.y - SPEC.comH, carPos.z));
      cam.position.copy(p);
      // free look from the driver's seat
      const L = this.look;
      const lk = new THREE.Vector3(0, -0.25, -20).applyAxisAngle(this._x, clamp(L.pitch, -0.9, 1.0)).applyAxisAngle(this._up, clamp(L.yaw, -2.3, 2.3)).applyQuaternion(q).add(p);
      cam.up.set(0, 1, 0).applyQuaternion(q).lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
      cam.lookAt(lk);
      cam.rotateZ(sx * 0.002); cam.rotateX(sy * 0.0016);
      fov = (m === 'cockpit' ? this.settings.fov + 12 : this.settings.fov + 6) + Math.min(sp * 0.15, 8);
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * (snap ? 1 : 1 - Math.exp(-dt * 3)); cam.updateProjectionMatrix(); }
  }

  updateLights() {
    const sd = this.sky.sunDir;
    const sc = this.sky.sunColor;
    const day = clamp(sd.y * 6, 0, 1);
    const mx = Math.max(sc.r, sc.g, sc.b, 1e-3);
    if (day > 0.001) {
      this.csm.lightDirection.copy(sd).negate();
      for (const l of this.csm.lights) { l.color.copy(sc).multiplyScalar(1 / mx); l.intensity = 6.8 * mx * day + 0.0001; l.castShadow = day > 0.02; }
    } else {
      // moonlight
      this.csm.lightDirection.copy(sd);
      const md = clamp(-sd.y * 5, 0, 1);
      for (const l of this.csm.lights) { l.color.setRGB(0.55, 0.65, 1.0); l.intensity = 0.45 * md; l.castShadow = md > 0.3; }
    }
    const cam = this.camera;
    if (Math.abs(cam.fov - this._csmFov) > 0.4 || Math.abs(cam.aspect - this._csmAspect) > 0.01) {
      this._csmFov = cam.fov; this._csmAspect = cam.aspect; this.csm.updateFrustums();
    }
    this.csm.update();
  }

  updateTime(dt) {
    const rate = timeFlowRate(this.settings.timeFlow);
    if (rate > 0 && !this.paused) {
      this.hour = (this.hour + rate * dt / 60) % 24;
      this._timeAcc = (this._timeAcc || 0) + dt;
      if (this._timeAcc > 0.5) { this._timeAcc = 0; this.sky.setTime(this.hour); this.settings.time = this.hour; }
    }
    const ov = this.sky.overcast;
    if (Math.abs(ov - (this._lastOv ?? -1)) > 0.01 || Math.abs((this.sky.fogAmount || 0) - (this._lastFog ?? -1)) > 0.01) {
      this._lastOv = ov; this._lastFog = this.sky.fogAmount; this.sky.setTime(this.hour);
    }
    this._envT = (this._envT || 0) + dt;
    const hourMoved = Math.abs(this.hour - (this._envHour ?? -99)) > 0.12;
    const ovMoved = Math.abs(this.sky.overcast - (this._envOv ?? -1)) > 0.08;
    if ((this.envDirty && this._envT > 0.3) || ((hourMoved || ovMoved) && this._envT > 3)) { this._envT = 0; this.updateEnv(); }
  }

  frame(dt) {
    this.pollGamepad();
    if (!this.paused) {
      // variable time-step physics (>=180 Hz sub-steps): no fixed-step judder on 90/120/144 Hz displays
      const d = Math.min(dt, 0.05);
      if (d > 1e-5) this.step(d, Math.max(2, Math.ceil(d * 180)));
    }
    this.world.ensure(this.vehicle.s + 9500);
    this.updateCar();
    this.updateCarLights();
    if (!this.paused) this.updateEffects(dt);
    this.updateCamera(dt);
    updateCommonUniforms(this.camera, this.time);
    this.weather.update(this.paused ? 0 : dt, this.camera, this.vehicle, this.time);
    this.updateTime(dt);
    this.updateLights();
    if (this.envDirty && !this.scene.environment) this.updateEnv();
    this.ground.update(this.vehicle.s, this.camera.position);
    this.roadside.update(this.vehicle.s);
    this.far.update(this.camera.position, 3);
    if (this.trees) { this.trees.update(this.camera.position, 1); this.cover.update(this.camera.position, 1); }
    this.sky.mesh.position.copy(this.camera.position);
    const g = this.grade.uniforms;
    g.uTime.value = this.time;
    g.uSpeed.value = clamp((this.vehicle.speed - 22) / 60, 0, 1) * 0.02 * (this.camMode === 'cockpit' ? 0.6 : 1);
    this.exposure();
    this.updateSunScreen();
    this.updateHud();
    if (this.audio.started) this.updateAudio(dt);
  }

  updateAudio(dt) {
    const v = this.vehicle, w = this.weather;
    this.audio.update({
      rpm: v.rpm, throttle: v.throttle, speed: v.speed, slip: v.slip, surf: v.wheels[2].surf, cam: this.camMode,
      night: this.sky.night, rain: this.paused ? w.state.rain * 0.4 : w.state.rain, wind: w.wind, dt,
    });
  }

  exposure() {
    const el = this.sky.sunDir.y;
    let e = 0.72;
    if (el < 0.2) e = THREE.MathUtils.lerp(2.8, 0.72, clamp((el + 0.12) / 0.32, 0, 1));
    e *= 1 + this.sky.overcast * 0.55;
    this.grade.uniforms.uExposure.value = e * (this.expBoost || 1);
  }

  updateSunScreen() {
    const sd = this.sky.sunDir;
    const p = new THREE.Vector3().copy(this.camera.position).addScaledVector(sd, 1000).project(this.camera);
    const vis = p.z < 1 && Math.abs(p.x) < 1.4 && Math.abs(p.y) < 1.4 && sd.y > -0.02 ? 1 : 0;
    this.grade.uniforms.uSunScreen.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, vis * clamp(sd.y * 8 + 0.2, 0, 1) * (1 - this.sky.overcast));
    this.grade.uniforms.uSunColor.value.copy(this.sky.sunColor).multiplyScalar(0.8);
  }

  updateHud() {
    const v = this.vehicle;
    if (!this._hudT || this.time - this._hudT > 0.08 || this.paused) {
      this._hudT = this.time;
      const mph = this.settings.units === 'mph';
      $('speed').firstChild.nodeValue = Math.round(Math.abs(v.fwdSpeed) * (mph ? 2.23694 : 3.6));
      $('gearTxt').textContent = (this.auto ? 'AUTO · ' : '') + (v.gear === -1 ? 'R' : Math.abs(v.fwdSpeed) < 0.3 && v.throttle < 0.05 ? 'N' : v.gear);
      $('rpmfill').style.width = clamp((v.rpm - 800) / 6000, 0, 1) * 100 + '%';
      const hh = Math.floor(this.hour), mm = Math.floor((this.hour - hh) * 60);
      $('clock').innerHTML = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}<br><span style="opacity:.6">${(v.distance / 1000).toFixed(1)} km</span>`;
      const st = $('stats');
      if (st.style.display === 'block') {
        const r = this.renderer.info.render;
        st.textContent = `fps ${this.fps | 0}  pr ${this.pixelRatio.toFixed(2)}\ncalls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k\nchunks ${this.ground.stats.chunks} tiles ${this.far.stats.tiles}\ngrass ${this.cover ? this.cover.stats.grass : 0} trees ${this.trees ? this.trees.stats.trees : 0} cells ${this.trees ? this.trees.stats.near + '/' + this.trees.stats.far : 0}\ns ${v.s.toFixed(0)} t ${v.t.toFixed(2)}  ${v.speedKmh.toFixed(0)} km/h g${v.gear}`;
      }
    }
  }

  adaptResolution(rawDt) {
    if (!this.settings.dynamicRes || this.fixedPR) return;
    this._avgDt = this._avgDt ? this._avgDt * 0.96 + rawDt * 0.04 : rawDt;
    this._adaptT = (this._adaptT || 0) + rawDt;
    if (this._adaptT < 2.0 || document.hidden || this.paused) return;
    this._adaptT = 0;
    const fps = 1 / this._avgDt;
    let ds = this.dynScale;
    if (fps < 50) ds = Math.max(0.55, ds * (fps < 35 ? 0.85 : 0.94));
    else if (fps > 57 && ds < 1) ds = Math.min(1, ds * 1.04);
    if (Math.abs(ds - this.dynScale) > 0.01) { this.dynScale = ds; this.resize(); }
  }

  loop() {
    requestAnimationFrame(this.loop);
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 0.1);
    this.fps = this.fps ? this.fps * 0.95 + (1 / Math.max(raw, 1e-4)) * 0.05 : 60;
    this.adaptResolution(raw);
    this.frame(dt);
    this.composer.render();
  }

  // ---- deterministic helpers for automated tests ----
  advance(seconds, dt = 1 / 60) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      this.step(dt);
      this.updateCar(); this.updateCamera(dt);
      if (i % 30 === 0) this.ground.update(this.vehicle.s, this.vehicle.pos);
    }
    this.frame(0.0001);
    this.settle();
  }

  teleport(sPos, speedKmh = 60) {
    this.vehicle.place(sPos, 1.7, speedKmh / 3.6);
    this.updateCar(); this.updateCamera(0, true); this.updateCamera(0, true);
    this.settle();
    this.frame(0.0001);
  }

  settle() {
    this.ground.prime(this.vehicle.s);
    this.far.primeAll(this.camera.position);
    if (this.trees) { this.trees.frame = 0; this.trees.update(this.camera.position, 500); this.trees.updateLod(this.camera.position); this.cover.prime(this.camera.position); }
  }

  render() { this.composer.render(); }

  setCam(p, l, fov) { this.camMode = 'free'; this.camera.position.set(...p); this.camera.up.set(0, 1, 0); this.camera.lookAt(...l); if (fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); } }
}

const game = new Game();
game.init().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:60px;left:20px;color:#f88;z-index:99;font-size:12px">${e.stack}</pre>`);
});
