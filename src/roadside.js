import * as THREE from 'three';
import { patchMaterial } from './gfx.js';
import { ROAD_HALF } from './terrain.js';

const V3 = THREE.Vector3;

// Delineator posts + guard rails on embankments, streamed around the car.
export class Roadside {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.postSpacing = 40; this.railStep = 4;
    this.lastBucket = null;
    this.group = new THREE.Group(); scene.add(this.group);

    const postGeo = new THREE.BoxGeometry(0.1, 1.0, 0.055); postGeo.translate(0, 0.5, 0);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.6 });
    postMat.userData.cacheKey = 'post';
    patchMaterial(postMat);
    this.posts = new THREE.InstancedMesh(postGeo, postMat, 120);
    const refGeo = new THREE.BoxGeometry(0.075, 0.13, 0.06); refGeo.translate(0, 0.8, 0);
    const refMat = new THREE.MeshStandardMaterial({ color: 0xd66a10, roughness: 0.3, emissive: 0x4a1c00, emissiveIntensity: 0.6 });
    refMat.userData.cacheKey = 'refl';
    patchMaterial(refMat);
    this.refl = new THREE.InstancedMesh(refGeo, refMat, 120);
    const bandGeo = new THREE.BoxGeometry(0.104, 0.08, 0.058); bandGeo.translate(0, 0.62, 0);
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7 });
    bandMat.userData.cacheKey = 'band'; patchMaterial(bandMat);
    this.band = new THREE.InstancedMesh(bandGeo, bandMat, 120);

    const railGeo = new THREE.BoxGeometry(0.06, 0.3, 4.05); railGeo.translate(0, 0.62, 0);
    const railMat = new THREE.MeshStandardMaterial({ color: 0xaeb3b8, roughness: 0.42, metalness: 0.85 });
    railMat.userData.cacheKey = 'rail'; patchMaterial(railMat);
    this.rails = new THREE.InstancedMesh(railGeo, railMat, 700);
    const rpostGeo = new THREE.BoxGeometry(0.1, 0.85, 0.1); rpostGeo.translate(0, 0.42, 0);
    const rpostMat = new THREE.MeshStandardMaterial({ color: 0x5a5d60, roughness: 0.6, metalness: 0.6 });
    rpostMat.userData.cacheKey = 'rpost'; patchMaterial(rpostMat);
    this.rposts = new THREE.InstancedMesh(rpostGeo, rpostMat, 700);
    for (const m of [this.posts, this.refl, this.band, this.rails, this.rposts]) {
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0; this.group.add(m);
    }
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.p = new V3(); this.s = new V3(1, 1, 1);
    this.up = new V3(0, 1, 0);
    this._c = {};
  }

  update(carS) {
    const bucket = Math.floor(carS / 20);
    if (bucket === this.lastBucket) return;
    this.lastBucket = bucket;
    const w = this.world;
    const c = this._c;
    // delineator posts
    let n = 0;
    const s0 = Math.floor((carS - 120) / this.postSpacing) * this.postSpacing;
    for (let s = s0; s < carS + 700 && n < 118; s += this.postSpacing) {
      if (s < 0) continue;
      w.at(s, c);
      const cx = Math.cos(c.th), cz = Math.sin(c.th);
      for (const side of [-1, 1]) {
        const t = side * (ROAD_HALF + 1.5);
        const x = c.x + cx * t, z = c.z + cz * t;
        const y = w.height(x, z);
        this.q.setFromAxisAngle(this.up, -c.th + (side < 0 ? Math.PI : 0));
        this.p.set(x, y - 0.03, z);
        this.m.compose(this.p, this.q, this.s);
        this.posts.setMatrixAt(n, this.m); this.refl.setMatrixAt(n, this.m); this.band.setMatrixAt(n, this.m);
        n++;
      }
    }
    for (const m of [this.posts, this.refl, this.band]) { m.count = n; m.instanceMatrix.needsUpdate = true; }
    // guard rails where the road runs on an embankment
    let r = 0;
    const st = this.railStep;
    const a = { x: 0, z: 0, y: 0, th: 0 }, b = { x: 0, z: 0, y: 0, th: 0 };
    const rs0 = Math.floor((carS - 100) / st) * st;
    const v1 = new V3(), v2 = new V3();
    for (let s = rs0; s < carS + 420 && r < 690; s += st) {
      if (s < 0) continue;
      w.at(s, a); w.at(s + st, b);
      const cxa = Math.cos(a.th), cza = Math.sin(a.th);
      for (const side of [-1, 1]) {
        const t = side * (ROAD_HALF + 1.05);
        const x1 = a.x + cxa * t, z1 = a.z + cza * t;
        const cxb = Math.cos(b.th), czb = Math.sin(b.th);
        const x2 = b.x + cxb * t, z2 = b.z + czb * t;
        // embankment test: terrain well below the road edge a few metres out
        const ox = a.x + cxa * side * (ROAD_HALF + 5.5), oz = a.z + cza * side * (ROAD_HALF + 5.5);
        const drop = a.y - w.natural(ox, oz);
        const drop2 = a.y - w.height(ox, oz);
        if (Math.max(drop, drop2) < 3.2) continue;
        const y1 = a.y + 0.0, y2 = b.y + 0.0;
        v1.set(x1, y1, z1); v2.set(x2, y2, z2);
        const mid = v1.clone().add(v2).multiplyScalar(0.5);
        const dir = v2.clone().sub(v1);
        const len = dir.length();
        const yaw = Math.atan2(dir.x, dir.z);
        const pitch = -Math.asin(dir.y / len);
        this.q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
        this.p.copy(mid); this.s.set(1, 1, len / 4.05);
        this.m.compose(this.p, this.q, this.s);
        this.rails.setMatrixAt(r, this.m);
        this.p.copy(v1); this.s.set(1, 1, 1);
        this.q.setFromAxisAngle(this.up, yaw);
        this.m.compose(this.p, this.q, this.s);
        this.rposts.setMatrixAt(r, this.m);
        r++;
      }
    }
    this.s.set(1, 1, 1);
    this.rails.count = r; this.rposts.count = r;
    this.rails.instanceMatrix.needsUpdate = true; this.rposts.instanceMatrix.needsUpdate = true;
  }
}
