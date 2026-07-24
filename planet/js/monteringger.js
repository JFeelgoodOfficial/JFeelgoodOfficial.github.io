/**
 * MOUNTAIN HIKE 3D - Complete Game
 * A third-person hiking simulator with procedural terrain, stamina system,
 * and summit cinematic payoff.
 * 
 * Built with Three.js r160+ and vanilla JavaScript
 */

import * as THREE from 'three';

// ============================================================
// SECTION 1: UTILITY CLASSES & HELPERS
// ============================================================

/**
 * Simplex Noise implementation for terrain generation
 */
class SimplexNoise {
    constructor(seed = Math.random()) {
        this.p = new Uint8Array(512);
        this.perm = new Uint8Array(512);
        this.permMod12 = new Uint8Array(512);
        
        const permTable = [
            151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,
            140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,
            247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,
            57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,
            74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,
            60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,
            65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,
            200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,
            52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,
            207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,
            119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,
            129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,
            218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,
            81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,
            184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,
            222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180
        ];
        
        let s = seed * 2147483647 | 0;
        const shuffle = [...permTable];
        for (let i = shuffle.length - 1; i > 0; i--) {
            s = (s * 16807) % 2147483647;
            const j = s % (i + 1);
            [shuffle[i], shuffle[j]] = [shuffle[j], shuffle[i]];
        }
        
        for (let i = 0; i < 512; i++) {
            this.perm[i] = shuffle[i & 255];
            this.permMod12[i] = this.perm[i] % 12;
        }
        
        this.grad3 = [
            [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
            [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
            [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
        ];
        
        this.F3 = 1.0 / 3.0;
        this.G3 = 1.0 / 6.0;
    }
    
    noise3D(x, y, z) {
        const F3 = this.F3, G3 = this.G3;
        let s = (x + y + z) * F3;
        let i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
        let t = (i + j + k) * G3;
        let X0 = i - t, Y0 = j - t, Z0 = k - t;
        let x0 = x - X0, y0 = y - Y0, z0 = z - Z0;
        
        let i1, j1, k1, i2, j2, k2;
        if (x0 >= y0) {
            if (y0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=1; k2=0; }
            else if (x0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=0; k2=1; }
            else { i1=0; j1=0; k1=1; i2=1; j2=0; k2=1; }
        } else {
            if (y0 < z0) { i1=0; j1=0; k1=1; i2=0; j2=1; k2=1; }
            else if (x0 < z0) { i1=0; j1=1; k1=0; i2=0; j2=1; k2=1; }
            else { i1=0; j1=1; k1=0; i2=1; j2=1; k2=0; }
        }
        
        let x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
        let x2 = x0 - i2 + 2*G3, y2 = y0 - j2 + 2*G3, z2 = z0 - k2 + 2*G3;
        let x3 = x0 - 1 + 3*G3, y3 = y0 - 1 + 3*G3, z3 = z0 - 1 + 3*G3;
        
        let ii = i & 255, jj = j & 255, kk = k & 255;
        
        let n0, n1, n2, n3;
        let t0 = 0.6 - x0*x0 - y0*y0 - z0*z0;
        if (t0 < 0) n0 = 0;
        else { t0 *= t0; n0 = t0 * t0 * this.dot(this.grad3[this.permMod12[ii+this.perm[jj+this.perm[kk]]]], x0, y0, z0); }
        
        let t1 = 0.6 - x1*x1 - y1*y1 - z1*z1;
        if (t1 < 0) n1 = 0;
        else { t1 *= t1; n1 = t1 * t1 * this.dot(this.grad3[this.permMod12[ii+i1+this.perm[jj+j1+this.perm[kk+k1]]]], x1, y1, z1); }
        
        let t2 = 0.6 - x2*x2 - y2*y2 - z2*z2;
        if (t2 < 0) n2 = 0;
        else { t2 *= t2; n2 = t2 * t2 * this.dot(this.grad3[this.permMod12[ii+i2+this.perm[jj+j2+this.perm[kk+k2]]]], x2, y2, z2); }
        
        let t3 = 0.6 - x3*x3 - y3*y3 - z3*z3;
        if (t3 < 0) n3 = 0;
        else { t3 *= t3; n3 = t3 * t3 * this.dot(this.grad3[this.permMod12[ii+1+this.perm[jj+1+this.perm[kk+1]]]], x3, y3, z3); }
        
        return 32 * (n0 + n1 + n2 + n3);
    }
    
    dot(g, x, y, z) { return g[0]*x + g[1]*y + g[2]*z; }
    
    fbm(x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
        let total = 0, amplitude = 1, frequency = 1;
        let maxValue = 0;
        for (let i = 0; i < octaves; i++) {
            total += this.noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= gain;
            frequency *= lacunarity;
        }
        return total / maxValue;
    }
}

class TerrainGenerator {
    constructor(seed = 42) {
        this.noise = new SimplexNoise(seed);
        this.noise2 = new SimplexNoise(seed + 100);
        this.noise3 = new SimplexNoise(seed + 200);
        
        this.mountainRadius = 120;
        this.mountainHeight = 180;
        this.trailWidth = 3.5;
        this.trailWinding = 0.03;
        this.trailAmplitude = 25;
    }
    
    getMountainHeight(x, z) {
        const distFromCenter = Math.sqrt(x * x + z * z);
        const normalizedDist = distFromCenter / this.mountainRadius;
        
        let height = this.mountainHeight * Math.max(0, 1 - normalizedDist);
        height += this.noise.fbm(x * 0.02, 0, z * 0.02, 3, 2.0, 0.5) * 15;
        height += this.noise2.fbm(x * 0.05, 0, z * 0.05, 2, 2.0, 0.5) * 5;
        
        if (height > this.mountainHeight * 0.85) {
            height = this.mountainHeight * 0.85 + (height - this.mountainHeight * 0.85) * 0.3;
        }
        
        return Math.max(0, height);
    }
    
    getTrailCenterAtHeight(height) {
        const progress = Math.max(0, Math.min(1, height / this.mountainHeight));
        const angle = progress * Math.PI * 6;
        const radius = this.mountainRadius * (1 - progress * 0.85);
        
        const windX = Math.sin(angle * 2.5) * this.trailAmplitude * (1 - progress * 0.5);
        const windZ = Math.cos(angle * 1.7) * this.trailAmplitude * 0.5 * (1 - progress * 0.5);
        
        const x = Math.cos(angle) * radius + windX;
        const z = Math.sin(angle) * radius + windZ;
        
        return { x, z, angle, radius, progress };
    }
    
    getClosestTrailPoint(x, z) {
        const dist = Math.sqrt(x * x + z * z);
        const angle = Math.atan2(z, x);
        
        let estimatedHeight = this.mountainHeight * (1 - dist / this.mountainRadius);
        estimatedHeight = Math.max(0, Math.min(this.mountainHeight, estimatedHeight));
        
        return this.getTrailCenterAtHeight(estimatedHeight);
    }
    
    getHeight(x, z) {
        const baseHeight = this.getMountainHeight(x, z);
        const trail = this.getClosestTrailPoint(x, z);
        
        const dx = x - trail.x;
        const dz = z - trail.z;
        const distFromTrail = Math.sqrt(dx * dx + dz * dz);
        
        let trailFactor = 0;
        if (distFromTrail < this.trailWidth * 2.5) {
            const t = distFromTrail / (this.trailWidth * 2.5);
            trailFactor = Math.max(0, 1 - t * t);
        }
        
        const trailHeight = baseHeight - 1.5;
        let finalHeight = baseHeight * (1 - trailFactor * 0.7) + trailHeight * trailFactor * 0.7;
        
        if (distFromTrail < this.trailWidth) {
            finalHeight += this.noise3.noise3D(x * 0.3, 0, z * 0.3) * 0.3;
        }
        
        return finalHeight;
    }
    
    getSlope(x, z) {
        const delta = 0.5;
        const h0 = this.getHeight(x, z);
        const hx = this.getHeight(x + delta, z);
        const hz = this.getHeight(x, z + delta);
        
        const dx = (hx - h0) / delta;
        const dz = (hz - h0) / delta;
        
        return Math.atan(Math.sqrt(dx * dx + dz * dz));
    }
    
    getZone(x, z) {
        const height = this.getHeight(x, z);
        const progress = height / this.mountainHeight;
        
        if (progress < 0.33) return 'forest';
        if (progress < 0.66) return 'alpine';
        return 'summit';
    }
    
    getTrailDirection(x, z) {
        const currentHeight = this.getHeight(x, z);
        const trail = this.getTrailCenterAtHeight(currentHeight);
        const nextTrail = this.getTrailCenterAtHeight(
            Math.min(this.mountainHeight, currentHeight + 3)
        );
        
        const dx = nextTrail.x - trail.x;
        const dz = nextTrail.z - trail.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        
        if (len < 0.001) return { x: 1, z: 0 };
        return { x: dx / len, z: dz / len };
    }
    
    isOnTrail(x, z) {
        const trail = this.getClosestTrailPoint(x, z);
        const dx = x - trail.x;
        const dz = z - trail.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        return dist < this.trailWidth * 2.0;
    }
    
    getDistanceToSummit(x, z) {
        const currentHeight = this.getHeight(x, z);
        const remainingHeight = this.mountainHeight - currentHeight;
        
        const progress = currentHeight / this.mountainHeight;
        const avgRadius = this.mountainRadius * (1 - progress * 0.4);
        const spiralLength = Math.PI * 6 * avgRadius * (1 - progress);
        
        return Math.sqrt(spiralLength * spiralLength + remainingHeight * remainingHeight);
    }
    
    isAtSummit(x, z) {
        const height = this.getHeight(x, z);
        return height >= this.mountainHeight * 0.90;
    }
    
    getTrailHeightAt(x, z) {
        const trail = this.getClosestTrailPoint(x, z);
        const dx = x - trail.x;
        const dz = z - trail.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < this.trailWidth * 2) {
            return this.getHeight(trail.x, trail.z);
        }
        return this.getHeight(x, z);
    }
}

// ============================================================
// SECTION 2: PLAYER SYSTEM
// ============================================================

class Player {
    constructor(scene, terrain) {
        this.scene = scene;
        this.terrain = terrain;
        
        const startTrail = terrain.getTrailCenterAtHeight(2);
        this.position = new THREE.Vector3(startTrail.x, 2, startTrail.z);
        this.velocity = new THREE.Vector3(0, 0, 0);
        
        this.grounded = true;
        this.groundHeight = 2;
        
        this.moveSpeed = 0;
        this.maxWalkSpeed = 4.0;
        this.maxRunSpeed = 8.0;
        this.maxExhaustedSpeed = 2.0;
        this.acceleration = 20.0;
        this.friction = 10.0;
        this.jumpForce = 6.0;
        this.gravity = 25.0;
        
        this.stamina = 100;
        this.maxStamina = 100;
        this.staminaDrainRate = 18;
        this.staminaRegenRate = 12;
        this.staminaRestRegen = 30;
        this.exhausted = false;
        this.resting = false;
        
        this.currentSlope = 0;
        this.slopeSpeedPenalty = 0;
        
        this.mesh = this.createCharacterMesh();
        this.scene.add(this.mesh);
        
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.cameraOffset = new THREE.Vector3(0, 3.5, -7);
        this.cameraBob = 0;
        this.cameraBobPhase = 0;
        
        this.walkCycle = 0;
        
        this.keys = {
            w: false, a: false, s: false, d: false,
            up: false, down: false, left: false, right: false,
            shift: false, space: false
        };
        
        this.setupInput();
    }
    
    createCharacterMesh() {
        const group = new THREE.Group();
        
        const skinMat = new THREE.MeshLambertMaterial({ color: 0xffcc99 });
        const shirtMat = new THREE.MeshLambertMaterial({ color: 0xcc4444 });
        const pantsMat = new THREE.MeshLambertMaterial({ color: 0x334466 });
        const bootMat = new THREE.MeshLambertMaterial({ color: 0x4a3728 });
        const packMat = new THREE.MeshLambertMaterial({ color: 0x8B4513 });
        
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, 0.28), skinMat);
        head.position.y = 1.65;
        group.add(head);
        
        const hat = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.15, 8), new THREE.MeshLambertMaterial({ color: 0x5C4033 }));
        hat.position.y = 1.85;
        group.add(hat);
        
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.25), shirtMat);
        torso.position.y = 1.25;
        group.add(torso);
        
        const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.2), packMat);
        backpack.position.set(0, 1.3, -0.25);
        group.add(backpack);
        
        this.leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), skinMat);
        this.leftArm.position.set(-0.28, 1.25, 0);
        group.add(this.leftArm);
        
        this.rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), skinMat);
        this.rightArm.position.set(0.28, 1.25, 0);
        group.add(this.rightArm);
        
        this.leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.14), pantsMat);
        this.leftLeg.position.set(-0.12, 0.7, 0);
        group.add(this.leftLeg);
        
        this.rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.55, 0.14), pantsMat);
        this.rightLeg.position.set(0.12, 0.7, 0);
        group.add(this.rightLeg);
        
        const leftBoot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.2), bootMat);
        leftBoot.position.set(-0.12, 0.36, 0.03);
        group.add(leftBoot);
        
        const rightBoot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.2), bootMat);
        rightBoot.position.set(0.12, 0.36, 0.03);
        group.add(rightBoot);
        
        const shadow = new THREE.Mesh(
            new THREE.CircleGeometry(0.4, 16),
            new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 })
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.02;
        group.add(shadow);
        
        group.castShadow = true;
        return group;
    }
    
    setupInput() {
        document.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();
            if (key === 'w' || key === 'arrowup') { this.keys.w = true; this.keys.up = true; }
            if (key === 's' || key === 'arrowdown') { this.keys.s = true; this.keys.down = true; }
            if (key === 'a' || key === 'arrowleft') { this.keys.a = true; this.keys.left = true; }
            if (key === 'd' || key === 'arrowright') { this.keys.d = true; this.keys.right = true; }
            if (key === 'shift') this.keys.shift = true;
            if (key === ' ') this.keys.space = true;
        });
        
        document.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (key === 'w' || key === 'arrowup') { this.keys.w = false; this.keys.up = false; }
            if (key === 's' || key === 'arrowdown') { this.keys.s = false; this.keys.down = false; }
            if (key === 'a' || key === 'arrowleft') { this.keys.a = false; this.keys.left = false; }
            if (key === 'd' || key === 'arrowright') { this.keys.d = false; this.keys.right = false; }
            if (key === 'shift') this.keys.shift = false;
            if (key === ' ') this.keys.space = false;
        });
    }
    
    update(dt) {
        let inputX = 0;
        let inputZ = 0;
        
        if (this.keys.w || this.keys.up) inputZ -= 1;
        if (this.keys.s || this.keys.down) inputZ += 1;
        if (this.keys.a || this.keys.left) inputX -= 1;
        if (this.keys.d || this.keys.right) inputX += 1;
        
        const inputLen = Math.sqrt(inputX * inputX + inputZ * inputZ);
        if (inputLen > 0) {
            inputX /= inputLen;
            inputZ /= inputLen;
        }
        
        this.resting = this.keys.shift && inputLen === 0;
        
        const trailDir = this.terrain.getTrailDirection(this.position.x, this.position.z);
        
        const forward = new THREE.Vector3(trailDir.x, 0, trailDir.z);
        const right = new THREE.Vector3(-trailDir.z, 0, trailDir.x);
        
        const moveDir = new THREE.Vector3()
            .addScaledVector(forward, -inputZ)
            .addScaledVector(right, inputX);
        
        this.groundHeight = this.terrain.getHeight(this.position.x, this.position.z);
        this.currentSlope = this.terrain.getSlope(this.position.x, this.position.z);
        
        const slopeDegrees = this.currentSlope * (180 / Math.PI);
        this.slopeSpeedPenalty = Math.max(0, (slopeDegrees - 10) / 30);
        
        let targetMaxSpeed;
        if (this.exhausted) {
            targetMaxSpeed = this.maxExhaustedSpeed;
        } else if (this.resting) {
            targetMaxSpeed = 0;
        } else {
            targetMaxSpeed = this.maxRunSpeed;
        }
        
        targetMaxSpeed *= (1 - this.slopeSpeedPenalty * 0.5);
        
        const isMoving = inputLen > 0 && !this.resting;
        const isRunning = isMoving && !this.exhausted;
        
        if (isRunning) {
            const slopeDrainMult = 1 + this.slopeSpeedPenalty * 2;
            this.stamina -= this.staminaDrainRate * dt * slopeDrainMult;
        } else if (this.resting) {
            this.stamina += this.staminaRestRegen * dt;
        } else {
            this.stamina += this.staminaRegenRate * dt;
        }
        
        this.stamina = Math.max(0, Math.min(this.maxStamina, this.stamina));
        
        if (this.stamina <= 0) {
            this.exhausted = true;
        } else if (this.stamina > 30) {
            this.exhausted = false;
        }
        
        if (isMoving) {
            const targetVelX = moveDir.x * targetMaxSpeed;
            const targetVelZ = moveDir.z * targetMaxSpeed;
            
            this.velocity.x += (targetVelX - this.velocity.x) * this.acceleration * dt;
            this.velocity.z += (targetVelZ - this.velocity.z) * this.acceleration * dt;
        } else {
            this.velocity.x *= Math.max(0, 1 - this.friction * dt);
            this.velocity.z *= Math.max(0, 1 - this.friction * dt);
        }
        
        if (this.keys.space && this.grounded) {
            this.velocity.y = this.jumpForce;
            this.grounded = false;
        }
        
        if (!this.grounded) {
            this.velocity.y -= this.gravity * dt;
        }
        
        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;
        this.position.y += this.velocity.y * dt;
        
        const terrainHeight = this.terrain.getTrailHeightAt(this.position.x, this.position.z);
        if (this.position.y <= terrainHeight + 0.3) {
            this.position.y = terrainHeight + 0.3;
            this.velocity.y = 0;
            this.grounded = true;
        }
        
        this.mesh.position.copy(this.position);
        
        const horizVel = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
        if (horizVel.length() > 0.1) {
            const targetRotation = Math.atan2(horizVel.x, horizVel.z);
            let rotDiff = targetRotation - this.mesh.rotation.y;
            while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
            while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
            this.mesh.rotation.y += rotDiff * 10 * dt;
        }
        
        const speed = horizVel.length();
        if (speed > 0.1 && this.grounded) {
            this.walkCycle += speed * dt * 3;
            
            this.leftLeg.rotation.x = Math.sin(this.walkCycle) * 0.4;
            this.rightLeg.rotation.x = Math.sin(this.walkCycle + Math.PI) * 0.4;
            this.leftArm.rotation.x = Math.sin(this.walkCycle + Math.PI) * 0.3;
            this.rightArm.rotation.x = Math.sin(this.walkCycle) * 0.3;
        } else {
            this.leftLeg.rotation.x *= 0.9;
            this.rightLeg.rotation.x *= 0.9;
            this.leftArm.rotation.x *= 0.9;
            this.rightArm.rotation.x *= 0.9;
        }
        
        if (speed > 0.1 && this.grounded) {
            this.cameraBobPhase += speed * dt * 4;
            this.cameraBob = Math.sin(this.cameraBobPhase) * 0.08 * Math.min(1, speed / 5);
        } else {
            this.cameraBob *= 0.9;
        }
        
        this.updateCamera(dt);
    }
    
    updateCamera(dt) {
        const offset = this.cameraOffset.clone();
        offset.y += this.cameraBob;
        
        const cos = Math.cos(this.mesh.rotation.y);
        const sin = Math.sin(this.mesh.rotation.y);
        const rotatedOffset = new THREE.Vector3(
            offset.x * cos + offset.z * sin,
            offset.y,
            -offset.x * sin + offset.z * cos
        );
        
        const targetPos = this.position.clone().add(rotatedOffset);
        this.camera.position.lerp(targetPos, 5 * dt);
        
        const lookTarget = this.position.clone().add(new THREE.Vector3(0, 1.5, 0));
        this.camera.lookAt(lookTarget);
    }
    
    reset() {
        const startTrail = this.terrain.getTrailCenterAtHeight(2);
        this.position.set(startTrail.x, 2, startTrail.z);
        this.velocity.set(0, 0, 0);
        this.stamina = 100;
        this.exhausted = false;
        this.grounded = true;
        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = 0;
    }
}

