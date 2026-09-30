import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patchMaterial } from './gfx.js';
import * as TX from './textures.js';
import { GeoBuilder, buildBroadleaf, buildConifer } from './trees.js';

const V3 = THREE.Vector3;

// ---------------------------------------------------------------------------
// Wind / translucency shader patch shared by all foliage materials
// ---------------------------------------------------------------------------
// Distance based dither cross-fades: LOD0 -> LOD1 (x,y) and near instances -> merged far mesh (z,w).
export const TF = { uTF: { value: new THREE.Vector4(70, 100, 240, 300) } };
// mode 0: LOD0 geometry, 1: LOD1 geometry, 2: merged far geometry
export function fadePatchTree(shader, mode) {
  shader.uniforms.uTF = TF.uTF;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vTreeD;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvTreeD = length(mvPosition.xyz);');
  const keep = mode === 0 ? 'if (n < t1) discard;' : mode === 1 ? 'if (n >= t1 || n < tx) discard;' : 'if (n >= tx) discard;';
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vTreeD; uniform vec4 uTF;')
    .replace('#include <alphatest_fragment>', `{
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float t1 = smoothstep(uTF.x, uTF.y, vTreeD), tx = smoothstep(uTF.z, uTF.w, vTreeD);
      ${keep}
    }
    #include <alphatest_fragment>`);
}

export function windPatch(shader, { flutter = 1, bend = 1, translucent = false }) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      attribute vec3 aWind;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        #if defined(USE_BATCHING)
          vec3 ip = vec3(batchingMatrix[3].x, batchingMatrix[3].y, batchingMatrix[3].z);
        #elif defined(USE_INSTANCING)
          vec3 ip = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float gust = 0.55 + 0.45 * sin(uTime * 0.37 + ip.x * 0.011 + ip.z * 0.017);
        float swayT = sin(uTime * 1.25 + ip.x * 0.31 + ip.z * 0.23) * 0.6 + sin(uTime * 2.3 + ip.z * 0.41 + ip.x * 0.17) * 0.4;
        float bw = aWind.x * aWind.x;
        transformed.x += uWind.x * swayT * bw * (0.05 + 0.14 * gust) * ${bend.toFixed(2)};
        transformed.z += uWind.z * swayT * bw * (0.05 + 0.14 * gust) * ${bend.toFixed(2)};
        float fl = aWind.y * ${flutter.toFixed(2)};
        float ph = aWind.z * 6.2831 + ip.x * 0.7;
        transformed.x += sin(uTime * 5.3 + ph + position.y * 1.7) * 0.03 * fl * (0.5 + gust);
        transformed.y += sin(uTime * 4.1 + ph * 1.3 + position.x * 1.9) * 0.02 * fl * (0.5 + gust);
        transformed.z += sin(uTime * 4.7 + ph * 0.7 + position.z * 1.4) * 0.03 * fl * (0.5 + gust);
      }`);
  if (translucent) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      {
        vec3 Lv = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
        vec3 Vv = normalize(vViewPosition);
        float tr = pow(clamp(-dot(Vv, Lv) * 0.5 + 0.5, 0.0, 1.0), 3.0);
        float sunUp = clamp(uSunDirW.y * 4.0, 0.0, 1.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * tr * 0.42 * sunUp;
      }`);
  }
}

// ---------------------------------------------------------------------------
// Leaf atlas: 1024x1024, tiles: oak (0,0), birch (512,0), spruce needles (0,512, 256x512), dense needles small
// ---------------------------------------------------------------------------
const ATLAS_TILES = {
  oak: [0, 0, 512, 512],
  birch: [512, 0, 512, 512],
  spruce: [0, 512, 256, 512],
  maple: [256, 512, 512, 512],
};
export function atlasRect(name) {
  const [x, y, w, h] = ATLAS_TILES[name];
  return [x / 1024, 1 - (y + h) / 1024, (x + w) / 1024, 1 - y / 1024];
}

