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

    const matStone   = mat(scene, 'ext-stone',   '#8f9b91', 0.012, 0.02, 0.92);
    const matWhite   = mat(scene, 'ext-white',   '#f2ead4', 0.05,  0,    0.90);
    const matDkWood  = mat(scene, 'ext-dkwood',  '#745039', 0.020, 0,    0.62);
    const matDkRoof  = mat(scene, 'ext-dkroof',  '#5a7280', 0.014, 0,    0.80);
    const matRed     = mat(scene, 'ext-red',     '#b8402f', 0.075, 0,    0.44);
    const matGold    = mat(scene, 'ext-gold',    '#e3b44b', 0.20,  0.8,  0.24);
    const matGrass   = mat(scene, 'ext-grass',   '#6fa867', 0.020, 0,    0.92);
    const matPlaza   = mat(scene, 'ext-plaza',   '#b9b8a9', 0.012, 0.04, 0.92);
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

    const matHitatare = mat(scene, 'wiz-hitatare', '#131826', 0.0,   0,    0.72);
    const matHakama   = mat(scene, 'wiz-hakama',   '#0d0f18', 0.0,   0,    0.82);
    const matDo       = mat(scene, 'wiz-do',       '#180c07', 0.018, 0.14, 0.50);
    const matDoTrim   = mat(scene, 'wiz-dotrim',   '#c8901a', 0.28,  0.82, 0.22);
    const matInner    = mat(scene, 'wiz-inner',    '#5c0e13', 0.04,  0,    0.68);
    const matSkin     = mat(scene, 'wiz-skin',     '#cdb092', 0.06,  0,    0.82);
    const matHair     = mat(scene, 'wiz-hair',     '#e2ddd8', 0.06,  0.06, 0.64);
    const matEboshi   = mat(scene, 'wiz-eboshi',   '#0b0d1a', 0.0,   0,    0.80);
    const matStaff    = mat(scene, 'wiz-staff',    '#d8c898', 0.04,  0,    0.54);
    const matShide    = mat(scene, 'wiz-shide',    '#f0ece4', 0.06,  0,    0.94);
    const matOfuda    = mat(scene, 'wiz-ofuda',    '#ff8c14', 0.90,  0,    0.46);
    const matEye      = mat(scene, 'wiz-eye',      '#ffaa18', 0.88,  0,    0.36);
    const matSeal     = mat(scene, 'wiz-seal',     '#d07818', 0.72,  0,    0.52);

    const baseY = 0.22;

    // Wide hakama (flowing pleated trousers/skirt)
    add(MeshBuilder.CreateCylinder('wiz-hakama', {
        height: 1.06, diameterTop: 0.76, diameterBottom: 1.16, tessellation: 10,
    }, scene), matHakama).position.set(0, baseY + 0.53, 0);

    // Crimson inner robe lining at lower front
    add(MeshBuilder.CreateBox('wiz-lining-l', { width: 0.22, height: 0.58, depth: 0.04 }, scene), matInner)
        .position.set(-0.17, baseY + 0.29, -0.51);
    add(MeshBuilder.CreateBox('wiz-lining-r', { width: 0.22, height: 0.58, depth: 0.04 }, scene), matInner)
        .position.set(0.17, baseY + 0.29, -0.51);

    // Upper hitatare robe body
    add(MeshBuilder.CreateCylinder('wiz-torso', {
        height: 0.76, diameterTop: 0.60, diameterBottom: 0.74, tessellation: 10,
    }, scene), matHitatare).position.set(0, baseY + 1.45, 0);

    // Lacquered dō chest armor
    add(MeshBuilder.CreateBox('wiz-do', { width: 0.54, height: 0.44, depth: 0.20 }, scene), matDo)
        .position.set(0, baseY + 1.52, -0.04);
    add(MeshBuilder.CreateBox('wiz-do-trim-t', { width: 0.56, height: 0.038, depth: 0.06 }, scene), matDoTrim)
        .position.set(0, baseY + 1.76, -0.04);
    add(MeshBuilder.CreateBox('wiz-do-trim-b', { width: 0.56, height: 0.038, depth: 0.06 }, scene), matDoTrim)
        .position.set(0, baseY + 1.30, -0.04);

    // Shoulder pauldrons
    add(MeshBuilder.CreateBox('wiz-shoulders', { width: 1.02, height: 0.20, depth: 0.46 }, scene), matHitatare)
        .position.set(0, baseY + 1.84, 0);

    // Wide hanging sleeves (kariginu style — broad, gently drooping)
    const slR = add(MeshBuilder.CreateBox('wiz-sleeve-r', { width: 0.36, height: 0.68, depth: 0.24 }, scene), matHitatare);
    slR.position.set(0.55, baseY + 1.40, 0.04);
    slR.rotation.z = -0.2;
    const slL = add(MeshBuilder.CreateBox('wiz-sleeve-l', { width: 0.36, height: 0.68, depth: 0.24 }, scene), matHitatare);
    slL.position.set(-0.55, baseY + 1.40, 0.04);
    slL.rotation.z = 0.2;

    // Crimson cuffs peeking from sleeve ends
    add(MeshBuilder.CreateBox('wiz-cuff-r', { width: 0.30, height: 0.09, depth: 0.20 }, scene), matInner)
        .position.set(0.61, baseY + 1.04, 0.04);
    add(MeshBuilder.CreateBox('wiz-cuff-l', { width: 0.30, height: 0.09, depth: 0.20 }, scene), matInner)
        .position.set(-0.61, baseY + 1.04, 0.04);

    // Right forearm + hand (raised, holding staff)
    add(MeshBuilder.CreateCylinder('wiz-arm-r', { height: 0.44, diameter: 0.12, tessellation: 7 }, scene), matSkin)
        .position.set(0.53, baseY + 0.86, -0.18);
    add(MeshBuilder.CreateSphere('wiz-hand-r', { diameter: 0.15, segments: 7 }, scene), matSkin)
        .position.set(0.53, baseY + 0.64, -0.22);

    // Left forearm + hand (slightly forward, elegant gesture)
    add(MeshBuilder.CreateCylinder('wiz-arm-l', { height: 0.42, diameter: 0.12, tessellation: 7 }, scene), matSkin)
        .position.set(-0.50, baseY + 1.10, -0.12);
    add(MeshBuilder.CreateSphere('wiz-hand-l', { diameter: 0.15, segments: 7 }, scene), matSkin)
        .position.set(-0.50, baseY + 0.90, -0.16);

    // Neck
    add(MeshBuilder.CreateCylinder('wiz-neck', { height: 0.22, diameter: 0.21, tessellation: 7 }, scene), matSkin)
        .position.set(0, baseY + 1.99, 0);

    // Head
    add(MeshBuilder.CreateSphere('wiz-head', { diameter: 0.49, segments: 12 }, scene), matSkin)
        .position.set(0, baseY + 2.24, 0);

    // Amber glowing eyes (face -Z toward camera)
    for (const [ex, id] of [[-0.10, 'l'], [0.10, 'r']] as [number, string][]) {
        add(MeshBuilder.CreateSphere(`wiz-eye-${id}`, { diameter: 0.068, segments: 6 }, scene), matEye)
            .position.set(ex, baseY + 2.30, -0.21);
    }

    // Refined silver goatee
    add(MeshBuilder.CreateBox('wiz-beard', { width: 0.17, height: 0.20, depth: 0.09 }, scene), matHair)
        .position.set(0, baseY + 2.00, -0.22);

    // Long silver hair flowing down back
    add(MeshBuilder.CreateBox('wiz-hair-back', { width: 0.40, height: 0.80, depth: 0.16 }, scene), matHair)
        .position.set(0, baseY + 1.96, 0.22);
    add(MeshBuilder.CreateBox('wiz-hair-side-l', { width: 0.11, height: 0.42, depth: 0.09 }, scene), matHair)
        .position.set(-0.19, baseY + 2.06, 0.14);
    add(MeshBuilder.CreateBox('wiz-hair-side-r', { width: 0.11, height: 0.42, depth: 0.09 }, scene), matHair)
        .position.set(0.19, baseY + 2.06, 0.14);

    // Eboshi court cap — round base + tall forward-leaning cylinder
    add(MeshBuilder.CreateCylinder('wiz-eboshi-base', {
        height: 0.13, diameterTop: 0.50, diameterBottom: 0.52, tessellation: 16,
    }, scene), matEboshi).position.set(0, baseY + 2.53, 0);
    const eboshiTop = add(MeshBuilder.CreateCylinder('wiz-eboshi-top', {
        height: 0.60, diameterTop: 0.26, diameterBottom: 0.42, tessellation: 12,
    }, scene), matEboshi);
    eboshiTop.position.set(0, baseY + 2.88, 0);
    eboshiTop.rotation.x = -0.2;
    // Gold cord at cap base
    add(MeshBuilder.CreateTorus('wiz-eboshi-cord', { diameter: 0.44, thickness: 0.026, tessellation: 20 }, scene), matDoTrim)
        .position.set(0, baseY + 2.56, 0);

    // Gohei ritual staff — pale wood, slightly angled
    const staffRod = add(MeshBuilder.CreateCylinder('wiz-gohei', {
        height: 2.52, diameter: 0.046, tessellation: 7,
    }, scene), matStaff);
    staffRod.position.set(0.52, baseY + 1.26, -0.22);
    staffRod.rotation.z = 0.12;

    // Staff top for shide and ofuda placement
    const staffTopX = 0.52 + Math.sin(0.12) * 1.26;
    const staffTopY = baseY + 1.26 + Math.cos(0.12) * 1.26;

    // Shide zigzag paper strips fanning from staff top
    const shL = add(MeshBuilder.CreateBox('wiz-shide-ll', { width: 0.055, height: 0.36, depth: 0.016 }, scene), matShide);
    shL.position.set(staffTopX - 0.08, staffTopY + 0.19, -0.22);
    shL.rotation.z = -0.44;
    const shR = add(MeshBuilder.CreateBox('wiz-shide-rr', { width: 0.055, height: 0.36, depth: 0.016 }, scene), matShide);
    shR.position.set(staffTopX + 0.08, staffTopY + 0.19, -0.22);
    shR.rotation.z = 0.44;
    const sh2L = add(MeshBuilder.CreateBox('wiz-shide2-l', { width: 0.048, height: 0.26, depth: 0.016 }, scene), matShide);
    sh2L.position.set(staffTopX - 0.06, staffTopY + 0.05, -0.22);
    sh2L.rotation.z = -0.58;
    const sh2R = add(MeshBuilder.CreateBox('wiz-shide2-r', { width: 0.048, height: 0.26, depth: 0.016 }, scene), matShide);
    sh2R.position.set(staffTopX + 0.06, staffTopY + 0.05, -0.22);
    sh2R.rotation.z = 0.58;

    // Glowing amber ofuda talisman tablet at staff top
    const staffOrbPos = new Vector3(staffTopX, staffTopY + 0.46, -0.22);
    add(MeshBuilder.CreateBox('wiz-ofuda', { width: 0.16, height: 0.22, depth: 0.038 }, scene), matOfuda)
        .position.copyFrom(staffOrbPos);
    add(MeshBuilder.CreateTorus('wiz-ofuda-ring', { diameter: 0.26, thickness: 0.022, tessellation: 20 }, scene), matDoTrim)
        .position.copyFrom(staffOrbPos);

    // Floating mystical seals drifting around body
    for (const [sx, sy, sz] of [
        [-0.44, baseY + 1.70, -0.35],
        [ 0.42, baseY + 1.64, -0.33],
        [ 0.06, baseY + 2.02, -0.43],
    ] as [number, number, number][]) {
        add(MeshBuilder.CreateBox(`wiz-seal-${sx}`, { width: 0.10, height: 0.14, depth: 0.012 }, scene), matSeal)
            .position.set(sx, sy, sz);
    }

    return { meshes, orbMaterial: matOfuda, staffOrbPos };
}