// ============================================================
// SECTION 3: TERRAIN MESH & ENVIRONMENT
// ============================================================

class TerrainMesh {
    constructor(scene, terrain) {
        this.scene = scene;
        this.terrain = terrain;
        
        this.resolution = 200;
        this.size = 250;
        this.geometry = this.createTerrainGeometry();
        
        this.material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.9,
            metalness: 0.05,
            flatShading: true
        });
        
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = true;
        this.scene.add(this.mesh);
        
        this.createWater();
        this.generateEnvironment();
    }
    
    createTerrainGeometry() {
        const geometry = new THREE.PlaneGeometry(
            this.size, this.size,
            this.resolution, this.resolution
        );
        geometry.rotateX(-Math.PI / 2);
        
        const positions = geometry.attributes.position;
        const colors = new Float32Array(positions.count * 3);
        
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const z = positions.getZ(i);
            
            const height = this.terrain.getHeight(x, z);
            positions.setY(i, height);
            
            const progress = height / this.terrain.mountainHeight;
            const color = new THREE.Color();
            
            if (progress < 0.33) {
                const variation = Math.random() * 0.1;
                color.setRGB(0.15 + variation, 0.4 + variation, 0.1 + variation);
            } else if (progress < 0.66) {
                const t = (progress - 0.33) / 0.33;
                color.setRGB(0.3 - t * 0.15, 0.35 - t * 0.2, 0.25 - t * 0.15);
            } else {
                const t = (progress - 0.66) / 0.34;
                if (t > 0.7) {
                    color.setRGB(0.85 + Math.random() * 0.1, 0.9 + Math.random() * 0.05, 0.95);
                } else {
                    color.setRGB(0.4 + Math.random() * 0.1, 0.4 + Math.random() * 0.1, 0.42 + Math.random() * 0.1);
                }
            }
            
            const trail = this.terrain.getClosestTrailPoint(x, z);
            const distFromTrail = Math.sqrt((x - trail.x) ** 2 + (z - trail.z) ** 2);
            if (distFromTrail < this.terrain.trailWidth * 1.5) {
                const trailFactor = Math.max(0, 1 - distFromTrail / (this.terrain.trailWidth * 1.5));
                color.lerp(new THREE.Color(0.35, 0.3, 0.2), trailFactor * 0.5);
            }
            
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }
        
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.computeVertexNormals();
        
        return geometry;
    }
    
    createWater() {
        const waterGeometry = new THREE.PlaneGeometry(this.size * 2, this.size * 2);
        waterGeometry.rotateX(-Math.PI / 2);
        
        const waterMaterial = new THREE.MeshStandardMaterial({
            color: 0x1a5276,
            transparent: true,
            opacity: 0.7,
            roughness: 0.1,
            metalness: 0.3
        });
        
        this.water = new THREE.Mesh(waterGeometry, waterMaterial);
        this.water.position.y = -2;
        this.scene.add(this.water);
    }
    
    generateEnvironment() {
        this.generateTrees();
        this.generateRocks();
        this.generateFlowers();
        this.generateFallenLogs();
        this.generateStream();
        this.generateSummitFeatures();
    }
    
    generateTrees() {
        const pineGeometry = new THREE.ConeGeometry(0.8, 3, 6);
        const pineMaterial = new THREE.MeshLambertMaterial({ color: 0x1a4a1a });
        
        const deciduousGeometry = new THREE.SphereGeometry(1, 6, 4);
        const deciduousMaterial = new THREE.MeshLambertMaterial({ color: 0x2d5a1e });
        
        const trunkGeometry = new THREE.CylinderGeometry(0.1, 0.15, 1, 5);
        const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x4a3728 });
        
        const pineCount = 800;
        const deciduousCount = 300;
        const trunkCount = 1100;
        
        this.pineMesh = new THREE.InstancedMesh(pineGeometry, pineMaterial, pineCount);
        this.deciduousMesh = new THREE.InstancedMesh(deciduousGeometry, deciduousMaterial, deciduousCount);
        this.trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trunkCount);
        
        this.pineMesh.castShadow = true;
        this.deciduousMesh.castShadow = true;
        this.trunkMesh.castShadow = true;
        
        const dummy = new THREE.Object3D();
        let pineIdx = 0, decIdx = 0, trunkIdx = 0;
        
        for (let i = 0; i < 3000; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 5 + Math.random() * (this.terrain.mountainRadius - 5);
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            const height = this.terrain.getHeight(x, z);
            
            if (this.terrain.isOnTrail(x, z)) continue;
            
            const progress = height / this.terrain.mountainHeight;
            
            if (progress < 0.33) {
                const density = 1 - progress / 0.33;
                if (Math.random() > density * 0.8) continue;
                
                if (Math.random() < 0.6 && pineIdx < pineCount) {
                    dummy.position.set(x, height + 1.5, z);
                    dummy.scale.setScalar(0.7 + Math.random() * 0.6);
                    dummy.rotation.set(0, Math.random() * Math.PI, 0);
                    dummy.updateMatrix();
                    this.pineMesh.setMatrixAt(pineIdx++, dummy.matrix);
                    
                    dummy.position.set(x, height + 0.5, z);
                    dummy.scale.set(1, 1.5 + Math.random(), 1);
                    dummy.updateMatrix();
                    this.trunkMesh.setMatrixAt(trunkIdx++, dummy.matrix);
                } else if (decIdx < deciduousCount) {
                    dummy.position.set(x, height + 2, z);
                    dummy.scale.setScalar(0.8 + Math.random() * 0.7);
                    dummy.updateMatrix();
                    this.deciduousMesh.setMatrixAt(decIdx++, dummy.matrix);
                    
                    dummy.position.set(x, height + 0.8, z);
                    dummy.scale.set(1, 2 + Math.random(), 1);
                    dummy.updateMatrix();
                    this.trunkMesh.setMatrixAt(trunkIdx++, dummy.matrix);
                }
            } else if (progress < 0.66) {
                if (Math.random() > 0.15) continue;
                
                if (pineIdx < pineCount) {
                    dummy.position.set(x, height + 1.2, z);
                    dummy.scale.setScalar(0.5 + Math.random() * 0.4);
                    dummy.updateMatrix();
                    this.pineMesh.setMatrixAt(pineIdx++, dummy.matrix);
                    
                    dummy.position.set(x, height + 0.4, z);
                    dummy.scale.set(1, 1.2, 1);
                    dummy.updateMatrix();
                    this.trunkMesh.setMatrixAt(trunkIdx++, dummy.matrix);
                }
            }
        }
        
        this.pineMesh.instanceMatrix.needsUpdate = true;
        this.deciduousMesh.instanceMatrix.needsUpdate = true;
        this.trunkMesh.instanceMatrix.needsUpdate = true;
        
        this.scene.add(this.pineMesh);
        this.scene.add(this.deciduousMesh);
        this.scene.add(this.trunkMesh);
    }
    
    generateRocks() {
        const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
        const rockMaterial = new THREE.MeshStandardMaterial({
            color: 0x666666,
            roughness: 0.95,
            flatShading: true
        });
        
        const rockCount = 600;
        this.rockMesh = new THREE.InstancedMesh(rockGeometry, rockMaterial, rockCount);
        this.rockMesh.castShadow = true;
        this.rockMesh.receiveShadow = true;
        
        const dummy = new THREE.Object3D();
        let idx = 0;
        
        for (let i = 0; i < 2000; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 3 + Math.random() * (this.terrain.mountainRadius - 3);
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            const height = this.terrain.getHeight(x, z);
            
            if (this.terrain.isOnTrail(x, z)) continue;
            
            const progress = height / this.terrain.mountainHeight;
            
            let placeChance = 0.1;
            if (progress > 0.33) placeChance = 0.4;
            if (progress > 0.66) placeChance = 0.6;
            
            if (Math.random() > placeChance) continue;
            if (idx >= rockCount) break;
            
            dummy.position.set(x, height + 0.3, z);
            dummy.scale.set(
                0.3 + Math.random() * 0.8,
                0.2 + Math.random() * 0.5,
                0.3 + Math.random() * 0.8
            );
            dummy.rotation.set(
                Math.random() * Math.PI,
                Math.random() * Math.PI,
                Math.random() * Math.PI
            );
            dummy.updateMatrix();
            this.rockMesh.setMatrixAt(idx++, dummy.matrix);
        }
        
        this.rockMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(this.rockMesh);
    }
    
    generateFlowers() {
        const flowerColors = [0xff6b6b, 0xffd93d, 0x6bcf7f, 0x4ecdc4, 0xff8cc8];
        const flowerGeometry = new THREE.SphereGeometry(0.08, 4, 4);
        
        const flowerCount = 500;
        this.flowerMesh = new THREE.InstancedMesh(flowerGeometry, new THREE.MeshLambertMaterial({ color: 0xffffff }), flowerCount);
        
        const dummy = new THREE.Object3D();
        let idx = 0;
        
        for (let i = 0; i < 1500; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 4 + Math.random() * (this.terrain.mountainRadius - 4);
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            const height = this.terrain.getHeight(x, z);
            
            if (this.terrain.isOnTrail(x, z)) continue;
            
            const progress = height / this.terrain.mountainHeight;
            if (progress > 0.5) continue;
            if (Math.random() > 0.3) continue;
            if (idx >= flowerCount) break;
            
            dummy.position.set(x, height + 0.1, z);
            dummy.scale.setScalar(0.5 + Math.random() * 0.5);
            dummy.updateMatrix();
            this.flowerMesh.setMatrixAt(idx, dummy.matrix);
            
            const color = new THREE.Color(flowerColors[Math.floor(Math.random() * flowerColors.length)]);
            this.flowerMesh.setColorAt(idx, color);
            idx++;
        }
        
        this.flowerMesh.instanceMatrix.needsUpdate = true;
        this.flowerMesh.instanceColor.needsUpdate = true;
        this.scene.add(this.flowerMesh);
    }
    
    generateFallenLogs() {
        const logGeometry = new THREE.CylinderGeometry(0.15, 0.15, 2, 6);
        const logMaterial = new THREE.MeshLambertMaterial({ color: 0x5C4033 });
        
        for (let i = 0; i < 15; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 10 + Math.random() * 40;
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            const height = this.terrain.getHeight(x, z);
            
            if (this.terrain.isOnTrail(x, z)) continue;
            
            const log = new THREE.Mesh(logGeometry, logMaterial);
            log.position.set(x, height + 0.15, z);
            log.rotation.set(Math.random() * 0.3, Math.random() * Math.PI, Math.PI / 2 + Math.random() * 0.2);
            log.castShadow = true;
            this.scene.add(log);
        }
    }
    
    generateStream() {
        const stoneGeometry = new THREE.CylinderGeometry(0.4, 0.5, 0.15, 6);
        const stoneMaterial = new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 0.9 });
        
        for (let i = 0; i < 8; i++) {
            const t = (i + 1) / 9;
            const x = -12 + t * 24;
            const z = 20 + Math.sin(t * Math.PI * 2) * 4;
            const height = this.terrain.getHeight(x, z);
            
            const stone = new THREE.Mesh(stoneGeometry, stoneMaterial);
            stone.position.set(x, height + 0.1, z);
            stone.rotation.y = Math.random() * Math.PI;
            stone.castShadow = true;
            this.scene.add(stone);
        }
    }
    
    generateSummitFeatures() {
        const summitTrail = this.terrain.getTrailCenterAtHeight(this.terrain.mountainHeight * 0.95);
        const summitHeight = this.terrain.getHeight(summitTrail.x, summitTrail.z);
        
        const cairnGroup = new THREE.Group();
        
        for (let i = 0; i < 5; i++) {
            const rock = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.15 + i * 0.05, 0),
                new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.9 })
            );
            rock.position.set(
                (Math.random() - 0.5) * 0.1,
                i * 0.2,
                (Math.random() - 0.5) * 0.1
            );
            rock.castShadow = true;
            cairnGroup.add(rock);
        }
        
        cairnGroup.position.set(summitTrail.x + 1, summitHeight, summitTrail.z + 1);
        this.scene.add(cairnGroup);
        
        const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.03, 0.03, 2, 4),
            new THREE.MeshLambertMaterial({ color: 0x8B4513 })
        );
        pole.position.set(summitTrail.x - 1, summitHeight + 1, summitTrail.z - 1);
        this.scene.add(pole);
        
        const flag = new THREE.Mesh(
            new THREE.PlaneGeometry(0.6, 0.4),
            new THREE.MeshLambertMaterial({ color: 0xff0000, side: THREE.DoubleSide })
        );
        flag.position.set(summitTrail.x - 0.7, summitHeight + 1.7, summitTrail.z - 1);
        this.scene.add(flag);
        this.summitFlag = flag;
    }
    
    update(time) {
        if (this.water) {
            this.water.position.y = -2 + Math.sin(time * 0.5) * 0.1;
        }
        
        if (this.summitFlag) {
            this.summitFlag.rotation.y = Math.sin(time * 2) * 0.3;
        }
    }
}