function makeAtlas(season = 'summer') {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
  const ctx = c.getContext('2d');
  const put = (tex, name) => { const [x, y, w, h] = ATLAS_TILES[name]; ctx.drawImage(tex.image, x, y, w, h); tex.dispose(); };
  if (season === 'autumn') {
    put(TX.makeLeafTexture(11, 30, 512, { spread: 62, sat: 68, light: 8 }), 'oak');
    put(TX.makeSmallLeafTexture(5, 48, 512, { spread: 26, sat: 78, light: 12 }), 'birch');
  } else if (season === 'winter') {
    put(TX.makeLeafTexture(11, 32, 512, { count: 16, twigs: 26, spread: 20, sat: 30, light: -4 }), 'oak');
    put(TX.makeSmallLeafTexture(5, 40, 512, { count: 14, spread: 20, sat: 30, light: 0 }), 'birch');
  } else {
    put(TX.makeLeafTexture(11, 94, 512), 'oak');
    put(TX.makeSmallLeafTexture(5, 74, 512), 'birch');
  }
  put(TX.makeNeedleTexture(8, 112, 256, 512), 'spruce');
  put(TX.makeLeafTexture(23, 100, 512), 'maple');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function remapUV(geo, rect) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, rect[0] + uv.getX(i) * (rect[2] - rect[0]), rect[1] + uv.getY(i) * (rect[3] - rect[1]));
  }
  uv.needsUpdate = true;
}

export const SPECIES = {
  oak: {
    kind: 'broad', tile: 'oak', barkKind: 'oak',
    params: { height: 12, trunkR: 0.42, trunkFrac: 0.30, limbs: 6, limbPolar: [0.55, 1.15], limbLen: [0.42, 0.62], upward: 1, cardsPerTip: 7, leafSize: 1.12, fill: 150, crownSquash: 0.72 },
    tints: [[0.62, 0.78, 0.36], [0.72, 0.86, 0.4], [0.54, 0.7, 0.32], [0.78, 0.82, 0.36]],
  },
  birch: {
    kind: 'broad', tile: 'birch', barkKind: 'birch',
    params: { height: 11, trunkR: 0.2, trunkFrac: 0.5, limbs: 7, limbPolar: [0.25, 0.7], limbLen: [0.35, 0.5], upward: 1.6, cardsPerTip: 7, leafSize: 0.95, fill: 90, crownSquash: 0.9 },
    tints: [[0.85, 0.92, 0.5], [0.72, 0.86, 0.42], [0.9, 0.92, 0.52]],
  },
  spruce: {
    kind: 'conifer', tile: 'spruce', barkKind: 'pine',
    params: { height: 19, trunkR: 0.3, skirt: 0.09, spread: 0.19, droop: 1 },
    tints: [[0.6, 0.78, 0.55], [0.5, 0.68, 0.48], [0.68, 0.85, 0.6]],
  },
};
export const SPECIES_LIST = Object.keys(SPECIES);

// per-season instance tints (multiplied with the atlas colours)
export function tintsFor(name, season) {
  const S = SPECIES[name];
  if (season === 'autumn') {
    if (name === 'oak') return [[1.0, 0.85, 0.7], [1.0, 0.72, 0.55], [0.95, 0.95, 0.75], [1.0, 0.62, 0.5], [0.8, 0.85, 0.6]];
    if (name === 'birch') return [[1.0, 0.95, 0.7], [1.0, 0.85, 0.6], [0.95, 1.0, 0.7]];
    return [[0.5, 0.66, 0.46], [0.42, 0.58, 0.4], [0.55, 0.7, 0.5]];
  }
  if (season === 'winter') {
    if (name === 'spruce') return [[0.86, 0.95, 0.95], [0.78, 0.9, 0.9], [0.92, 1.0, 1.0]];
    return [[0.75, 0.68, 0.6], [0.65, 0.6, 0.55], [0.8, 0.74, 0.66]];
  }
  return S.tints;
}

