// catastrophe.js — the abandonment endings. When the player leaves a biome
// before its colony ascends, the settlement is ended by a biome-specific
// disaster, staged at the city so it plays out behind the departing player
// ("don't look back"). Each effect is a self-contained THREE overlay parented
// to the city group (city-local frame: origin at the city centre, +Y = up),
// animates for a few seconds, then calls onDone() so the lifecycle can dispose
// the whole city.
//
//   forest -> fire     desert -> meteor
//   alpine -> avalanche  plains -> flood

import * as THREE from 'three';

const KIND_DUR = { fire: 6.0, meteor: 5.0, avalanche: 5.5, flood: 6.0 };

export function createCatastrophe(cityLife, kind, onDone) {
  const city = cityLife.city;
  const parent = city.group;
  const grp = new THREE.Group();
  parent.add(grp);
  const cy = city.groundLocalYAt(0, 0); // local ground height at city centre
  const R = 110; // effect footprint radius (city radius is ~150)
  const dur = KIND_DUR[kind] ?? 5.5;
  let t = 0;
  let finished = false;
  const parts = []; // { mesh, update(t,dt) }

  const rand = () => Math.random();

  if (kind === 'meteor') buildMeteor();
  else if (kind === 'fire') buildFire();
  else if (kind === 'avalanche') buildAvalanche();
  else buildFlood();

  // ---- meteor: a bolide falls, flashes on impact, throws a shockwave ring ---
  function buildMeteor() {
    const from = new THREE.Vector3((rand() - 0.5) * 120, cy + 420, (rand() - 0.5) * 120);
    const to = new THREE.Vector3(0, cy + 4, 0);
    const rockMat = new THREE.MeshBasicMaterial({ color: 0xffb14a });
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(6, 0), rockMat);
    rock.position.copy(from);
    grp.add(rock);
    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xff7a1a, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const trail = new THREE.Mesh(new THREE.ConeGeometry(4, 60, 8, 1, true), trailMat);
    grp.add(trail);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xfff2c8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12), flashMat);
    flash.position.copy(to);
    grp.add(flash);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffcaa0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, cy + 0.5, 0);
    grp.add(ring);
    const impactAt = 1.7;
    parts.push({
      update: (tt) => {
        const k = Math.min(tt / impactAt, 1);
        rock.position.lerpVectors(from, to, k);
        rock.rotation.x += 0.3; rock.rotation.y += 0.2;
        trail.position.copy(rock.position).addScaledVector(new THREE.Vector3().subVectors(from, to).normalize(), 30);
        trail.lookAt(to);
        trail.rotateX(Math.PI / 2);
        trailMat.opacity = 0.5 * (1 - k * 0.3);
        if (tt >= impactAt) {
          rock.visible = false; trail.visible = false;
          const a = tt - impactAt;
          flashMat.opacity = Math.max(1 - a * 1.4, 0);
          flash.scale.setScalar(1 + a * 6);
          const grow = 1 + a * R * 0.9;
          ring.scale.set(grow, grow, 1);
          ringMat.opacity = Math.max(0.8 - a * 0.25, 0);
        }
      },
    });
  }

  // ---- fire: embers rise across the footprint, smoke builds ----------------
  function buildFire() {
    const N = 260;
    const emberGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const emberMat = new THREE.MeshBasicMaterial({
      color: 0xff7326, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const embers = new THREE.InstancedMesh(emberGeo, emberMat, N);
    embers.frustumCulled = false;
    grp.add(embers);
    const seeds = [];
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * R;
      seeds.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, h: 6 + rand() * 40, spd: 0.4 + rand() * 0.9, ph: rand() * 6 });
    }
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0x140b06, transparent: true, opacity: 0,
      blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(R * 0.8, 16, 12), smokeMat);
    smoke.position.set(0, cy + 30, 0);
    grp.add(smoke);
    const d = new THREE.Object3D();
    parts.push({
      update: (tt) => {
        const rise = tt;
        emberMat.opacity = 0.9 * Math.min(tt / 0.6, 1) * Math.max(1 - (tt - (dur - 1.5)) / 1.5, tt < dur - 1.5 ? 1 : 0);
        for (let i = 0; i < N; i++) {
          const s = seeds[i];
          const y = cy + ((rise * 14 * s.spd + s.ph * 5) % s.h);
          d.position.set(s.x + Math.sin(tt + s.ph) * 1.5, y, s.z);
          d.scale.setScalar(0.6 + 0.8 * (1 - (y - cy) / s.h));
          d.updateMatrix();
          embers.setMatrixAt(i, d.matrix);
        }
        embers.instanceMatrix.needsUpdate = true;
        smokeMat.opacity = Math.min(tt / dur, 1) * 0.55;
        smoke.scale.setScalar(0.5 + tt / dur);
      },
    });
  }

  // ---- avalanche: a white mass slides down over the settlement ------------
  function buildAvalanche() {
    const from = new THREE.Vector3(-R * 1.1, cy + 60, -R * 1.1);
    const to = new THREE.Vector3(R * 0.2, cy + 6, 0);
    const snowMat = new THREE.MeshStandardMaterial({
      color: 0xf2f7ff, roughness: 1.0, transparent: true, opacity: 0.92,
      emissive: new THREE.Color(0x223344), emissiveIntensity: 0.2,
    });
    const mass = new THREE.Mesh(new THREE.IcosahedronGeometry(30, 1), snowMat);
    mass.position.copy(from);
    grp.add(mass);
    const powderMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.0,
      blending: THREE.NormalBlending, depthWrite: false,
    });
    const powder = new THREE.Mesh(new THREE.SphereGeometry(R * 0.9, 16, 12), powderMat);
    powder.position.set(0, cy + 20, 0);
    grp.add(powder);
    parts.push({
      update: (tt) => {
        const k = Math.min(tt / (dur * 0.7), 1);
        mass.position.lerpVectors(from, to, k);
        mass.scale.setScalar(1 + k * 2.6);
        mass.rotation.x += 0.02; mass.rotation.z += 0.015;
        powderMat.opacity = Math.min(tt / dur, 1) * 0.75;
        powder.scale.setScalar(0.4 + k * 1.4);
      },
    });
  }

  // ---- flood: water rises and a wave front sweeps in -----------------------
  function buildFlood() {
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x1c4a6e, transparent: true, opacity: 0.72, roughness: 0.25, metalness: 0.1,
      emissive: new THREE.Color(0x0a2030), emissiveIntensity: 0.3,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R * 1.15, 48), waterMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, cy - 4, 0);
    grp.add(disc);
    const waveMat = new THREE.MeshBasicMaterial({
      color: 0x9fdfff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const wave = new THREE.Mesh(new THREE.TorusGeometry(R, 3, 8, 40), waveMat);
    wave.rotation.x = -Math.PI / 2;
    wave.position.set(0, cy + 2, 0);
    grp.add(wave);
    const topY = cy + 26;
    parts.push({
      update: (tt) => {
        const k = Math.min(tt / (dur * 0.8), 1);
        disc.position.y = THREE.MathUtils.lerp(cy - 4, topY, k);
        const g = 1 - k * 0.9;
        wave.scale.set(g, g, 1);
        wave.position.y = disc.position.y + 2;
        waveMat.opacity = 0.5 * (1 - k);
      },
    });
  }

  function update(dt) {
    if (finished) return;
    t += dt;
    for (const p of parts) p.update(t, dt);
    if (t >= dur) {
      finished = true;
      if (onDone) onDone();
    }
  }

  function dispose() {
    grp.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    if (grp.parent) grp.parent.remove(grp);
  }

  return { kind, update, dispose, get finished() { return finished; } };
}