// ============================================================
// SECTION 4: DISTANT MOUNTAINS & SKY
// ============================================================

class DistantMountains {
    constructor(scene) {
        this.scene = scene;
        this.createDistantMountains();
        this.createSky();
        this.createVolumetricRays();
        this.createClouds();
    }
    
    createDistantMountains() {
        const noise = new SimplexNoise(999);
        
        for (let ring = 0; ring < 3; ring++) {
            const radius = 300 + ring * 150;
            const segments = 40 + ring * 20;
            const mountainHeight = 80 - ring * 20;
            
            const geometry = new THREE.PlaneGeometry(radius * 2, radius * 2, segments, 4);
            geometry.rotateX(-Math.PI / 2);
            
            const positions = geometry.attributes.position;
            for (let i = 0; i < positions.count; i++) {
                const x = positions.getX(i);
                const z = positions.getZ(i);
                const dist = Math.sqrt(x * x + z * z);
                
                if (dist > radius * 0.3) {
                    const h = noise.fbm(x * 0.01, 0, z * 0.01, 3) * mountainHeight;
                    positions.setY(i, h - 10);
                } else {
                    positions.setY(i, -50);
                }
            }
            
            geometry.computeVertexNormals();
            
            const colorValue = 0.3 - ring * 0.08;
            const material = new THREE.MeshStandardMaterial({
                color: new THREE.Color(colorValue, colorValue, colorValue + 0.05),
                roughness: 1,
                flatShading: true,
                transparent: true,
                opacity: 0.6 - ring * 0.15
            });
            
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.y = -5;
            this.scene.add(mesh);
        }
    }
    
