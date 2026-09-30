import * as THREE from 'three';
import { U, GLSL_NOISE, patchMaterial } from './gfx.js';
import { smoothstep, clamp } from './noise.js';
import { ROAD_HALF, DS } from './terrain.js';

const CHUNK_S = 48;               // metres of road per strip chunk
const ROWS = 24;                  // rows per chunk (2 m)
// lateral columns (metres from centre) for the near terrain strip
const T_COLS = (() => {
  const half = [0, 1.2, 2.4, 3.6, 3.85, 4.4, 5.2, 6.2, 7.5, 9, 11, 13.5, 16.5, 20, 24, 29, 35, 41, 47];
  const cols = [];
  for (let i = half.length - 1; i > 0; i--) cols.push(-half[i]);
  for (let i = 0; i < half.length; i++) cols.push(half[i]);
  return cols;
})();

// ---------------------------------------------------------------------------
// Terrain material (procedural PBR-ish ground)
// ---------------------------------------------------------------------------
export function makeTerrainMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 });
  mat.userData.cacheKey = 'terrain';
  patchMaterial(mat, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aInfo; varying vec4 vInfo; varying vec3 vWPos; varying vec3 vWNor;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vInfo = aInfo; vWPos = (modelMatrix * vec4(position,1.0)).xyz; vWNor = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${GLSL_NOISE}
        varying vec4 vInfo; varying vec3 vWPos; varying vec3 vWNor;
        uniform float uWet; uniform vec3 uWind; uniform float uSeason; uniform float uSnow;
        float gNoise(vec2 p, float px, int oct){ float s=0., a=.5, n=0.; for(int i=0;i<5;i++){ if(i>=oct) break; float f = 1.; float fade = clamp(1.0 - px*1.6, 0.0, 1.0); s += a*fade*(vnoise(p)-.5); p = p*2.13+vec2(5.1,1.7); a*=.5; px*=2.13; } return s; }
        vec3 gCol; float gRough; vec3 gBump;
        void terrainSurface(){
          vec2 p = vWPos.xz;
          float wdist = length(vWPos - cameraPosition);
          vec3 N = normalize(vWNor);
          float slope = 1.0 - N.y;
          float macro = fbm2(p*0.0016);
          float meso  = vnoise(p*0.012 + 3.)*0.62 + vnoise(p*0.031 + 8.)*0.38;
          float forest = vInfo.y;
          float alt = vWPos.y;
          vec3 grassA = vec3(0.052, 0.135, 0.026);
          vec3 grassB = vec3(0.150, 0.225, 0.045);
          vec3 dry    = vec3(0.34, 0.30, 0.13);
          vec3 dirt   = vec3(0.24, 0.185, 0.10);
          vec3 rock   = vec3(0.30, 0.285, 0.26);
          vec3 litter = vec3(0.060, 0.090, 0.035);
          vec3 c = mix(grassA, grassB, smoothstep(.3,.7,macro + (meso-.5)*.6));
          float tdst = vInfo.z;
          float dryN = vnoise(p*0.004+40.)*0.7 + vnoise(p*0.011+2.)*0.3;
          c = mix(c, dry, smoothstep(.55,.85, dryN)*(1.-forest*.7)*0.55);
          c = mix(c, litter, forest*.75);
          float aut = step(0.5, uSeason) * (1.0 - step(1.5, uSeason));
          c = mix(c, mix(vec3(0.15,0.13,0.035), vec3(0.26,0.19,0.045), smoothstep(.3,.7,macro)), aut*0.8*(1.0-forest*0.4));
          float meadow = 1.0 - forest*0.9;
          float g1 = 0.0, g2 = 0.0, px = 0.0;
          if (wdist < 300.) {
            px = length(fwidth(p));
            g1 = gNoise(p*2.7, px*2.7, 3);
            c *= 1.0 + g1*1.7;
            if (wdist < 100.) { g2 = gNoise(p*14.0, px*14.0, 2); c *= 1.0 + g2*1.3; }
          }
          if (wdist < 460.) {
            float wfade = 1.0 - smoothstep(40., 420., wdist);
            vec2 wd = normalize(uWind.xz + 1e-3);
            float wv = sin(dot(p, wd) * 0.045 + uTime * 0.9 + vnoise(p * 0.01) * 5.0) * 0.5 + 0.5;
            float wv2 = sin(dot(p, wd) * 0.13 + uTime * 1.7 + vnoise(p * 0.03) * 4.0) * 0.5 + 0.5;
            c *= 1.0 + (wv * 0.10 + wv2 * 0.05 - 0.075) * meadow * wfade;
            c *= 0.92 + 0.16 * vnoise(p * 0.05 + 21.0);
            if (wdist < 24.) {
              vec2 cell = floor(p * 6.0);
              float fdot = step(0.982, hash12(cell)) * (1.0 - smoothstep(6.0, 22.0, wdist)) * meadow * step(0.5, vnoise(p * 0.04 + 4.0));
              vec3 fcol = mix(vec3(0.9, 0.86, 0.5), vec3(0.85, 0.75, 0.95), step(0.5, hash12(cell + 7.0)));
              c = mix(c, fcol, fdot * 0.7);
            }
          }
          float dp = smoothstep(.62,.8, vnoise(p*0.02+11.)*0.65 + vnoise(p*0.05)*0.35);
          c = mix(c, dirt*(1.+g1), dp*.32);
          // mountains: bare rock takes over on ever gentler slopes with altitude, with vertical erosion streaks and sedimentary bands
          float mtn = smoothstep(160., 420., alt);
          float gw = vInfo.w;
          if (gw > 0.02) {
            // Big-Sur style hillsides: golden dry grass and dark chaparral scrub in patches, thin soil, bare rock only on the steepest faces
            float sc = vnoise(p*0.028)*0.55 + vnoise(p*0.09)*0.3 + vnoise(p*0.4)*0.15;
            vec3 gold = vec3(0.22,0.165,0.062) * (0.75 + 0.55*vnoise(p*0.7) + 0.4*g1);
            vec3 scrub = vec3(0.052,0.064,0.030) * (0.7 + 0.8*vnoise(p*0.35));
            vec3 gcol = mix(gold, scrub, smoothstep(0.28, 0.5, sc));
            // grass streaks run down the fall line
            gcol *= 0.9 + 0.2*vnoise(vec2(p.x*0.6 + p.y*0.15, p.y*3.0));
            c = mix(c, gcol, gw * 0.92 * (1.0 - forest*0.85));
          }
          float rk = smoothstep(mix(.30, .17, mtn) - gw*0.05, mix(.48, .32, mtn) - gw*0.05, slope + (meso-.5)*.2);
          if (rk > 0.01) {
            float strata = 0.5 + 0.5*sin(alt*0.11 + vnoise(p*.004)*11.0 + vnoise(p*.02)*3.0);
            float streak = vnoise(vec2(p.x*.02 + p.y*.014, alt*.02)) * .5 + vnoise(vec2(p.x*.11 - p.y*.08, alt*.09)) * .3 + vnoise(p*.35) * .2;
            float crag = vnoise(p*.045) * .6 + vnoise(p*.13) * .4;
            vec3 rc = mix(vec3(.105,.098,.092), vec3(.27,.24,.205), strata*.25 + streak*.75) * (0.55 + 0.9*crag + g1*.5);
            rc = mix(rc, rc*vec3(.78,.74,.72), smoothstep(.5,.9, slope));
            rc = mix(rc, rc*vec3(1.25,.98,.78) + vec3(.02,.008,0.), gw*.6);   // warm ochre sandstone / greywacke
            rc *= 0.82 + 0.36*vnoise(vec2(p.x*0.9 - p.y*0.5, alt*0.6));      // layered ledges
            c = mix(c, rc, rk);
          }
          float d = vInfo.x;
          float shoulder = 1.0 - smoothstep(4.25, 4.9 + 1.2*vnoise(p*.6), d);
          if (shoulder > 0.001) {
            vec3 gravel = vec3(0.20,0.185,0.16) * (0.7 + 0.6*vnoise(p*40.) + 0.5*g2);
            gravel *= 0.8 + 0.4*vnoise(p*3.);
            c = mix(c, gravel, shoulder*(1.-rk*.5));
          }
          // off-road side tracks: two dirt ruts with a grassy crown and a worn edge
          if (tdst < 4.2) {
            float e = tdst + (vnoise(p*.9) - .5) * .55;
            float track = 1.0 - smoothstep(1.7, 2.5, e);
            float rut = exp(-pow((tdst - 0.95) * 2.4, 2.));
            vec3 tcol = mix(vec3(.15,.11,.07), vec3(.095,.07,.045), rut * .7) * (.75 + .5*vnoise(p*7.) + .3*g2);
            float crown = (1.0 - smoothstep(.15, .7, tdst)) * .55;
            tcol = mix(tcol, c * 1.15, crown);
            c = mix(c, tcol, track * (1.0 - rk * .5));
            float edge = (1.0 - smoothstep(2.3, 3.6, e)) * .28;
            c = mix(c, dirt, edge * (1.0 - track));
          }
          float fringe = smoothstep(5.0, 6.2, d) * (1.0 - smoothstep(6.2, 8.5, d));
          c = mix(c, dirt*1.1, fringe*.22);
          // alpine belt: meadows yellow and thin out, scree and lichen above the tree line
          float hi = smoothstep(240., 460., alt + meso*40.);
          c = mix(c, vec3(.14,.13,.06), smoothstep(150., 320., alt + meso*40.)*.3*(1.-rk));
          c = mix(c, vec3(.135,.125,.11)*(0.65+0.8*vnoise(p*.05)+0.5*vnoise(p*.21)+g1*.4), hi*.45*(1.-rk*.8));
          // conifer belt on the lower mountain flanks
          float belt = smoothstep(4., 40., alt) * (1. - smoothstep(120., 190., alt + meso*30.)) * (1. - rk) * (0.6 + 0.4*smoothstep(.25,.65, vnoise(p*.0035+9.) + meso*.3)) * smoothstep(0.02, 0.16, slope + 0.12*mtn);
          c = mix(c, vec3(.040,.058,.030) * (0.7 + 0.7*macro + g1), belt*.35);
          float snowLine = 700. + (meso-.5)*70. - slope*70.;
          float snow = smoothstep(snowLine, snowLine + 70., alt) * (1.-smoothstep(.34,.62, slope + (meso-.5)*.1));
          c = mix(c, vec3(.82,.85,.9), snow);
          float sn = uSnow * (1.0 - smoothstep(0.32, 0.66, slope)) * (1.0 - shoulder) * (0.8 + 0.2*vnoise(p*0.4));
          c = mix(c, vec3(0.80,0.84,0.90) * (0.92 + 0.08*g1*4.0), clamp(sn*1.15, 0., 1.));
          gCol = c * (1.0 - 0.3*uWet);
          gRough = mix(0.98, 0.78, rk*.5 + snow*.4) - shoulder*.05;
          gRough = mix(gRough, 0.9, sn);
          gRough = mix(gRough, gRough*0.72, uWet);
          gBump = vec3(0.0);
          vec3 nd2 = vnoiseD(p*.9);
          gBump.xz = nd2.xy*0.5;
          if (wdist < 80.) { vec3 nd = vnoiseD(p*6.0); float fade = clamp(1.0 - px*3.0, 0.0, 1.0); gBump.xz += nd.xy*.10*fade; }
          gBump *= (0.5 + rk*1.5);
          if (mtn > 0.05) { vec3 nd3 = vnoiseD(p*0.16); vec3 nd4 = vnoiseD(p*0.045 + 17.); vec3 nd5 = vnoiseD(p*0.012 + 5.); gBump.xz += (nd3.xy * 0.25 + nd4.xy * 0.7 + nd5.xy * 1.2) * mtn * (0.3 + rk); }
        }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        terrainSurface(); diffuseColor.rgb = gCol;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = gRough;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        #ifdef DEBUG_ALBEDO
        gl_FragColor = vec4(gCol, 1.0);
        #endif
        #ifdef DEBUG_NOISE
        gl_FragColor = vec4(vec3(vnoise(vWPos.xz*0.5)), 1.0);
        #endif
        #ifdef DEBUG_INFO
        gl_FragColor = vec4(vInfo.x/20.0, vInfo.y, vWNor.y, 1.0);
        #endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 nw = normalize(vWNor - gBump*0.25); normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz); }`);
  });
  return mat;
}

