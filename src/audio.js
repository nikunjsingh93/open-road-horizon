// Procedural audio: engine, wind, tyres, ambience, generative music. No audio files needed.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.masterVol = 0.8;
    this.musicVol = 0.5;
    this.musicOn = true;
    this._birdT = 2; this._gearFlag = 0;
    this.nextChord = 0; this.chordIdx = 0;
  }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    this.started = true;
    const master = this.master = ctx.createGain(); master.gain.value = this.masterVol;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    master.connect(comp); comp.connect(ctx.destination);

    // ---- noise buffers ----
    const sr = ctx.sampleRate;
    const mkNoise = (secs, type) => {
      const b = ctx.createBuffer(1, sr * secs, sr); const d = b.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        if (type === 'pink') { b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
        else if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else d[i] = w;
      }
      return b;
    };
    this.noiseW = mkNoise(2, 'white'); this.noiseP = mkNoise(3, 'pink'); this.noiseB = mkNoise(3, 'brown');
    const loopSrc = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

    // ---- engine ----
    const eng = this.eng = { out: ctx.createGain() };
    eng.out.gain.value = 0;
    const lp = eng.lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 0.9;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 1.8); }
    shaper.curve = curve; shaper.oversample = '2x';
    const mk = (type, gain) => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = gain; o.connect(g); g.connect(shaper); o.start(); return { o, g }; };
    eng.saw1 = mk('sawtooth', 0.30); eng.saw2 = mk('sawtooth', 0.20); eng.sq = mk('square', 0.12); eng.tri = mk('triangle', 0.22);
    shaper.connect(lp);
    const res = ctx.createBiquadFilter(); res.type = 'peaking'; res.frequency.value = 420; res.gain.value = 6; res.Q.value = 1.2;
    lp.connect(res); res.connect(eng.out);
    // intake / exhaust hiss
    const hiss = ctx.createBufferSource(); hiss.buffer = this.noiseW; hiss.loop = true; hiss.start();
    const hbp = ctx.createBiquadFilter(); hbp.type = 'bandpass'; hbp.frequency.value = 900; hbp.Q.value = 0.7;
    const hg = eng.hiss = ctx.createGain(); hg.gain.value = 0;
    hiss.connect(hbp); hbp.connect(hg); hg.connect(eng.out);
    eng.hbp = hbp;
    // cabin filter (muffles in cockpit view)
    const cab = eng.cab = ctx.createBiquadFilter(); cab.type = 'lowpass'; cab.frequency.value = 20000;
    eng.out.connect(cab); cab.connect(master);

    // ---- wind ----
    const w = this.wind = {}; w.src = loopSrc(this.noiseP);
    w.lp = ctx.createBiquadFilter(); w.lp.type = 'lowpass'; w.lp.frequency.value = 500;
    w.g = ctx.createGain(); w.g.gain.value = 0;
    w.src.connect(w.lp); w.lp.connect(w.g); w.g.connect(master);

    // ---- road / tyre ----
    const t = this.tyre = {}; t.src = loopSrc(this.noiseB);
    t.bp = ctx.createBiquadFilter(); t.bp.type = 'bandpass'; t.bp.frequency.value = 400; t.bp.Q.value = 0.6;
    t.g = ctx.createGain(); t.g.gain.value = 0;
    t.src.connect(t.bp); t.bp.connect(t.g); t.g.connect(master);
    // ---- tyre squeal / burnout ----
    // A burning-rubber howl: a raspy, harmonically rich 1-2.5 kHz screech with irregular pitch wander (stick-slip), a fast
    // 90-180 Hz "tearing" amplitude flutter, a broadband scrub/hiss bed and a low grainy rumble under it. Loud and coarse on purpose.
    const sq = this.squeal = {};
    sq.out = ctx.createGain(); sq.out.gain.value = 1;
    sq.tone = ctx.createGain(); sq.tone.gain.value = 0;
    sq.am = ctx.createGain(); sq.am.gain.value = 0.62;
    sq.o1 = ctx.createOscillator(); sq.o1.type = 'sawtooth'; sq.o1.frequency.value = 1200;
    sq.o2 = ctx.createOscillator(); sq.o2.type = 'sawtooth'; sq.o2.frequency.value = 1200 * 1.5;
    sq.o3 = ctx.createOscillator(); sq.o3.type = 'square'; sq.o3.frequency.value = 1200 * 2.02;
    sq.o4 = ctx.createOscillator(); sq.o4.type = 'sawtooth'; sq.o4.frequency.value = 1200 * 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.7; const g3 = ctx.createGain(); g3.gain.value = 0.3; const g4 = ctx.createGain(); g4.gain.value = 0.45;
    sq.flut = ctx.createOscillator(); sq.flut.type = 'sawtooth'; sq.flut.frequency.value = 110;
    sq.fd = ctx.createGain(); sq.fd.gain.value = 0.38; sq.flut.connect(sq.fd); sq.fd.connect(sq.am.gain);
    // irregular pitch wander from slow filtered noise + a vibrato
    sq.jsrc = loopSrc(this.noiseP);
    const jlp = ctx.createBiquadFilter(); jlp.type = 'lowpass'; jlp.frequency.value = 22;
    sq.jd = ctx.createGain(); sq.jd.gain.value = 260;
    sq.jsrc.connect(jlp); jlp.connect(sq.jd);
    sq.wob = ctx.createOscillator(); sq.wob.type = 'sine'; sq.wob.frequency.value = 7.5;
    sq.wd = ctx.createGain(); sq.wd.gain.value = 28; sq.wob.connect(sq.wd);
    for (const o of [sq.o1, sq.o2, sq.o3, sq.o4]) { sq.jd.connect(o.detune); sq.wd.connect(o.detune); }
    sq.body = ctx.createBiquadFilter(); sq.body.type = 'bandpass'; sq.body.frequency.value = 2600; sq.body.Q.value = 0.7;
    sq.hp = ctx.createBiquadFilter(); sq.hp.type = 'highpass'; sq.hp.frequency.value = 500;
    sq.lp = ctx.createBiquadFilter(); sq.lp.type = 'lowpass'; sq.lp.frequency.value = 7500; sq.lp.Q.value = 0.4;
    sq.o1.connect(sq.am); sq.o2.connect(g2); g2.connect(sq.am); sq.o3.connect(g3); g3.connect(sq.am); sq.o4.connect(g4); g4.connect(sq.am);
    sq.am.connect(sq.body); sq.body.connect(sq.hp); sq.hp.connect(sq.lp); sq.lp.connect(sq.tone); sq.tone.connect(sq.out);
    for (const o of [sq.o1, sq.o2, sq.o3, sq.o4, sq.flut, sq.wob]) o.start();
    // scrub / hiss bed
    sq.nsrc = loopSrc(this.noiseW);
    sq.nbp = ctx.createBiquadFilter(); sq.nbp.type = 'bandpass'; sq.nbp.frequency.value = 2400; sq.nbp.Q.value = 0.55;
    sq.ng = ctx.createGain(); sq.ng.gain.value = 0;
    sq.nsrc.connect(sq.nbp); sq.nbp.connect(sq.ng); sq.ng.connect(sq.out);
    // grainy low rumble (locked / spinning rubber on tarmac, or gravel)
    sq.lsrc = loopSrc(this.noiseB);
    sq.lbp = ctx.createBiquadFilter(); sq.lbp.type = 'bandpass'; sq.lbp.frequency.value = 380; sq.lbp.Q.value = 0.6;
    sq.lg = ctx.createGain(); sq.lg.gain.value = 0;
    sq.lam = ctx.createOscillator(); sq.lam.type = 'sawtooth'; sq.lam.frequency.value = 38;
    sq.lad = ctx.createGain(); sq.lad.gain.value = 0.3; sq.lam.connect(sq.lad); sq.lad.connect(sq.lg.gain); sq.lam.start();
    sq.lsrc.connect(sq.lbp); sq.lbp.connect(sq.lg); sq.lg.connect(sq.out);
    sq.out.connect(master);

    // ---- ambience: rustling trees / meadow wind ----
    const am = this.amb = {}; am.src = loopSrc(this.noiseP);
    am.bp = ctx.createBiquadFilter(); am.bp.type = 'bandpass'; am.bp.frequency.value = 700; am.bp.Q.value = 0.4;
    am.g = ctx.createGain(); am.g.gain.value = 0.06;
    am.src.connect(am.bp); am.bp.connect(am.g); am.g.connect(master);
    // rain
    const rn = this.rain = {}; rn.src = loopSrc(this.noiseW);
    rn.hp = ctx.createBiquadFilter(); rn.hp.type = 'highpass'; rn.hp.frequency.value = 1500;
    rn.lp = ctx.createBiquadFilter(); rn.lp.type = 'lowpass'; rn.lp.frequency.value = 9000;
    rn.g = ctx.createGain(); rn.g.gain.value = 0;
    rn.src.connect(rn.hp); rn.hp.connect(rn.lp); rn.lp.connect(rn.g); rn.g.connect(master);
    // crickets
    const cr = this.crick = {}; cr.o = ctx.createOscillator(); cr.o.frequency.value = 4300; cr.o.type = 'sine';
    cr.am = ctx.createGain(); cr.am.gain.value = 0;
    cr.lfo = ctx.createOscillator(); cr.lfo.frequency.value = 38; cr.lfo.type = 'square';
    cr.lg = ctx.createGain(); cr.lg.gain.value = 0.5;
    cr.g = ctx.createGain(); cr.g.gain.value = 0;
    cr.lfo.connect(cr.lg); cr.lg.connect(cr.am.gain);
    cr.o.connect(cr.am); cr.am.connect(cr.g); cr.g.connect(master);
    cr.o.start(); cr.lfo.start();

    // ---- music bus (with convolution reverb) ----
    const mus = this.mus = { out: ctx.createGain() };
    mus.out.gain.value = 0;
    const conv = ctx.createConvolver();
    const irLen = sr * 4.5, ir = ctx.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.6); }
    conv.buffer = ir;
    const dry = ctx.createGain(); dry.gain.value = 0.55; const wet = ctx.createGain(); wet.gain.value = 0.9;
    mus.bus = ctx.createGain();
    mus.bus.connect(dry); mus.bus.connect(conv); conv.connect(wet);
    dry.connect(mus.out); wet.connect(mus.out); mus.out.connect(master);
    this.nextChord = ctx.currentTime + 0.5;
  }

  thud(k) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.9 * k, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    const n = ctx.createBufferSource(); n.buffer = this.noiseW; const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 900;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.7 * k, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(this.master); n.connect(bp); bp.connect(ng); ng.connect(this.master);
    o.start(t); o.stop(t + 0.5); n.start(t, Math.random()); n.stop(t + 0.35);
  }

  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVol, this.ctx.currentTime, 0.05); return this.muted; }
  toggleMusic() { this.musicOn = !this.musicOn; return this.musicOn; }
  setVolume(v) { this.masterVol = v; if (this.master && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setMusicVolume(v) { this.musicVol = v; }

  _chord(t) {
    const ctx = this.ctx;
    const progs = [[0, 4, 7, 11], [-3, 0, 4, 7], [-7, -3, 0, 4], [-5, -1, 2, 5]];   // Cmaj7, Am7, Fmaj7, G
    const ch = progs[this.chordIdx++ % progs.length];
    const root = 174.61;   // F3
    const dur = 9.0;
    for (const semi of ch) {
      for (const [type, mul, gain] of [['sine', 1, 0.5], ['triangle', 2, 0.10], ['sine', 0.5, 0.25]]) {
        const o = ctx.createOscillator(); o.type = type;
        o.frequency.value = root * Math.pow(2, semi / 12) * mul * (1 + (Math.random() - 0.5) * 0.004);
        const g = ctx.createGain(); g.gain.value = 0;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
        o.connect(lp); lp.connect(g); g.connect(this.mus.bus);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain * 0.11, t + 3.5);
        g.gain.linearRampToValueAtTime(0, t + dur + 3);
        o.start(t); o.stop(t + dur + 3.2);
      }
    }
    // occasional soft bell
    if (Math.random() < 0.7) {
      const bell = [12, 16, 19, 23, 14][(Math.random() * 5) | 0];
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = root * 2 * Math.pow(2, bell / 12);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t + 2.2); g.gain.linearRampToValueAtTime(0.035, t + 2.35); g.gain.exponentialRampToValueAtTime(0.0008, t + 8);
      o.connect(g); g.connect(this.mus.bus); o.start(t + 2.2); o.stop(t + 8.2);
    }
  }

  _bird() {
    const ctx = this.ctx, t = ctx.currentTime;
    const base = 2200 + Math.random() * 2600;
    const notes = 2 + ((Math.random() * 4) | 0);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.random() * 2 - 1;
    const out = ctx.createGain(); out.gain.value = 0.05 + Math.random() * 0.05;
    if (pan) { out.connect(pan); pan.connect(this.master); } else out.connect(this.master);
    let tt = t;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator(); o.type = 'sine';
      const g = ctx.createGain();
      const f0 = base * (0.85 + Math.random() * 0.3), f1 = f0 * (0.7 + Math.random() * 0.7);
      const d = 0.06 + Math.random() * 0.09;
      o.frequency.setValueAtTime(f0, tt); o.frequency.exponentialRampToValueAtTime(f1, tt + d);
      g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(1, tt + 0.012); g.gain.exponentialRampToValueAtTime(0.001, tt + d + 0.02);
      o.connect(g); g.connect(out); o.start(tt); o.stop(tt + d + 0.05);
      tt += d + 0.05 + Math.random() * 0.06;
    }
  }

  // s: { rpm, throttle, speed, slip, surf, cam, night, rain, gearShift, dt, wetness, insideTrees }
  update(s) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime, now = t;
    const rpm = s.rpm, thr = s.throttle;
    const f = rpm / 60 * 2;       // firing frequency
    const e = this.eng;
    const tc = 0.03;
    e.saw1.o.frequency.setTargetAtTime(f, t, tc); e.saw2.o.frequency.setTargetAtTime(f * 2.003, t, tc);
    e.sq.o.frequency.setTargetAtTime(f * 0.5, t, tc); e.tri.o.frequency.setTargetAtTime(f * 3, t, tc);
    const load = Math.min(1, thr * 0.75 + 0.25);
    e.lp.frequency.setTargetAtTime(350 + rpm * 0.55 + load * 1400, t, 0.05);
    e.hiss.gain.setTargetAtTime(0.02 + thr * 0.08 * (rpm / 6500), t, 0.06);
    e.hbp.frequency.setTargetAtTime(700 + rpm * 0.4, t, 0.1);
    const inCab = s.cam === 'cockpit' ? 1 : s.cam === 'hood' ? 0.55 : 0;
    e.cab.frequency.setTargetAtTime(20000 - inCab * 17000, t, 0.1);
    e.out.gain.setTargetAtTime((0.20 + load * 0.28 + Math.min(rpm / 7000, 1) * 0.08) * (1 - inCab * 0.25), t, 0.05);
    // wind + tyres
    const sp = s.speed;
    this.wind.g.gain.setTargetAtTime(Math.min(Math.pow(sp / 45, 2) * 0.32, 0.5) * (1 - inCab * 0.5), t, 0.1);
    this.wind.lp.frequency.setTargetAtTime(280 + sp * 22, t, 0.1);
    const gravel = s.surf === 2 ? 1.6 : s.surf === 1 ? 1.3 : 1;
    this.tyre.g.gain.setTargetAtTime(Math.min(sp / 40, 1) * 0.16 * gravel * (1 + s.rain * 0.8), t, 0.1);
    this.tyre.bp.frequency.setTargetAtTime(220 + sp * 10 * (s.surf === 0 ? 1 : 0.7), t, 0.1);
    {
      const q = this.squeal, moving = sp > 2.5 ? 1 : 0, tarmac = s.surf === 0 ? 1 : 0;
      const lat = Math.min(1, Math.max(0, (s.slipAng - 0.10) / 0.14)) * moving;          // cornering slip
      const lock = Math.min(1, Math.max(0, (s.lockR - 0.30) / 0.40)) * moving;            // wheels locked or spinning
      const spin = Math.min(1, Math.max(0, (s.spinR - 0.35) / 0.45)) * moving;            // wheelspin / burnout
      const hb = s.hb > 0.5 && sp > 3 ? 1 : 0;
      const slide = Math.max(lock, hb * 0.9);
      const howl = Math.max(lat, slide * 0.85, spin);
      // pitch: cornering wails ~0.9-1.5 kHz; a burnout howls higher and rises with wheelspeed
      const f0 = Math.min(2300, Math.max(620, 760 + s.slipAng * 850 + sp * 9 + spin * 500 - hb * 180));
      q.o1.frequency.setTargetAtTime(f0, t, 0.05); q.o2.frequency.setTargetAtTime(f0 * 1.5, t, 0.05);
      q.o3.frequency.setTargetAtTime(f0 * 2.02, t, 0.05); q.o4.frequency.setTargetAtTime(f0 * 0.5, t, 0.05);
      q.flut.frequency.setTargetAtTime(80 + howl * 90, t, 0.1);
      q.fd.gain.setTargetAtTime(0.25 + howl * 0.25, t, 0.1);
      q.body.frequency.setTargetAtTime(f0 * 2.0, t, 0.08);
      q.tone.gain.setTargetAtTime(Math.min(0.3, (lat * lat * 0.2 + slide * 0.16 + spin * 0.26) * tarmac), t, 0.04);
      q.ng.gain.setTargetAtTime(Math.min(0.3, (lat * 0.1 + slide * 0.2 + spin * 0.24) * (tarmac ? 1 : 0.5) * Math.min(sp / 12, 1)), t, 0.05);
      q.nbp.frequency.setTargetAtTime(1800 + f0 * 0.6, t, 0.1);
      q.lg.gain.setTargetAtTime(Math.min(0.36, (slide * 0.26 + spin * 0.16 + lat * 0.05) * Math.min(sp / 9, 1) * (tarmac ? 1 : 1.6)), t, 0.06);
      q.lbp.frequency.setTargetAtTime((tarmac ? 320 : 650) + sp * 9, t, 0.1);
    }
    // ambience
    const day = 1 - s.night;
    this.amb.g.gain.setTargetAtTime(0.03 + 0.06 * (1 - Math.min(sp / 40, 1)) + s.wind * 0.05, t, 0.4);
    this.amb.bp.frequency.setTargetAtTime(500 + s.wind * 500, t, 0.5);
    this.rain.g.gain.setTargetAtTime(s.rain * 0.22 * (1 - inCab * 0.3), t, 0.4);
    this.crick.g.gain.setTargetAtTime(s.night > 0.6 && s.rain < 0.2 ? 0.012 * Math.min(1, (1 - Math.min(sp / 30, 1))) + 0.004 : 0, t, 0.5);
    this._birdT -= s.dt;
    if (this._birdT <= 0 && day > 0.4 && s.rain < 0.3 && !this.muted) {
      this._birdT = 2 + Math.random() * 7 + sp * 0.05;
      if (sp < 50) this._bird();
    }
    // music
    this.mus.out.gain.setTargetAtTime(this.musicOn ? this.musicVol * 0.9 : 0, t, 0.8);
    if (this.musicOn && t >= this.nextChord) { this._chord(t + 0.05); this.nextChord = t + 8.5; }
  }
}