    createSky() {
        const skyGeometry = new THREE.SphereGeometry(800, 32, 32);
        
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        gradient.addColorStop(0, '#1a1a3e');
        gradient.addColorStop(0.3, '#4a4a8a');
        gradient.addColorStop(0.5, '#d4a574');
        gradient.addColorStop(0.7, '#f4d03f');
        gradient.addColorStop(1, '#ffecd2');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2, 512);
        
        const texture = new THREE.CanvasTexture(canvas);
        const skyMaterial = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.BackSide
        });
        
        this.sky = new THREE.Mesh(skyGeometry, skyMaterial);
        this.scene.add(this.sky);
    }
    
    createVolumetricRays() {
        this.rays = [];
        
        for (let i = 0; i < 8; i++) {
            const geometry = new THREE.ConeGeometry(2 + Math.random() * 3, 80 + Math.random() * 40, 4, 1, true);
            const material = new THREE.MeshBasicMaterial({
                color: 0xffeebb,
                transparent: true,
                opacity: 0.03,
                side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            
            const ray = new THREE.Mesh(geometry, material);
            ray.position.set(
                (Math.random() - 0.5) * 100,
                80 + Math.random() * 30,
                (Math.random() - 0.5) * 100
            );
            ray.rotation.x = Math.random() * 0.5;
            ray.rotation.z = Math.random() * 0.5;
            
            this.scene.add(ray);
            this.rays.push({
                mesh: ray,
                baseOpacity: 0.02 + Math.random() * 0.03,
                phase: Math.random() * Math.PI * 2
            });
        }
    }
    
    createClouds() {
        this.clouds = [];
        
        for (let i = 0; i < 20; i++) {
            const geometry = new THREE.SphereGeometry(5 + Math.random() * 10, 6, 4);
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.15,
                depthWrite: false
            });
            
            const cloud = new THREE.Mesh(geometry, material);
            cloud.position.set(
                (Math.random() - 0.5) * 200,
                140 + Math.random() * 40,
                (Math.random() - 0.5) * 200
            );
            cloud.scale.set(1 + Math.random(), 0.3 + Math.random() * 0.3, 1 + Math.random());
            
            this.scene.add(cloud);
            this.clouds.push({
                mesh: cloud,
                speed: 0.5 + Math.random() * 1.5,
                phase: Math.random() * Math.PI * 2
            });
        }
    }
    
    update(time) {
        this.rays.forEach(ray => {
            ray.mesh.material.opacity = ray.baseOpacity + Math.sin(time * 0.5 + ray.phase) * 0.01;
        });
        
        this.clouds.forEach(cloud => {
            cloud.mesh.position.x += Math.sin(time * 0.1 + cloud.phase) * 0.02;
            cloud.mesh.position.z += Math.cos(time * 0.1 + cloud.phase) * 0.01;
        });
    }
}