// simple far-away impostor geometry (leaf channel only)
function buildFar(name, variant) {
  const S = SPECIES[name];
  const rnd = mulberry32(variant * 331 + name.length * 17);
  const b = new GeoBuilder();
  b.group(1);
  const nrm = new V3(), ax = new V3(), ay = new V3(), c = new V3();
  if (S.kind === 'broad') {
    const H = S.params.height, R = H * 0.34;
    const cc = new V3(0, H * 0.66, 0);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const u = new V3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.75, rnd() * 2 - 1).normalize();
      c.copy(cc).addScaledVector(u, R * (0.35 + rnd() * 0.5));
      nrm.copy(u).normalize();
      ax.set(rnd() - 0.5, 0, rnd() - 0.5).normalize();
      ay.crossVectors(nrm, ax).normalize(); ax.crossVectors(ay, nrm).normalize();
      const s = R * (0.75 + rnd() * 0.4);
      const ao = 0.45 + 0.55 * Math.min(1, u.length() * 0.5 + 0.35 + Math.max(u.y, 0) * 0.3);
      const p = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].map(q => b.vert(
        { x: c.x + (ax.x * q[0] + ay.x * q[1]) * s, y: c.y + (ax.y * q[0] + ay.y * q[1]) * s, z: c.z + (ax.z * q[0] + ay.z * q[1]) * s },
        nrm, q[2], q[3], ao, [0, 0, 0]));
      b.tri(p[0], p[1], p[2]); b.tri(p[0], p[2], p[3]);
    }
    // trunk hint (dark thin card)
  } else {
    const H = S.params.height, Rb = H * S.params.spread * 1.05;
    const layers = 5;
    for (let l = 0; l < layers; l++) {
      const t = l / layers;
      const y = H * (0.1 + t * 0.85);
      const r = Rb * Math.pow(1 - t, 0.9) + 0.6;
      const ring = 7;
      const apex = b.vert({ x: 0, y: y + H * 0.2, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5, 0.95, 0.9, [0, 0, 0]);
      const vs = [];
      for (let k = 0; k <= ring; k++) {
        const a = (k / ring) * Math.PI * 2 + l;
        const nx = Math.cos(a), nz = Math.sin(a);
        vs.push(b.vert({ x: nx * r, y, z: nz * r }, { x: nx * 0.7, y: 0.6, z: nz * 0.7 }, (k % 2) * 0.9 + 0.05, 0.25, 0.6 + 0.4 * (1 - t), [0, 0, 0]));
      }
      for (let k = 0; k < ring; k++) b.tri(apex, vs[k + 1], vs[k]);
    }
  }
  const g = b.build();
  return g;
}

// ---------------------------------------------------------------------------
// The tree library: geometries per species/variant/LOD + shared materials
// ---------------------------------------------------------------------------
export class TreeLibrary {
  constructor(variants = 3, season = 'summer') {
    this.variants = variants;
    this.season = season;
    this.atlas = makeAtlas(season);
    const leafOpts = { map: this.atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true, alphaToCoverage: true };
    // plain leaf material (bushes etc.)
    this.leafMat = new THREE.MeshStandardMaterial(leafOpts);
    this.leafMat.userData.cacheKey = 'leaf';
    patchMaterial(this.leafMat, (sh) => windPatch(sh, { flutter: 1, bend: 1, translucent: true }));
    // tree canopy: [LOD0, LOD1] batched materials with dither fades
    this.leafMats = [0, 1].map((lod) => {
      const m = new THREE.MeshStandardMaterial(leafOpts);
      m.userData.cacheKey = 'leafT' + lod;
      patchMaterial(m, (sh) => { windPatch(sh, { flutter: 1, bend: 1, translucent: true }); fadePatchTree(sh, lod); });
      return m;
    });
    // far merged version: same look but no wind
    this.leafMatFar = new THREE.MeshStandardMaterial({
      map: this.atlas, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.7, metalness: 0, vertexColors: true, alphaToCoverage: true,
    });
    this.leafMatFar.userData.cacheKey = 'leaffar';
    patchMaterial(this.leafMatFar, (sh) => { windPatch(sh, { flutter: 0, bend: 0, translucent: true }); fadePatchTree(sh, 2); });
    this.barkMats = {};   // barkMats[name] = [LOD0, LOD1]
    for (const [name, S] of Object.entries(SPECIES)) {
      const tex = TX.makeBarkTexture(SPECIES_LIST.indexOf(name) + 2, S.barkKind);
      this.barkMats[name] = [0, 1].map((lod) => {
        const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, vertexColors: true });
        m.userData.cacheKey = 'barkT' + lod;
        patchMaterial(m, (sh) => { windPatch(sh, { flutter: 0, bend: 1 }); fadePatchTree(sh, lod); });
        return m;
      });
    }
    this.geo = {};   // geo[name][variant][lod] = {bark, leaf, height, radius}
    for (const name of SPECIES_LIST) {
      const S = SPECIES[name];
      this.geo[name] = [];
      for (let v = 0; v < variants; v++) {
        const per = [];
        for (let lod = 0; lod < 2; lod++) {
          const g = S.kind === 'broad' ? buildBroadleaf(v * 5 + name.length * 31 + 1, S.params, lod) : buildConifer(v * 5 + name.length * 31 + 1, S.params, lod);
          remapUV(g.leaf, atlasRect(S.tile));
          per.push(g);
        }
        const far = buildFar(name, v);
        remapUV(far.leaf, atlasRect(S.tile));
        per.push({ bark: null, leaf: far.leaf, height: per[0].height, radius: per[0].radius });
        this.geo[name].push(per);
      }
    }
  }
}
