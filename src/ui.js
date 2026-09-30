import { PAINTS } from './car.js';

export const DEFAULTS = {
  time: 16.8, timeFlow: 'slow', weather: 'clear', season: 'summer', paint: 'red', units: 'kmh', quality: 'high',
  renderScale: 1.0, dynamicRes: true, fov: 60, volume: 0.8, music: 0.45, sfx: 1, camera: 'chase',
  viewDist: 1.0, grass: 1.0, showHud: true, shake: 1.0, mouse: 1.0,
  gearbox: 'auto', power: 1.0, grip: 1.0, tc: true,
};

const KEY = 'openroad.settings.v1';
export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { return { ...DEFAULTS }; }
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

const TIME_FLOW = { off: 0, slow: 24 / 60, normal: 24 / 24, fast: 24 / 6 };   // in-game hours per real minute
export const timeFlowRate = (k) => TIME_FLOW[k] ?? 0;

export class UI {
  constructor(game) {
    this.game = game;
    this.menu = document.getElementById('menu');
    this.panel = document.getElementById('panel');
    this.open = false;
    this.menu.addEventListener('mousedown', (e) => { if (e.target === this.menu) this.toggle(false); });
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.menu.classList.toggle('open', this.open);
    if (this.open) this.build();
    this.game.setPaused(this.open);
    if (this.open) { if (document.exitPointerLock) document.exitPointerLock(); } else this.game.captureMouse();
  }