// ============================================================
// SECTION 5: LIGHTING & ATMOSPHERE
// ============================================================

class LightingManager {
    constructor(scene) {
        this.scene = scene;
        this.currentZone = 'forest';
        
        this.sunLight = new THREE.DirectionalLight(0xffddaa, 1.5);
        this.sunLight.position.set(100, 150, 50);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 0.5;
        this.sunLight.shadow.camera.far = 500;
        this.sunLight.shadow.camera.left = -150;
        this.sunLight.shadow.camera.right = 150;
        this.sunLight.shadow.camera.top = 150;
        this.sunLight.shadow.camera.bottom = -150;
        this.scene.add(this.sunLight);
        
        this.ambientLight = new THREE.AmbientLight(0x404060, 0.5);
        this.scene.add(this.ambientLight);
        
        this.hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x3d5c3d, 0.4);
        this.scene.add(this.hemiLight);
        
        this.scene.fog = new THREE.FogExp2(0x88aa88, 0.008);
        
        this.zoneConfigs = {
            forest: {
                fogColor: new THREE.Color(0x88aa88),
                fogDensity: 0.008,
                sunColor: new THREE.Color(0xffddaa),
                sunIntensity: 1.5,
                ambientColor: new THREE.Color(0x404060),
                ambientIntensity: 0.5,
                hemiSky: new THREE.Color(0x87CEEB),
                hemiGround: new THREE.Color(0x3d5c3d)
            },
            alpine: {
                fogColor: new THREE.Color(0xaabbcc),
                fogDensity: 0.005,
                sunColor: new THREE.Color(0xffeebb),
                sunIntensity: 1.8,
                ambientColor: new THREE.Color(0x506080),
                ambientIntensity: 0.6,
                hemiSky: new THREE.Color(0x99bbdd),
                hemiGround: new THREE.Color(0x5a6a5a)
            },
            summit: {
                fogColor: new THREE.Color(0xccddff),
                fogDensity: 0.003,
                sunColor: new THREE.Color(0xffffee),
                sunIntensity: 2.0,
                ambientColor: new THREE.Color(0x6070a0),
                ambientIntensity: 0.7,
                hemiSky: new THREE.Color(0xaaccff),
                hemiGround: new THREE.Color(0x7a8a9a)
            }
        };
        
