import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { Scene } from '@babylonjs/core/scene.js';

export type WizardHostResult = Readonly<{
    meshes: readonly Mesh[];
    orbMaterial: PBRMaterial;
    staffOrbPos: Vector3;
}>;

function mat(
    scene: Scene,
    name: string,
    hex: string,
    emissive: number,
    metallic: number,
    roughness: number,
): PBRMaterial {
    const m = new PBRMaterial(name, scene);
    const col = Color3.FromHexString(hex);
    m.albedoColor = col;
    m.emissiveColor = col.scale(emissive);
    m.metallic = metallic;
    m.roughness = roughness;
    return m;
}

export function createCastleExteriorScene(scene: Scene): readonly Mesh[] {
    const meshes: Mesh[] = [];
    const add = (m: Mesh, material: PBRMaterial) => { m.material = material; meshes.push(m); return m; };

    const matStone   = mat(scene, 'ext-stone',   '#3a4044', 0.008, 0.02, 0.95);
    const matWhite   = mat(scene, 'ext-white',   '#e4d8c0', 0.04,  0,    0.92);
    const matDkWood  = mat(scene, 'ext-dkwood',  '#160902', 0.015, 0,    0.64);
    const matDkRoof  = mat(scene, 'ext-dkroof',  '#181008', 0.010, 0,    0.86);
    const matRed     = mat(scene, 'ext-red',     '#6e0e00', 0.065, 0,    0.44);
    const matGold    = mat(scene, 'ext-gold',    '#c08c12', 0.18,  0.8,  0.24);
    const matGrass   = mat(scene, 'ext-grass',   '#152610', 0.012, 0,    0.98);
    const matPlaza   = mat(scene, 'ext-plaza',   '#2c3032', 0.01,  0.04, 0.96);
    const matLantern = mat(scene, 'ext-lantern', '#ffaa38', 0.94,  0,    0.90);

    // Ground / courtyard
    add(MeshBuilder.CreateBox('ext-ground', { width: 68, height: 0.4, depth: 68 }, scene), matPlaza)
        .position.set(0, -0.2, 14);
    // Grass flanking
    for (const gx of [-26, 26]) {
        add(MeshBuilder.CreateBox(`ext-grass-${gx}`, { width: 22, height: 0.18, depth: 68 }, scene), matGrass)
            .position.set(gx, -0.01, 14);
    }
    // Stone path
    add(MeshBuilder.CreateBox('ext-path', { width: 6.0, height: 0.06, depth: 34 }, scene), matPlaza)
        .position.set(0, 0.02, 5);

    // ===== CASTLE KEEP (天守閣) =====
    // Massive ishigaki stone base
    add(MeshBuilder.CreateBox('ext-ishigaki', { width: 24, height: 5.0, depth: 20 }, scene), matStone)
        .position.set(0, 2.5, 28);

    // Tier 1 white walls
    add(MeshBuilder.CreateBox('ext-t1', { width: 17, height: 5.8, depth: 14 }, scene), matWhite)
        .position.set(0, 8.4, 28);
    for (const ty of [5.8, 11.1]) {
        add(MeshBuilder.CreateBox(`ext-t1-band-${ty}`, { width: 17.7, height: 0.4, depth: 14.7 }, scene), matDkWood)
            .position.set(0, ty, 28);
    }
    // Tier 1 hip roof
    add(MeshBuilder.CreateBox('ext-t1-roof', { width: 18.8, height: 1.8, depth: 16.2 }, scene), matDkRoof)
        .position.set(0, 12.4, 28);
    for (const [ez] of [[28 + 8.2], [28 - 8.2]] as [number][]) {
        add(MeshBuilder.CreateBox(`ext-t1-eave-${ez}`, { width: 19.2, height: 0.3, depth: 2.0 }, scene), matDkRoof)
            .position.set(0, 12.2, ez);
    }

    // Tier 2
    add(MeshBuilder.CreateBox('ext-t2', { width: 12, height: 4.8, depth: 10 }, scene), matWhite)
        .position.set(0, 16.0, 28);
    add(MeshBuilder.CreateBox('ext-t2-band', { width: 12.6, height: 0.35, depth: 10.6 }, scene), matDkWood)
        .position.set(0, 17.8, 28);
    add(MeshBuilder.CreateBox('ext-t2-roof', { width: 13.4, height: 1.4, depth: 11.6 }, scene), matDkRoof)
        .position.set(0, 18.7, 28);

    // Tier 3 (top)
    add(MeshBuilder.CreateBox('ext-t3', { width: 8.0, height: 3.8, depth: 6.5 }, scene), matWhite)
        .position.set(0, 21.7, 28);
    add(MeshBuilder.CreateBox('ext-t3-band', { width: 8.6, height: 0.3, depth: 7.1 }, scene), matDkWood)
        .position.set(0, 23.0, 28);
    add(MeshBuilder.CreateBox('ext-t3-roof', { width: 9.4, height: 2.2, depth: 8.2 }, scene), matDkRoof)
        .position.set(0, 24.6, 28);

    // Gold finial
    add(MeshBuilder.CreateCylinder('ext-finrod', { height: 2.0, diameter: 0.15, tessellation: 8 }, scene), matGold)
        .position.set(0, 26.1, 28);
    add(MeshBuilder.CreateSphere('ext-finball', { diameter: 0.78, segments: 10 }, scene), matGold)
        .position.set(0, 27.2, 28);

    // ===== CASTLE GATE (大手門) =====
    for (const tx of [-5.5, 5.5]) {
        add(MeshBuilder.CreateBox(`ext-gtower-${tx}`, { width: 4.4, height: 7.5, depth: 3.8 }, scene), matWhite)
            .position.set(tx, 3.75, 11);
        add(MeshBuilder.CreateBox(`ext-gtower-band-${tx}`, { width: 4.8, height: 0.36, depth: 4.2 }, scene), matDkWood)
            .position.set(tx, 7.0, 11);
        add(MeshBuilder.CreateBox(`ext-gtower-roof-${tx}`, { width: 5.2, height: 1.3, depth: 4.6 }, scene), matDkRoof)
            .position.set(tx, 8.1, 11);
    }
    // Wall above gate
    add(MeshBuilder.CreateBox('ext-gwall', { width: 11.0, height: 5.2, depth: 2.4 }, scene), matWhite)
        .position.set(0, 6.4, 11);
    add(MeshBuilder.CreateBox('ext-gwall-roof', { width: 11.8, height: 1.0, depth: 3.0 }, scene), matDkRoof)
        .position.set(0, 9.3, 11);
    // Red gate frame
    for (const gx of [-2.0, 2.0]) {
        add(MeshBuilder.CreateBox(`ext-gframe-${gx}`, { width: 0.34, height: 4.0, depth: 2.6 }, scene), matRed)
            .position.set(gx, 2.0, 11);
    }
    add(MeshBuilder.CreateBox('ext-glintel', { width: 4.4, height: 0.44, depth: 2.6 }, scene), matDkWood)
        .position.set(0, 4.3, 11);

    // Side walls connecting gate to keep
    for (const [wx, wz, ww, wd] of [
        [-9.5, 19.5, 0.6, 17], [9.5, 19.5, 0.6, 17],
        [-15, 11, 11, 0.6],    [15, 11, 11, 0.6],
    ] as [number, number, number, number][]) {
        add(MeshBuilder.CreateBox(`ext-swall-${wx}`, { width: ww, height: 5.2, depth: wd }, scene), matStone)
            .position.set(wx, 2.6, wz);
    }

    // ===== STONE LANTERNS along path =====
    for (const [lx, lz] of [
        [-3.6, -4], [3.6, -4], [-3.6, 2], [3.6, 2], [-3.6, 7.5], [3.6, 7.5],
    ] as [number, number][]) {
        const n = `ext-toro-${lx}-${lz}`;
        add(MeshBuilder.CreateBox(`${n}-slab`, { width: 0.62, height: 0.12, depth: 0.62 }, scene), matStone)
            .position.set(lx, 0.06, lz);
        add(MeshBuilder.CreateCylinder(`${n}-stem`, { height: 0.74, diameter: 0.2, tessellation: 6 }, scene), matStone)
            .position.set(lx, 0.49, lz);
        add(MeshBuilder.CreateCylinder(`${n}-mid`, { height: 0.12, diameter: 0.46, tessellation: 6 }, scene), matStone)
            .position.set(lx, 0.9, lz);
        add(MeshBuilder.CreateCylinder(`${n}-body`, { height: 0.52, diameter: 0.46, tessellation: 6 }, scene), matLantern)
            .position.set(lx, 1.18, lz);
        add(MeshBuilder.CreateCylinder(`${n}-roof`, { height: 0.22, diameterTop: 0.1, diameterBottom: 0.64, tessellation: 6 }, scene), matStone)
            .position.set(lx, 1.5, lz);
    }

    // ===== PINE TREES =====
    for (const [tx, tz] of [
        [-10, -6], [10, -6], [-12, 4], [12, 4], [-14, 14], [14, 14],
    ] as [number, number][]) {
        add(MeshBuilder.CreateCylinder(`ext-trunk-${tx}-${tz}`, { height: 2.8, diameter: 0.44, tessellation: 8 }, scene), matDkWood)
            .position.set(tx, 1.4, tz);
        for (let i = 0; i < 3; i++) {
            add(MeshBuilder.CreateCylinder(`ext-pine-${tx}-${tz}-${i}`, { height: 2.4 - i * 0.3, diameterTop: 0, diameterBottom: 4.0 - i * 0.9, tessellation: 8 }, scene), matGrass)
                .position.set(tx, 3.0 + i * 1.6, tz);
        }
    }

    // Wizard stone dais
    add(MeshBuilder.CreateBox('ext-dais', { width: 2.2, height: 0.22, depth: 2.2 }, scene), matStone)
        .position.set(0, 0.11, -1);
    add(MeshBuilder.CreateBox('ext-dais-step', { width: 1.5, height: 0.11, depth: 0.5 }, scene), matRed)
        .position.set(0, 0.055, -1.78);

    return meshes;
}