// ---------------------------------------------------------------------------
// Asphalt road material with procedural lane markings
// ---------------------------------------------------------------------------
export function makeRoadMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  mat.userData.cacheKey = 'road';
  mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
  patchMaterial(mat, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aRoad; varying vec2 vRoad; varying vec3 vWPos2; varying vec3 vWNor2;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRoad = aRoad; vWPos2 = (modelMatrix * vec4(position,1.0)).xyz; vWNor2 = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${GLSL_NOISE}
        varying vec2 vRoad; varying vec3 vWPos2; varying vec3 vWNor2;
        uniform float uWet; uniform float uSnow;
        vec3 rCol; float rRough; vec3 rBump;
        float aaLine(float d, float w, float aa){ return 1.0 - smoothstep(w - aa, w + aa, abs(d)); }
        void roadSurface(){
          float x = vRoad.x;       // lateral metres from centre (right positive)
          float s = vRoad.y;       // along metres
          vec2 p = vec2(x, s);
          float px = length(fwidth(p));
          float fadeHi = clamp(1.0 - px*2.0, 0.0, 1.0);
          float fadeMid = clamp(1.0 - px*0.35, 0.0, 1.0);
          // asphalt base: dark bluish grey, big-scale mottling
          float m1 = fbm2(vec2(x*.35, s*.06));
          float m2 = fbm2(vec2(x*1.7, s*.35) + 9.);
          vec3 base = vec3(0.105, 0.105, 0.108) * (0.8 + 0.5*m1 + 0.25*m2);
          // aggregate speckle
          float sp = vnoise(vec2(x*55., s*55.));
          float sp2 = vnoise(vec2(x*130., s*130.)+3.);
          base *= 1.0 + fadeHi*((sp-.5)*.55 + (sp2-.5)*.4);
          float lightSpeck = step(.93, vnoise(vec2(x*90., s*90.)+7.)) * fadeHi;
          base += vec3(.12)*lightSpeck*.5;
          // wheel tracks (dark polished bands centered at +-1.75 m from each lane centre)
          float lane = 1.7;
          float lx = abs(x) - lane;
          float tr = exp(-pow((abs(lx) - 0.85)/0.32, 2.)) * (0.65 + 0.35*vnoise(vec2(0., s*.4)));
          base *= 1.0 - tr*.28;
          float polish = tr;
          // patches / repairs
          float rpatch = smoothstep(.72,.74, fbm2(vec2(x*.25, s*.04)+31.));
          base = mix(base, base*1.28 + vec3(.004), rpatch*.5);
          // cracks
          float cr = abs(vnoise(vec2(x*2.1 + fbm2(vec2(x,s)*.8)*1.5, s*.5))-.5);
          float crack = (1.-smoothstep(.0,.012, cr)) * fadeMid * step(.55, fbm2(vec2(x*.3, s*.08)+2.));
          base *= 1.0 - crack*.5;
          // sealed crack lines (transverse tar lines)
          float tl = abs(fract(s/13.0 + hash11(floor(s/13.0))*.0) - .5)*13.0;
          float tar = (1.-smoothstep(.0,.06, abs(tl - 6.5 + (hash11(floor(s/13.0))-.5)*8.0))) * step(.6, hash11(floor(s/13.0)+4.));
          base *= 1.0 - tar*.4*fadeMid;
          // markings
          float aa = max(px*.7, 0.004);
          vec3 paint = vec3(.72, .72, .70);
          float edgeX = ${(ROAD_HALF - 0.36).toFixed(3)};
          float edge = aaLine(abs(x) - edgeX, 0.075, aa);
          float dash = smoothstep(0.0, 0.05 + aa, 3.0 - abs(mod(s, 12.0) - 6.0 ));   // 6 m dash, 6 m gap
          dash = step(mod(s, 12.0), 4.0) ;
          float dashSoft = smoothstep(0.0, aa*2., 4.0 - mod(s,12.0)) * smoothstep(0.0, aa*2., mod(s,12.0));
          float center = aaLine(x, 0.075, aa) * dashSoft;
          float paintMask = clamp(edge + center, 0., 1.);
          // paint wear
          float wear = 0.55 + 0.45*fbm2(vec2(x*8., s*8.));
          wear = mix(wear, 1.0, 0.0);
          paintMask *= smoothstep(.25,.6, wear + (1.-fadeHi)*.4) * (0.9 - tr*.15);
          rCol = mix(base, paint * (0.85 + .15*sp), paintMask);
          // road edge fringe (dirt/gravel creeping onto tarmac) & edge darkening
          float ex = ${ROAD_HALF.toFixed(3)} - abs(x);
          float dirtE = (1.-smoothstep(.0,.55, ex + (vnoise(vec2(s*1.3, x*4.))-.5)*.5));
          rCol = mix(rCol, vec3(.16,.13,.09)*(0.7+sp*.6), dirtE*.55);
          rRough = mix(0.86, 0.6, polish*.6) ;
          rRough = mix(rRough, 0.45, paintMask*0.0);
          rRough = clamp(rRough - fadeHi*.0, 0.3, 1.0);
          float bump = (vnoise(vec2(x*70., s*70.)) - .5) * fadeHi * 0.6 + (sp2-.5)*fadeHi*.3;
          rBump = vec3(bump, 0., bump*.7);
          { float exs = ${ROAD_HALF.toFixed(3)} - abs(x); float rs = uSnow * (1.0 - smoothstep(0.0, 0.9 + 0.8*vnoise(vec2(s*0.7, x)), exs)); rs = max(rs, uSnow * smoothstep(0.78, 0.9, fbm2(vec2(x*.25, s*.05)+5.)) * 0.55); rCol = mix(rCol, vec3(0.78,0.82,0.88), clamp(rs, 0., 1.) * (1.0 - paintMask*0.6)); rRough = mix(rRough, 0.85, rs); }
          float pud = smoothstep(0.52, 0.68, fbm2(vec2(x*.32, s*.045)+11.) + (vnoise(vec2(x*2., s*.6))-.5)*.12) * uWet;
          rCol *= 1.0 - 0.32*uWet - 0.28*pud;
          rRough = mix(rRough, 0.035, pud);
          rBump *= 1.0 - pud;
        }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        roadSurface(); diffuseColor.rgb = rCol;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = rRough * (1.0 - uWet*0.45);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 nw = normalize(vWNor2 + rBump*0.05); normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz); }`);
  });
  return mat;
}

// ---------------------------------------------------------------------------
// Ground manager
// ---------------------------------------------------------------------------
export class Ground {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.terrainMat = makeTerrainMaterial();
    this.roadMat = makeRoadMaterial();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.chunks = new Map();   // k -> {terrain, road, ...}
    this.tiles = new Map();
    this.tmpN = { x: 0, y: 1, z: 0 };
    this.lo = -100; this.hi = 900;
    this.buildQueue = [];
    this.tileGroup = new THREE.Group();
    scene.add(this.tileGroup);
    this.stats = { chunks: 0, tiles: 0 };
  }

  // ---- near strip chunk k: road + carved terrain ----
  buildChunk(k) {
    const w = this.world;
    const s0 = k * CHUNK_S;
    w.ensure(s0 + CHUNK_S + 300);
    const cols = T_COLS.length;
    const nrows = ROWS + 1;
    const pos = new Float32Array(nrows * cols * 3);
    const nor = new Float32Array(nrows * cols * 3);
    const info = new Float32Array(nrows * cols * 4);
    const c = { s: 0, x: 0, z: 0, y: 0, th: 0 };
    const nn = this.tmpN;
    let idx = 0;
    for (let r = 0; r < nrows; r++) {
      const s = s0 + r * (CHUNK_S / ROWS);
      w.at(s, c);
      const cx = Math.cos(c.th), cz = Math.sin(c.th); // right vector (x,z)
      for (let j = 0; j < cols; j++) {
        const t = T_COLS[j];
        const x = c.x + cx * t, z = c.z + cz * t;
        const nat = w.natural(x, z);
        const d = Math.abs(t);
        const h = w.shape(nat, x, z, { d, y: c.y });
        pos[idx * 3] = x; pos[idx * 3 + 1] = h; pos[idx * 3 + 2] = z;
        info[idx * 4] = d; info[idx * 4 + 1] = w.forest(x, z); info[idx * 4 + 2] = Math.min(w.tdist, 30); info[idx * 4 + 3] = w.guideWeight(z);
        idx++;
      }
    }
    // normals: analytic from neighbours in the same grid, with cross-chunk continuity from world.normal on edges
    idx = 0;
    for (let r = 0; r < nrows; r++) {
      for (let j = 0; j < cols; j++) {
        if (r === 0 || r === nrows - 1 || j === 0 || j === cols - 1) {
          const x = pos[idx * 3], z = pos[idx * 3 + 2];
          w.normal(x, z, nn, 0.9);
        } else {
          const iL = idx - 1, iR = idx + 1, iU = idx - cols, iD = idx + cols;
          // tangent vectors
          const tx = pos[iR * 3] - pos[iL * 3], ty = pos[iR * 3 + 1] - pos[iL * 3 + 1], tz = pos[iR * 3 + 2] - pos[iL * 3 + 2];
          const bx = pos[iD * 3] - pos[iU * 3], by = pos[iD * 3 + 1] - pos[iU * 3 + 1], bz = pos[iD * 3 + 2] - pos[iU * 3 + 2];
          // normal = b x t (rows go forward -> t is right)
          let nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
          const l = Math.hypot(nx, ny, nz);
          nn.x = nx / l; nn.y = ny / l; nn.z = nz / l;
          if (nn.y < 0) { nn.x = -nn.x; nn.y = -nn.y; nn.z = -nn.z; }
        }
        nor[idx * 3] = nn.x; nor[idx * 3 + 1] = nn.y; nor[idx * 3 + 2] = nn.z;
        idx++;
      }
    }
    const index = [];
    for (let r = 0; r < nrows - 1; r++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = r * cols + j, b = a + 1, c2 = a + cols, d = c2 + 1;
        // ensure upward-facing winding: rows go forward (-z-ish), columns go right (+x-ish)
        index.push(a, b, c2, b, d, c2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    const terrain = new THREE.Mesh(geo, this.terrainMat);
    terrain.receiveShadow = true;
    terrain.frustumCulled = true;

    // road mesh (tarmac)
    const rc = 9; // columns across
    const rpos = new Float32Array(nrows * rc * 3);
    const rnor = new Float32Array(nrows * rc * 3);
    const rinfo = new Float32Array(nrows * rc * 2);
    idx = 0;
    const HW = ROAD_HALF + 0.12;
    for (let r = 0; r < nrows; r++) {
      const s = s0 + r * (CHUNK_S / ROWS);
      w.at(s, c);
      const cx = Math.cos(c.th), cz = Math.sin(c.th);
      for (let j = 0; j < rc; j++) {
        const u = j / (rc - 1) * 2 - 1;
        const t = u * HW;
        // slight crown
        const crown = 0.05 * (1 - u * u);
        rpos[idx * 3] = c.x + cx * t; rpos[idx * 3 + 1] = c.y + crown + 0.005; rpos[idx * 3 + 2] = c.z + cz * t;
        rinfo[idx * 2] = t; rinfo[idx * 2 + 1] = s;
        idx++;
      }
    }
    idx = 0;
    for (let r = 0; r < nrows; r++) {
      for (let j = 0; j < rc; j++) {
        const iL = j > 0 ? idx - 1 : idx, iR = j < rc - 1 ? idx + 1 : idx;
        const iU = r > 0 ? idx - rc : idx, iD = r < nrows - 1 ? idx + rc : idx;
        const tx = rpos[iR * 3] - rpos[iL * 3], ty = rpos[iR * 3 + 1] - rpos[iL * 3 + 1], tz = rpos[iR * 3 + 2] - rpos[iL * 3 + 2];
        const bx = rpos[iD * 3] - rpos[iU * 3], by = rpos[iD * 3 + 1] - rpos[iU * 3 + 1], bz = rpos[iD * 3 + 2] - rpos[iU * 3 + 2];
        let nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        rnor[idx * 3] = nx; rnor[idx * 3 + 1] = ny; rnor[idx * 3 + 2] = nz;
        idx++;
      }
    }
    const rindex = [];
    for (let r = 0; r < nrows - 1; r++) {
      for (let j = 0; j < rc - 1; j++) {
        const a = r * rc + j, b = a + 1, c2 = a + rc, d = c2 + 1;
        rindex.push(a, b, c2, b, d, c2);
      }
    }
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    rgeo.setAttribute('normal', new THREE.BufferAttribute(rnor, 3));
    rgeo.setAttribute('aRoad', new THREE.BufferAttribute(rinfo, 2));
    rgeo.setIndex(rindex);
    rgeo.computeBoundingSphere();
    const road = new THREE.Mesh(rgeo, this.roadMat);
    road.receiveShadow = true;
    this.group.add(terrain, road);
    return { k, terrain, road, geo, rgeo };
  }

  disposeChunk(ch) {
    this.group.remove(ch.terrain, ch.road);
    ch.geo.dispose(); ch.rgeo.dispose();
  }

  update(carS, camPos) {
    const k0 = Math.floor((carS + this.lo) / CHUNK_S), k1 = Math.floor((carS + this.hi) / CHUNK_S);
    // build nearest first, limited per frame
    let built = 0;
    const order = [];
    for (let k = Math.max(k0, -2); k <= k1; k++) order.push(k);
    const kc = Math.floor(carS / CHUNK_S);
    order.sort((a, b) => Math.abs(a - kc) - Math.abs(b - kc));
    for (const k of order) {
      if (!this.chunks.has(k)) {
        this.chunks.set(k, this.buildChunk(k));
        if (++built >= 3) break;
      }
    }
    for (const [k, ch] of this.chunks) {
      if (k < k0 - 1 || k > k1 + 1) { this.disposeChunk(ch); this.chunks.delete(k); }
    }
    this.stats.chunks = this.chunks.size;
  }

  // synchronous: make sure chunks around s exist (for tests / teleport)
  prime(carS) {
    const k0 = Math.floor((carS + this.lo) / CHUNK_S), k1 = Math.floor((carS + this.hi) / CHUNK_S);
    for (let k = Math.max(k0, -2); k <= k1; k++) if (!this.chunks.has(k)) this.chunks.set(k, this.buildChunk(k));
  }
}