        this.transitionProgress = 1;
        this.fromConfig = null;
        this.toConfig = null;
    }
    
    updateZone(zone, dt) {
        if (zone !== this.currentZone) {
            this.fromConfig = this.zoneConfigs[this.currentZone];
            this.toConfig = this.zoneConfigs[zone];
            this.currentZone = zone;
            this.transitionProgress = 0;
        }
        
        if (this.transitionProgress < 1) {
            this.transitionProgress = Math.min(1, this.transitionProgress + dt * 0.5);
            this.applyTransition(this.transitionProgress);
        }
    }
    
    applyTransition(t) {
        if (!this.fromConfig || !this.toConfig) return;
        
        const lerpColor = (a, b, t) => a.clone().lerp(b, t);
        const lerp = (a, b, t) => a + (b - a) * t;
        
        this.scene.fog.color.copy(lerpColor(this.fromConfig.fogColor, this.toConfig.fogColor, t));
        this.scene.fog.density = lerp(this.fromConfig.fogDensity, this.toConfig.fogDensity, t);
        
        this.sunLight.color.copy(lerpColor(this.fromConfig.sunColor, this.toConfig.sunColor, t));
        this.sunLight.intensity = lerp(this.fromConfig.sunIntensity, this.toConfig.sunIntensity, t);
        
        this.ambientLight.color.copy(lerpColor(this.fromConfig.ambientColor, this.toConfig.ambientColor, t));
        this.ambientLight.intensity = lerp(this.fromConfig.ambientIntensity, this.toConfig.ambientIntensity, t);
        
        this.hemiLight.color.copy(lerpColor(this.fromConfig.hemiSky, this.toConfig.hemiSky, t));
        this.hemiLight.groundColor.copy(lerpColor(this.fromConfig.hemiGround, this.toConfig.hemiGround, t));
    }
    
    updateTimeOfDay(time) {
        const sunAngle = time * 0.02 + 0.3;
        this.sunLight.position.x = Math.cos(sunAngle) * 100;
        this.sunLight.position.y = Math.sin(sunAngle) * 80 + 70;
        this.sunLight.position.z = Math.sin(sunAngle * 0.5) * 50;
    }
}

============================================================
// SECTION 6: PARTICLE SYSTEMS
// ============================================================

class ParticleSystem {
    constructor(scene, terrain) {
        this.scene = scene;
        this.terrain = terrain;
        
        this.createWindParticles();
        this.createDustParticles();
        this.createSnowParticles();
    }
    