export function createWizardHost(scene: Scene): WizardHostResult {
    const meshes: Mesh[] = [];
    const add = (m: Mesh, material: PBRMaterial) => { m.material = material; meshes.push(m); return m; };

    const matRobe  = mat(scene, 'wiz-robe',  '#1a082c', 0.04,  0,    0.64);
    const matHat   = mat(scene, 'wiz-hat',   '#0c0518', 0.02,  0,    0.78);
    const matGold  = mat(scene, 'wiz-gold',  '#c89018', 0.22,  0.82, 0.24);
    const matSkin  = mat(scene, 'wiz-skin',  '#c2a07a', 0.05,  0,    0.78);
    const matBeard = mat(scene, 'wiz-beard', '#dbd6ce', 0.08,  0,    0.88);
    const matStaff = mat(scene, 'wiz-staff', '#241302', 0.025, 0,    0.64);
    const matOrb   = mat(scene, 'wiz-orb',   '#66b4ff', 0.92,  0.1,  0.38);
    const matCape  = mat(scene, 'wiz-cape',  '#26073a', 0.06,  0,    0.68);
    const matRune  = mat(scene, 'wiz-rune',  '#7c58e0', 0.78,  0,    0.86);
    const matEye   = mat(scene, 'wiz-eye',   '#181024', 0.05,  0,    0.9);

    const baseY = 0.22;

    // Cape (behind body)
    add(MeshBuilder.CreateBox('wiz-cape', { width: 1.14, height: 1.7, depth: 0.14 }, scene), matCape)
        .position.set(0, baseY + 0.85, 0.24);

    // Robe body
    add(MeshBuilder.CreateCylinder('wiz-body', { height: 1.72, diameterTop: 0.76, diameterBottom: 1.0, tessellation: 10 }, scene), matRobe)
        .position.set(0, baseY + 0.86, 0);

    // Shoulders
    add(MeshBuilder.CreateBox('wiz-shoulders', { width: 1.1, height: 0.24, depth: 0.56 }, scene), matRobe)
        .position.set(0, baseY + 1.78, 0);

    // Head
    add(MeshBuilder.CreateSphere('wiz-head', { diameter: 0.52, segments: 12 }, scene), matSkin)
        .position.set(0, baseY + 2.26, 0);

    // Eyes (face toward -Z, i.e., toward camera)
    for (const ex of [-0.11, 0.11]) {
        add(MeshBuilder.CreateSphere(`wiz-eye${ex}`, { diameter: 0.065, segments: 6 }, scene), matEye)
            .position.set(ex, baseY + 2.34, -0.23);
    }

    // Beard
    add(MeshBuilder.CreateBox('wiz-beard-main', { width: 0.36, height: 0.54, depth: 0.11 }, scene), matBeard)
        .position.set(0, baseY + 1.97, -0.22);
    add(MeshBuilder.CreateBox('wiz-beard-tip', { width: 0.18, height: 0.3, depth: 0.09 }, scene), matBeard)
        .position.set(0, baseY + 1.58, -0.24);

    // Wizard hat
    add(MeshBuilder.CreateCylinder('wiz-hat-brim', { height: 0.15, diameterTop: 0.86, diameterBottom: 0.88, tessellation: 16 }, scene), matHat)
        .position.set(0, baseY + 2.56, 0);
    const cone = add(MeshBuilder.CreateCylinder('wiz-hat-cone', { height: 1.0, diameterTop: 0.04, diameterBottom: 0.68, tessellation: 16 }, scene), matHat);
    cone.position.set(0, baseY + 3.08, 0);
    cone.rotation.z = 0.1;

    // Gold hat band
    add(MeshBuilder.CreateTorus('wiz-hat-band', { diameter: 0.72, thickness: 0.038, tessellation: 24 }, scene), matGold)
        .position.set(0, baseY + 2.58, 0);

    // Glowing runes on robe
    for (const [rx, ry, rz] of [
        [-0.32, baseY + 1.05, -0.4],
        [0.32, baseY + 1.05, -0.4],
        [0, baseY + 1.48, -0.39],
    ] as [number, number, number][]) {
        add(MeshBuilder.CreateBox(`wiz-rune-${rx}`, { width: 0.09, height: 0.15, depth: 0.026 }, scene), matRune)
            .position.set(rx, ry, rz);
    }

    // Staff rod (angled at 0.15 rad)
    const staffRod = add(MeshBuilder.CreateCylinder('wiz-staff-rod', { height: 2.7, diameter: 0.06, tessellation: 8 }, scene), matStaff);
    staffRod.position.set(0.54, baseY + 1.35, -0.26);
    staffRod.rotation.z = 0.15;

    // Staff coil (gold)
    const coilX = 0.54 + Math.sin(0.15) * 1.35;
    const coilY = baseY + 1.35 + Math.cos(0.15) * 1.35;
    add(MeshBuilder.CreateTorus('wiz-staff-coil', { diameter: 0.2, thickness: 0.024, tessellation: 16 }, scene), matGold)
        .position.set(coilX, coilY, -0.26);

    // Staff orb — elevated above coil
    const orbX = coilX;
    const orbY = coilY + 0.22;
    const staffOrbPos = new Vector3(orbX, orbY, -0.26);
    add(MeshBuilder.CreateSphere('wiz-orb', { diameter: 0.32, segments: 12 }, scene), matOrb)
        .position.copyFrom(staffOrbPos);

    const orbRing = add(MeshBuilder.CreateTorus('wiz-orb-ring', { diameter: 0.46, thickness: 0.026, tessellation: 24 }, scene), matOrb);
    orbRing.position.copyFrom(staffOrbPos);
    orbRing.rotation.x = Math.PI / 3;

    return { meshes, orbMaterial: matOrb, staffOrbPos };
}

