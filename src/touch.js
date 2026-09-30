// On-screen touch controls (phones / tablets). Only created on touch devices.
//   bottom-left : steer left / right
//   bottom-right: gas, brake, handbrake
//   top-right   : camera, autopilot, recover, menu
//   anywhere else: drag to look around
const CSS = `
body.touch #help, body.touch #topbar { display: none; }
body.touch #hud { top: 0; bottom: auto; padding: max(10px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-left)); align-items: flex-start; }
body.touch #speed { font-size: 34px; }
body.touch #speed small { font-size: 11px; }
body.touch #gear { margin-top: 4px; font-size: 11px; }
body.touch #toast { top: 14px; }
body.touch canvas { touch-action: none; }
#tctl { position: fixed; inset: 0; z-index: 12; pointer-events: none; display: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: none; }
body.touch #tctl { display: block; }
#tctl.hidden { display: none !important; }
#tlook { position: absolute; inset: 0; pointer-events: auto; touch-action: none; }
.tb { position: absolute; pointer-events: auto; touch-action: none; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 2px;
  color: #eef3f8; font: 600 12px/1 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.5px; text-transform: uppercase;
  background: rgba(14,18,24,.42); border: 1.5px solid rgba(255,255,255,.28); border-radius: 50%; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 4px 18px rgba(0,0,0,.25); transition: background .08s, transform .08s; }
.tb.on { background: rgba(255,211,138,.55); border-color: #ffd38a; transform: scale(.94); }
.tb svg { width: 38%; height: 38%; fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.tb.pill { border-radius: 14px; }
.tb.small { font-size: 10px; letter-spacing: 1px; }
.tb.toggle.act { background: rgba(255,211,138,.5); border-color: #ffd38a; }
`;

const chev = (dir) => `<svg viewBox="0 0 24 24"><path d="${dir < 0 ? 'M15 4 7 12l8 8' : 'M9 4l8 8-8 8'}"/></svg>`;

export function isTouchDevice() {
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints > 0 && 'ontouchstart' in window);
}