    createWindParticles() {
        const count = 200;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        const velocities = new Float32Array(count * 3);
        
        for (let i = 0; i < count; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 100;
            positions[i * 3 + 1] = 120 + Math.random() * 60;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
            
            velocities[i * 3] = (Math.random() - 0.5) * 10;
            velocities[i * 3 + 1] = (Math.random() - 0.5) * 2;
            velocities[i * 3 + 2] = (Math.random() - 0.5) * 10;
        }
        
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        
        const material = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.5,
            transparent: true,
            opacity: 0.3,
            blending: THREE.AdditiveBlending
        });
        
        this.windParticles = new THREE.Points(geometry, material);
        this.windVelocities = velocities;
        this.scene.add(this.windParticles);
    }
    
    createDustParticles() {
        const count = 300;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        
        for (let i = 0; i < count; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 100;
            positions[i * 3 + 1] = 5 + Math.random() * 30;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
        }
        
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        
        const material = new THREE.PointsMaterial({
            color: 0xffffcc,
            size: 0.2,
            transparent: true,
            opacity: 0.4,
            blending: THREE.AdditiveBlending
        });
        
        this.dustParticles = new THREE.Points(geometry, material);
        this.scene.add(this.dustParticles);
    }
    
    createSnowParticles() {
        const count = 500;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        
        for (let i = 0; i < count; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 1] = 130 + Math.random() * 50;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
        }
        
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        
        const material = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.4,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending
        });
        
        this.snowParticles = new THREE.Points(geometry, material);
        this.scene.add(this.snowParticles);
    }
    
    update(dt, time, playerPosition) {
        const windPos = this.windParticles.geometry.attributes.position.array;
        for (let i = 0; i < windPos.length / 3; i++) {
            windPos[i * 3] += this.windVelocities[i * 3] * dt;
            windPos[i * 3 + 1] += this.windVelocities[i * 3 + 1] * dt;
            windPos[i * 3 + 2] += this.windVelocities[i * 3 + 2] * dt;
            
            const dx = windPos[i * 3] - playerPosition.x;
            const dz = windPos[i * 3 + 2] - playerPosition.z;
            if (Math.sqrt(dx * dx + dz * dz) > 60 || windPos[i * 3 + 1] < 80) {
                windPos[i * 3] = playerPosition.x + (Math.random() - 0.5) * 50;
                windPos[i * 3 + 1] = 130 + Math.random() * 30;
                windPos[i * 3 + 2] = playerPosition.z + (Math.random() - 0.5) * 50;
            }
        }
        this.windParticles.geometry.attributes.position.needsUpdate = true;
        
        const dustPos = this.dustParticles.geometry.attributes.position.array;
        for (let i = 0; i < dustPos.length / 3; i++) {
            dustPos[i * 3] += Math.sin(time + i) * 0.01;
            dustPos[i * 3 + 1] += Math.cos(time * 0.5 + i) * 0.005;
            dustPos[i * 3 + 2] += Math.sin(time * 0.3 + i) * 0.01;
        }
        this.dustParticles.geometry.attributes.position.needsUpdate = true;
        
        const snowPos = this.snowParticles.geometry.attributes.position.array;
        for (let i = 0; i < snowPos.length / 3; i++) {
            snowPos[i * 3 + 1] -= 2 * dt;
            snowPos[i * 3] += Math.sin(time + i * 0.1) * 0.5 * dt;
            
            if (snowPos[i * 3 + 1] < 100) {
                snowPos[i * 3 + 1] = 160 + Math.random() * 20;
                snowPos[i * 3] = playerPosition.x + (Math.random() - 0.5) * 60;
                snowPos[i * 3 + 2] = playerPosition.z + (Math.random() - 0.5) * 60;
            }
        }
        this.snowParticles.geometry.attributes.position.needsUpdate = true;
        
        const height = playerPosition.y;
        const progress = height / this.terrain.mountainHeight;
        
        this.windParticles.visible = progress > 0.5;
        this.snowParticles.visible = progress > 0.7;
        this.dustParticles.visible = progress < 0.5;
    }
}
'''

with open('/mnt/agents/output/main.js', 'a') as f:
    f.write(environment_section)

print("Environment section written")

hud_game_section = '''

// ============================================================
// SECTION 7: HUD MANAGER
// ============================================================

class HUDManager {
    constructor() {
        this.staminaBar = document.getElementById('stamina-bar');
        this.elevationDisplay = document.getElementById('elevation-display');
        this.distanceDisplay = document.getElementById('distance-display');
        this.timeDisplay = document.getElementById('time-display');
        this.slopeDisplay = document.getElementById('slope-display');
        this.zoneIndicator = document.getElementById('zone-indicator');
        this.vignette = document.getElementById('vignette');
        this.breathingIndicator = document.getElementById('breathing-indicator');
        this.summitOverlay = document.getElementById('summit-overlay');
        this.summitElevation = document.getElementById('summit-elevation');
        this.summitTime = document.getElementById('summit-time');
        this.hikeAgainBtn = document.getElementById('hike-again-btn');
        
        this.startTime = Date.now();
        this.summitReached = false;
        
        this.hikeAgainBtn.addEventListener('click', () => {
            if (this.onHikeAgain) this.onHikeAgain();
        });
    }
    
    update(player, terrain) {
        const staminaPct = (player.stamina / player.maxStamina) * 100;
        this.staminaBar.style.width = staminaPct + '%';
        
        if (staminaPct < 20) {
            this.staminaBar.style.background = 'linear-gradient(90deg, #ff0000, #ff4444)';
        } else if (staminaPct < 50) {
            this.staminaBar.style.background = 'linear-gradient(90deg, #ff8800, #ffaa00)';
        } else {
            this.staminaBar.style.background = 'linear-gradient(90deg, #ff4444 0%, #ffaa00 50%, #44ff44 100%)';
        }
        
        const elevation = Math.round(player.position.y * 3.28084);
        this.elevationDisplay.textContent = elevation + ' ft';
        
        const dist = terrain.getDistanceToSummit(player.position.x, player.position.z);
        this.distanceDisplay.textContent = Math.round(dist) + ' m';
        
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        this.timeDisplay.textContent = 
            String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        
        const slopeDegrees = Math.round(player.currentSlope * (180 / Math.PI));
        this.slopeDisplay.textContent = slopeDegrees + '°';
        
        const zone = terrain.getZone(player.position.x, player.position.z);
        const zoneNames = { forest: '🌲 FOREST ZONE', alpine: '🏔️ ALPINE ZONE', summit: '⛰️ SUMMIT RIDGE' };
        this.zoneIndicator.textContent = zoneNames[zone];
        
        const exertion = 1 - (player.stamina / player.maxStamina);
        const vignetteSize = exertion * 150;
        const vignetteOpacity = exertion * 0.6;
        this.vignette.style.boxShadow = `inset 0 0 ${vignetteSize}px ${vignetteSize / 2}px rgba(139, 0, 0, ${vignetteOpacity})`;
        
        if (exertion > 0.7) {
            this.breathingIndicator.style.color = `rgba(255, 100, 100, ${0.5 + Math.sin(Date.now() * 0.003) * 0.5})`;
            this.breathingIndicator.textContent = exertion > 0.9 ? '⚠️ EXHAUSTED!' : '💨 HEAVY BREATHING';
        } else {
            this.breathingIndicator.style.color = 'rgba(255, 100, 100, 0)';
        }
    }
    
    showSummitOverlay(elevation, time) {
        this.summitOverlay.classList.add('active');
        this.summitElevation.textContent = Math.round(elevation * 3.28084) + ' ft';
        this.summitTime.textContent = time;
        this.summitReached = true;
    }
    
    hideSummitOverlay() {
        this.summitOverlay.classList.remove('active');
        this.summitReached = false;
        this.startTime = Date.now();
    }
    