export function createWizardAmbientParticles(
    scene: Scene,
    hostPos: Vector3,
    flameTexture: DynamicTexture,
): readonly ParticleSystem[] {
    const systems: ParticleSystem[] = [];

    // Slow floating motes around the wizard
    const motes = new ParticleSystem('wiz-motes', 24, scene);
    motes.particleTexture = flameTexture;
    motes.emitter = hostPos.add(new Vector3(0, 1.5, 0));
    motes.minEmitBox = new Vector3(-0.72, -0.8, -0.72);
    motes.maxEmitBox = new Vector3(0.72, 1.4, 0.72);
    motes.color1 = new Color4(0.72, 0.42, 1.0, 0.80);
    motes.color2 = new Color4(0.52, 0.72, 1.0, 0.60);
    motes.colorDead = new Color4(0.3, 0.12, 0.8, 0.0);
    motes.minSize = 0.06;
    motes.maxSize = 0.14;
    motes.minLifeTime = 2.8;
    motes.maxLifeTime = 4.5;
    motes.emitRate = 5;
    motes.direction1 = new Vector3(-0.07, 0.12, -0.07);
    motes.direction2 = new Vector3(0.07, 0.32, 0.07);
    motes.minEmitPower = 0.02;
    motes.maxEmitPower = 0.07;
    motes.updateSpeed = 0.01;
    motes.gravity = new Vector3(0, -0.015, 0);
    motes.blendMode = ParticleSystem.BLENDMODE_ADD;
    motes.start();
    systems.push(motes);

    // Sparks orbiting the staff orb
    const sparks = new ParticleSystem('wiz-sparks', 14, scene);
    sparks.particleTexture = flameTexture;
    sparks.emitter = hostPos.add(new Vector3(0.54 + Math.sin(0.15) * 1.35, 1.35 + Math.cos(0.15) * 1.35 + 0.22 + 0.22, -0.26));
    sparks.minEmitBox = new Vector3(-0.2, -0.2, -0.2);
    sparks.maxEmitBox = new Vector3(0.2, 0.2, 0.2);
    sparks.color1 = new Color4(0.6, 0.86, 1.0, 0.92);
    sparks.color2 = new Color4(0.9, 0.72, 1.0, 0.78);
    sparks.colorDead = new Color4(0.22, 0.42, 0.9, 0.0);
    sparks.minSize = 0.04;
    sparks.maxSize = 0.11;
    sparks.minLifeTime = 0.5;
    sparks.maxLifeTime = 1.3;
    sparks.emitRate = 12;
    sparks.direction1 = new Vector3(-0.35, -0.3, -0.35);
    sparks.direction2 = new Vector3(0.35, 0.55, 0.35);
    sparks.minEmitPower = 0.08;
    sparks.maxEmitPower = 0.22;
    sparks.updateSpeed = 0.02;
    sparks.gravity = new Vector3(0, -0.04, 0);
    sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
    sparks.start();
    systems.push(sparks);

    return systems;
}
