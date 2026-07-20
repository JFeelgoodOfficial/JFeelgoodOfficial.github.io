// Placement math for the content zones. Every zone is a bearing (degrees
// clockwise from NORTH as seen at spawn) + a surface distance (units along the
// great circle). This maps that to a unit direction on the sphere and to a
// surface world position, in the same LANDING_DIR tangent frame the dressing
// uses — so clearings line up with the structures that sit in them.

import * as THREE from 'three';
import { C, LANDING_DIR, NORTH, EAST, ZONES } from './config.js';

const DEG = Math.PI / 180;

// Unit surface direction for a bearing/distance from spawn.
export function zoneDir(bearingDeg, dist, out = new THREE.Vector3()) {
  const b = bearingDeg * DEG;
  const ang = dist / C.RADIUS; // great-circle angle
  // azimuth in the tangent plane: clockwise from NORTH toward EAST
  const azx = Math.cos(b), azy = Math.sin(b);
  out.copy(LANDING_DIR).multiplyScalar(Math.cos(ang));
  out.addScaledVector(NORTH, Math.sin(ang) * azx);
  out.addScaledVector(EAST, Math.sin(ang) * azy);
  return out.normalize();
}

// Surface world position (on the base sphere) for a zone direction.
export function surfacePos(dir, extraR = 0, out = new THREE.Vector3()) {
  return out.copy(dir).multiplyScalar(C.RADIUS + extraR);
}

// A tangent frame at a direction: fills `up`, `north`(toward planet's +Y),
// `east`. Used to orient structures so they stand upright and face spawn.
export function frameAt(dir, up, north, east) {
  up.copy(dir).normalize();
  // reference "north" = world +Y projected onto the tangent plane
  north.set(0, 1, 0).addScaledVector(up, -up.y).normalize();
  if (north.lengthSq() < 1e-6) north.set(1, 0, 0); // at the poles
  east.crossVectors(north, up).normalize();
}

// Resolve every zone in config to a direction (billboards is an array).
export function resolveZones() {
  const z = {};
  z.spawn = LANDING_DIR.clone();
  z.gallery = zoneDir(ZONES.gallery.bearing, ZONES.gallery.dist);
  z.selfwork = zoneDir(ZONES.selfwork.bearing, ZONES.selfwork.dist);
  z.story = zoneDir(ZONES.story.bearing, ZONES.story.dist);
  z.books = zoneDir(ZONES.books.bearing, ZONES.books.dist);
  z.collect = zoneDir(ZONES.collect.bearing, ZONES.collect.dist);
  z.nova = zoneDir(ZONES.nova.bearing, ZONES.nova.dist);
  z.billboards = ZONES.billboards.map((b) => zoneDir(b.bearing, b.dist));
  return z;
}
