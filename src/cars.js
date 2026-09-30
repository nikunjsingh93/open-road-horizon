import * as THREE from 'three';
import { SPEC } from './vehicle.js';

// The drivable cars. `spec` overrides the physics defaults in vehicle.js (the sport coupe IS the default), everything else describes
// where things sit in the model (glTF space: x right, y up, -z forward, origin on the ground between the axles).
const V3 = THREE.Vector3;
const DEFAULT_SPEC = { ...SPEC };

export const CARS = {
  coupe: {
    id: 'coupe', name: 'Sport coupe', glb: 'assets/car.glb',
    spec: {},
    cab: { wheel: [-0.36, 0.895, -0.34], cluster: [-0.36, 0.962, -0.64], clusterRot: -0.32 },
    eye: { cockpit: [-0.36, 1.14, 0.09], hood: [0, 1.08, -1.05] },
    lamps: { pos: [0.65, 0.7, -2.1], z: -30 },
    cam: { chase: [6.4, 1.95], far: [10.5, 3.6], lookH: 1.3 },
    blob: [2.7, 5.4],
    lane: 1.55, horn: 1,
  },
  suv: {
    id: 'suv', name: 'Luxury SUV', glb: 'assets/suv.glb',
    spec: {
      mass: 2420,
      inertia: new V3(4500, 4900, 1500),
      wheelbase: 3.0, track: 1.70, comH: 0.80,
      radius: 0.40, wheelInertia: 2.8,
      kF: 40000, kR: 38000, cBump: 4200, cReb: 7200, arbF: 30000, arbR: 24000,
      rayLen: 0.89, maxComp: 0.30,
      gears: [4.71, 2.91, 1.85, 1.29, 1.0, 0.72], reverse: 3.9, finalDrive: 3.2, eff: 0.9,
      maxTorque: 560, idle: 720, redline: 6200,
      brakeTorque: 11500, brakeBias: 0.64,
      cdA: 1.05, rollRes: 0.012,
      drive: [0.2, 0.2, 0.3, 0.3],          // permanent four wheel drive, 40 / 60 split
      gripK: 0.86, assistK: 2.2,
      steerK: 0.8, steerRate: 4.5,          // heavier, slower steering
      angDamp: 450, rollDamp: 4500,         // the body settles quickly instead of wallowing
      collOff: [-1.55, 0.1, 1.75], collR: 1.06,
      hull: [
        [-0.88, -0.52, -1.6], [0.88, -0.52, -1.6], [-0.88, -0.52, 1.6], [0.88, -0.52, 1.6], [0, -0.52, 0],
        [-0.80, 0.85, -0.4], [0.80, 0.85, -0.4], [-0.80, 0.85, 1.3], [0.80, 0.85, 1.3], [0, 1.0, 0.4],
      ],
    },
    cab: { wheel: [-0.40, 1.13, -0.36], cluster: [-0.40, 1.255, -0.595], clusterRot: -0.30, scale: 1.45 },
    eye: { cockpit: [-0.40, 1.52, 0.04], hood: [0, 1.34, -1.15] },
    lamps: { pos: [0.66, 0.92, -2.30], z: -30 },
    cam: { chase: [7.4, 2.45], far: [12.0, 4.3], lookH: 1.65 },
    blob: [3.0, 6.2],
    lane: 1.85, horn: 0.78,
  },
};

// make `id` the active car: writes its physics numbers into the shared SPEC (read by the vehicle, the traffic and the camera)
export function selectCar(id) {
  const def = CARS[id] || CARS.coupe;
  for (const k of Object.keys(SPEC)) delete SPEC[k];
  Object.assign(SPEC, DEFAULT_SPEC, def.spec);
  return def;
}