  build() {
    const g = this.game, s = g.settings;
    const p = this.panel;
    p.innerHTML = '';
    const h = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
    p.appendChild(h('<h1>Open Road</h1>'));
    p.appendChild(h('<div class="sub">Settings &nbsp;·&nbsp; changes apply instantly &nbsp;·&nbsp; Esc to resume</div>'));
    const grid = h('<div class="grid"></div>');
    p.appendChild(grid);
    const sec = (t) => grid.appendChild(h(`<div class="sec">${t}</div>`));
    const seg = (label, opts, cur, onPick) => {
      const row = h(`<div class="row"><label>${label}</label><div class="seg"></div></div>`);
      const box = row.querySelector('.seg');
      const render = (val) => { box.innerHTML = ''; for (const [k, txt] of opts) { const b = document.createElement('button'); b.textContent = txt; if (k === val) b.className = 'on'; b.onclick = () => { onPick(k); render(k); }; box.appendChild(b); } };
      render(cur); grid.appendChild(row);
    };
    const slider = (label, min, max, step, cur, onChange, fmt = (v) => v.toFixed(2)) => {
      const row = h(`<div class="row"><label>${label}</label><div style="display:flex;gap:10px;align-items:center"><input type="range" min="${min}" max="${max}" step="${step}" value="${cur}"><span class="val">${fmt(cur)}</span></div></div>`);
      const inp = row.querySelector('input'), val = row.querySelector('.val');
      inp.oninput = () => { const v = parseFloat(inp.value); val.textContent = fmt(v); onChange(v); };
      grid.appendChild(row);
    };
    const fmtTime = (v) => { const hh = Math.floor(v), mm = Math.floor((v - hh) * 60); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };

    sec('Environment');
    slider('Time of day', 0, 24, 0.05, g.hour, (v) => { g.setTimeOfDay(v); }, fmtTime);
    seg('Time flow', [['off', 'Still'], ['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']], s.timeFlow, (k) => { s.timeFlow = k; g.saveSettings(); });
    seg('Weather', [['clear', 'Clear'], ['partly', 'Cloudy'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['storm', 'Storm'], ['snow', 'Snow'], ['fog', 'Fog']], s.weather, (k) => { g.setWeather(k); });
    seg('Season', [['summer', 'Summer'], ['autumn', 'Autumn'], ['winter', 'Winter']], s.season, (k) => { s.season = k; g.saveSettings(); location.reload(); });
    seg('World seed', [['7', 'Alpine'], ['21', 'Lakes'], ['42', 'Highlands'], ['1337', 'Forest']], String(g.seed), (k) => { g.changeSeed(parseInt(k)); });

    sec('Car');
    const sw = h('<div class="row"><label>Paint</label><div class="sw"></div></div>');
    const swb = sw.querySelector('.sw');
    for (const [k, hex] of Object.entries(PAINTS)) {
      const i = document.createElement('i'); i.style.background = '#' + hex.toString(16).padStart(6, '0'); if (k === s.paint) i.className = 'on'; i.title = k;
      i.onclick = () => { s.paint = k; g.car.setPaint(hex); g.saveSettings(); swb.querySelectorAll('i').forEach(x => x.className = ''); i.className = 'on'; };
      swb.appendChild(i);
    }
    grid.appendChild(sw);
    seg('Gearbox', [['auto', 'Automatic'], ['manual', 'Manual (E/Q, 1-6, 0, Z)']], s.gearbox, (k) => { s.gearbox = k; g.saveSettings(); g.toast(k === 'manual' ? 'Manual gearbox: E/Q shift, 1-6 pick a gear, 0 neutral, Z reverse' : 'Automatic gearbox'); });
    slider('Engine power', 0.6, 1.8, 0.05, s.power, (v) => { s.power = v; g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');
    slider('Tyre grip', 0.7, 1.6, 0.05, s.grip, (v) => { s.grip = v; g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');
    seg('Traction control', [['on', 'On'], ['off', 'Off']], s.tc !== false ? 'on' : 'off', (k) => { s.tc = k === 'on'; g.saveSettings(); });
    seg('Camera', [['chase', 'Chase'], ['far', 'Far'], ['low', 'Low'], ['hood', 'Hood'], ['cockpit', 'Cockpit']], g.camMode, (k) => { g.camMode = k; s.camera = k; g.saveSettings(); });
    slider('Field of view', 45, 90, 1, s.fov, (v) => { s.fov = v; g.saveSettings(); }, (v) => v.toFixed(0) + '°');
    slider('Camera shake', 0, 2, 0.1, s.shake, (v) => { s.shake = v; g.saveSettings(); }, (v) => v.toFixed(1));
    slider('Mouse look', 0, 2, 0.1, s.mouse, (v) => { s.mouse = v; if (v <= 0 && document.exitPointerLock) document.exitPointerLock(); g.saveSettings(); }, (v) => v <= 0 ? 'off' : v.toFixed(1) + '×');
    seg('Units', [['kmh', 'km/h'], ['mph', 'mph']], s.units, (k) => { s.units = k; document.getElementById('unit').textContent = k === 'kmh' ? 'km/h' : 'mph'; g.saveSettings(); });

    sec('Graphics');
    seg('Quality preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], s.quality, (k) => { s.quality = k; g.saveSettings(); location.reload(); });
    slider('Render scale', 0.5, 1.6, 0.05, s.renderScale, (v) => { s.renderScale = v; g.applyRenderScale(); g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');
    seg('Dynamic resolution', [['on', 'On'], ['off', 'Off']], s.dynamicRes ? 'on' : 'off', (k) => { s.dynamicRes = k === 'on'; g.saveSettings(); });
    slider('View distance', 0.5, 1.5, 0.05, s.viewDist, (v) => { s.viewDist = v; g.applyViewDistance(); g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');
    slider('Grass density', 0.2, 1.5, 0.05, s.grass, (v) => { s.grass = v; g.applyGrass(); g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');

    sec('Audio');
    slider('Master volume', 0, 1, 0.05, s.volume, (v) => { s.volume = v; g.audio.setVolume(v); g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');
    slider('Music', 0, 1, 0.05, s.music, (v) => { s.music = v; g.audio.setMusicVolume(v); g.saveSettings(); }, (v) => (v * 100).toFixed(0) + '%');

    const foot = h('<div class="foot"><span>W A S D drive · Space handbrake · C autopilot · V camera · R recover · T time · G weather · M mute · N music</span><button class="btn" id="resume">Resume</button></div>');
    p.appendChild(foot);
    foot.querySelector('#resume').onclick = () => this.toggle(false);
  }
}