export function createWizardAmbientParticles(
    scene: Scene,
    hostPos: Vector3,
    flameTexture: DynamicTexture,
): readonly ParticleSystem[] {
    const systems: ParticleSystem[] = [];

    // Slow floating motes — warm amber sacred light
    const motes = new ParticleSystem('wiz-motes', 24, scene);
    motes.particleTexture = flameTexture;
    motes.emitter = hostPos.add(new Vector3(0, 1.5, 0));
    motes.minEmitBox = new Vector3(-0.72, -0.8, -0.72);
    motes.maxEmitBox = new Vector3(0.72, 1.4, 0.72);
    motes.color1 = new Color4(1.0, 0.78, 0.24, 0.75);
    motes.color2 = new Color4(1.0, 0.58, 0.10, 0.55);
    motes.colorDead = new Color4(0.8, 0.32, 0.06, 0.0);
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

    // Sacred sparks near the ofuda talisman
    const staffTX = 0.52 + Math.sin(0.12) * 1.26;
    const staffTY = 0.22 + 1.26 + Math.cos(0.12) * 1.26 + 0.46;
    const sparks = new ParticleSystem('wiz-sparks', 14, scene);
    sparks.particleTexture = flameTexture;
    sparks.emitter = hostPos.add(new Vector3(staffTX, staffTY, -0.22));
    sparks.minEmitBox = new Vector3(-0.18, -0.18, -0.18);
    sparks.maxEmitBox = new Vector3(0.18, 0.18, 0.18);
    sparks.color1 = new Color4(1.0, 0.82, 0.28, 0.92);
    sparks.color2 = new Color4(1.0, 0.58, 0.10, 0.76);
    sparks.colorDead = new Color4(0.9, 0.32, 0.06, 0.0);
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