    getElapsedTime() {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
}

// ============================================================
// SECTION 8: SUMMIT CINEMATIC
// ============================================================

class SummitCinematic {
    constructor(scene, camera, player, terrain) {
        this.scene = scene;
        this.camera = camera;
        this.player = player;
        this.terrain = terrain;
        
        this.active = false;
        this.phase = 'none';
        this.timer = 0;
        this.duration = 8;
        
        this.savedCameraPos = new THREE.Vector3();
        this.savedCameraQuaternion = new THREE.Quaternion();
        this.savedFov = 60;
    }
    
    start() {
        if (this.active) return;
        
        this.active = true;
        this.phase = 'panning';
        this.timer = 0;
        
        this.savedCameraPos.copy(this.camera.position);
        this.savedCameraQuaternion.copy(this.camera.quaternion);
        this.savedFov = this.camera.fov;
        
        const summitTrail = this.terrain.getTrailCenterAtHeight(this.terrain.mountainHeight * 0.95);
        this.summitPos = new THREE.Vector3(
            summitTrail.x,
            this.terrain.getHeight(summitTrail.x, summitTrail.z),
            summitTrail.z
        );
    }
    
    update(dt) {
        if (!this.active || this.phase !== 'panning') return false;
        
        this.timer += dt;
        const progress = Math.min(1, this.timer / this.duration);
        
        const angle = progress * Math.PI * 2;
        const radius = 20;
        const height = 15 + Math.sin(progress * Math.PI) * 10;
        
        const camX = this.summitPos.x + Math.cos(angle) * radius;
        const camZ = this.summitPos.z + Math.sin(angle) * radius;
        const camY = this.summitPos.y + height;
        
        this.camera.position.set(camX, camY, camZ);
        this.camera.lookAt(this.summitPos.x, this.summitPos.y + 5, this.summitPos.z);
        
        const fov = 60 + progress * 20;
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
        
        if (progress >= 1) {
            this.phase = 'complete';
            return true;
        }
        
        return false;
    }
    
    end() {
        this.active = false;
        this.phase = 'none';
        this.timer = 0;
        
        this.camera.fov = this.savedFov;
        this.camera.updateProjectionMatrix();
    }
    
    isActive() {
        return this.active;
    }
}

// ============================================================
// SECTION 9: AUDIO MANAGER
// ============================================================

class AudioManager {
    constructor() {
        this.currentZone = 'forest';
        this.windIntensity = 0;
    }
    
    update(zone, playerSpeed, playerStamina) {
        this.currentZone = zone;
        
        if (zone === 'summit') {
            this.windIntensity = 0.8;
        } else if (zone === 'alpine') {
            this.windIntensity = 0.4;
        } else {
            this.windIntensity = 0.1;
        }
    }
}

// ============================================================
// SECTION 10: MAIN GAME CLASS
// ============================================================

class MountainHikeGame {
    constructor() {
        this.container = document.getElementById('game-container');
        this.loadingScreen = document.getElementById('loading-screen');
        this.loadingBar = document.getElementById('loading-bar');
        this.loadingText = document.getElementById('loading-text');
        
        this.initRenderer();
        this.initScene();
        
        this.gameState = 'loading';
        this.time = 0;
        this.clock = new THREE.Clock();
        
        this.updateLoading(10, 'Generating terrain...');
        this.terrain = new TerrainGenerator(42);
        
        this.updateLoading(30, 'Building terrain mesh...');
        this.terrainMesh = new TerrainMesh(this.scene, this.terrain);
        
        this.updateLoading(50, 'Spawning player...');
        this.player = new Player(this.scene, this.terrain);
        
        this.updateLoading(60, 'Creating distant vistas...');
        this.distantMountains = new DistantMountains(this.scene);
        
        this.updateLoading(70, 'Setting up lighting...');
        this.lighting = new LightingManager(this.scene);
        
        this.updateLoading(80, 'Adding particle effects...');
        this.particles = new ParticleSystem(this.scene, this.terrain);
        
        this.updateLoading(90, 'Preparing HUD...');
        this.hud = new HUDManager();
        this.hud.onHikeAgain = () => this.resetGame();
        
        this.summitCinematic = new SummitCinematic(this.scene, this.player.camera, this.player, this.terrain);
        this.audio = new AudioManager();
        
        window.addEventListener('resize', () => this.onResize());
        
        this.updateLoading(100, 'Ready!');
        setTimeout(() => {
            this.loadingScreen.classList.add('hidden');
            this.gameState = 'playing';
        }, 500);
        
        this.animate();
    }
    
    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.container.appendChild(this.renderer.domElement);
    }
    
    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB);
    }
    
    updateLoading(percent, text) {
        this.loadingBar.style.width = percent + '%';
        this.loadingText.textContent = text;
    }
    
    onResize() {
        if (this.player) {
            this.player.camera.aspect = window.innerWidth / window.innerHeight;
            this.player.camera.updateProjectionMatrix();
        }
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    
    resetGame() {
        this.player.reset();
        this.hud.hideSummitOverlay();
        this.summitCinematic.end();
        this.gameState = 'playing';
        this.time = 0;
    }
    
    checkSummit() {
        if (this.terrain.isAtSummit(this.player.position.x, this.player.position.z)) {
            if (this.gameState !== 'summit') {
                this.gameState = 'summit';
                this.summitCinematic.start();
                
                const elevation = this.player.position.y;
                const time = this.hud.getElapsedTime();
                this.hud.showSummitOverlay(elevation, time);
            }
        }
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        const dt = Math.min(this.clock.getDelta(), 0.05);
        this.time += dt;
        
        if (this.gameState === 'loading') {
            this.renderer.render(this.scene, this.player ? this.player.camera : new THREE.PerspectiveCamera());
            return;
        }
        
        this.terrainMesh.update(this.time);
        this.distantMountains.update(this.time);
        this.lighting.updateTimeOfDay(this.time);
        this.particles.update(dt, this.time, this.player.position);
        
        if (this.gameState === 'playing') {
            this.player.update(dt);
            
            const zone = this.terrain.getZone(this.player.position.x, this.player.position.z);
            this.lighting.updateZone(zone, dt);
            
            this.hud.update(this.player, this.terrain);
            this.audio.update(zone, this.player.velocity.length(), this.player.stamina);
            
            this.checkSummit();
            
            this.renderer.render(this.scene, this.player.camera);
            
        } else if (this.gameState === 'summit') {
            this.summitCinematic.update(dt);
            this.renderer.render(this.scene, this.player.camera);
        }
    }
}

// ============================================================
// SECTION 11: GAME INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    try {
        window.game = new MountainHikeGame();
    } catch (error) {
        console.error('Failed to initialize game:', error);
        document.getElementById('loading-text').textContent = 'Error: ' + error.message;
    }
});
'''

with open('/mnt/agents/output/main.js', 'a') as f:
    f.write(hud_game_section)

# Verify the complete file
with open('/mnt/agents/output/main.js', 'r') as f:
    final_content = f.read()

print(f"Final main.js size: {len(final_content)} bytes")
print(f"Total lines: {final_content.count(chr(10))}")

# Check for syntax issues
open_braces = final_content.count('{')
close_braces = final_content.count('}')
print(f"Braces: {open_braces} open, {close_braces} close")

open_parens = final_content.count('(')
close_parens = final_content.count(')')
print(f"Parentheses: {open_parens} open, {close_parens} close")

print("\nAll sections written successfully!")