export function setupTouch(game) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const root = document.createElement('div'); root.id = 'tctl';
  document.body.appendChild(root);
  const look = document.createElement('div'); look.id = 'tlook'; root.appendChild(look);

  const inset = 'max(18px, env(safe-area-inset-';
  const mk = (cls, html, css, onDown, onUp) => {
    const b = document.createElement('div'); b.className = 'tb ' + cls; b.innerHTML = html;
    Object.assign(b.style, css);
    const ids = new Set();
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      ids.add(e.pointerId); b.classList.add('on'); if (onDown) onDown();
    });
    const up = (e) => {
      if (!ids.delete(e.pointerId)) return;
      if (!ids.size) { b.classList.remove('on'); if (onUp) onUp(); }
    };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    root.appendChild(b);
    return b;
  };
  const hold = (code) => [() => { game.keys[code] = true; }, () => { game.keys[code] = false; }];
  const S = 'clamp(64px, 17vmin, 104px)';    // steering button size
  const G = 'clamp(84px, 24vmin, 132px)';    // gas size
  const K = 'clamp(70px, 19vmin, 112px)';    // brake size
  const bl = `calc(${inset}left) + 0px)`, br = `calc(${inset}right) + 0px)`, bb = `calc(${inset}bottom) + 0px)`;

  // steering (bottom-left)
  mk('', chev(-1), { width: S, height: S, left: bl, bottom: bb }, ...hold('KeyA'));
  mk('', chev(1), { width: S, height: S, left: `calc(${bl} + ${S} + 16px)`, bottom: bb }, ...hold('KeyD'));
  // pedals (bottom-right)
  mk('', '<span>Gas</span>', { width: G, height: G, right: br, bottom: bb }, ...hold('KeyW'));
  mk('', '<span>Brake</span>', { width: K, height: K, right: `calc(${br} + ${G} + 14px)`, bottom: bb }, ...hold('KeyS'));
  mk('small', '<span>Hand</span><span>brake</span>', { width: 'clamp(56px, 14vmin, 84px)', height: 'clamp(56px, 14vmin, 84px)', right: br, bottom: `calc(${bb} + ${G} + 14px)` }, ...hold('Space'));

  // manual gearbox buttons (only visible in manual mode)
  const gb = 'clamp(48px, 12vmin, 68px)';
  const gUp = mk('small', chev(-1).replace('M15 4 7 12l8 8', 'M4 15l8-8 8 8'), { width: gb, height: gb, left: bl, bottom: `calc(${bb} + ${S} + 14px)` }, () => game.shift(1), null);
  const gDn = mk('small', chev(-1).replace('M15 4 7 12l8 8', 'M4 9l8 8 8-8'), { width: gb, height: gb, left: `calc(${bl} + ${gb} + 12px)`, bottom: `calc(${bb} + ${S} + 14px)` }, () => game.shift(-1), null);
  const gLbl = document.createElement('div');
  Object.assign(gLbl.style, { position: 'absolute', left: `calc(${bl} + ${gb} * 2 + 26px)`, bottom: `calc(${bb} + ${S} + 14px + ${gb} / 2 - 12px)`, font: '600 20px/24px system-ui, sans-serif', textShadow: '0 1px 6px rgba(0,0,0,.6)', letterSpacing: '1px', pointerEvents: 'none' });
  root.appendChild(gLbl);
  const syncGears = () => {
    const man = game.settings.gearbox === 'manual' && !game.auto;
    for (const el of [gUp, gDn, gLbl]) el.style.display = man ? '' : 'none';
    if (man) { const gr = game.vehicle.gear; gLbl.textContent = gr < 0 ? 'R' : gr === 0 ? 'N' : String(gr); }
  };
  setInterval(syncGears, 150); syncGears();

  // top-right buttons
  const T = 'clamp(42px, 10vmin, 54px)';
  const top = 'max(12px, env(safe-area-inset-top))';
  let x = 0;
  const topBtn = (label, css, fn, toggle) => {
    const b = mk('pill small' + (toggle ? ' toggle' : ''), `<span>${label}</span>`, Object.assign({ width: `calc(${T} + 14px)`, height: T, top, right: `calc(${br} + ${x}px)` }, css || {}), null, null);
    b.addEventListener('pointerdown', () => { fn(b); });
    x += 0; return b;
  };
  const gap = `calc(${T} + 14px + 8px)`;
  const place = (i) => `calc(${br} + ${i} * ${gap})`;
  const menuB = topBtn('Menu', { right: place(0) }, () => game.ui.toggle());
  const camB = topBtn('Cam', { right: place(1) }, () => game.cycleCamera());
  const autoB = topBtn('Auto', { right: place(2) }, (b) => { game.auto = !game.auto; game.toast(game.auto ? 'Autopilot on' : 'Autopilot off'); b.classList.toggle('act', game.auto); }, true);
  const recB = topBtn('Reset', { right: place(3) }, () => game.recover());
  void menuB; void camB; void recB;
  // keep the autopilot highlight honest if it is switched off by other means
  setInterval(() => autoB.classList.toggle('act', !!game.auto), 400);

  // drag anywhere else to look around
  let lp = null;
  look.addEventListener('pointerdown', (e) => {
    if (lp) return;
    lp = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { look.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  look.addEventListener('pointermove', (e) => {
    if (!lp || e.pointerId !== lp.id || game.ui.open) return;
    const k = 0.0055 * (game.settings.mouse ?? 1), L = game.look;
    L.yaw -= (e.clientX - lp.x) * k; L.pitch -= (e.clientY - lp.y) * k; L.idle = 0;
    lp.x = e.clientX; lp.y = e.clientY;
  });
  const endLook = (e) => { if (lp && e.pointerId === lp.id) lp = null; };
  look.addEventListener('pointerup', endLook); look.addEventListener('pointercancel', endLook);

  // hide the controls while the settings menu is open
  const menu = document.getElementById('menu');
  new MutationObserver(() => root.classList.toggle('hidden', menu.classList.contains('open'))).observe(menu, { attributes: true, attributeFilter: ['class'] });

  // never let the page scroll / zoom while playing
  for (const ev of ['touchmove', 'gesturestart']) document.addEventListener(ev, (e) => { if (!menu.classList.contains('open')) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
}
