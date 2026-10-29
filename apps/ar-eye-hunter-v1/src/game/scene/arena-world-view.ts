import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type {
    ArenaLayoutProp,
    ArenaLayoutSpec,
    Vec3Tuple
} from '../arena-contracts.ts';
import { ARENA_SCENE_THEME } from './arena-scene-theme.ts';

const MATRIX_SIGNS = [
    ['MORALE PATCH 404', 'fun deprecated, proceed anyway'],
    ['TERMS ACCEPTED', 'you clicked by existing'],
    ['PRIVACY POLICY WITNESS', 'it has seen enough'],
    ['COMPLIANCE ORB STORAGE', 'please enjoy against policy'],
    ['EXIT INTERVIEW PORTAL', 'survival is not a benefit']
] as const;

export function buildArena(scene: Scene, layout: ArenaLayoutSpec, nowMs: () => number): void {
    const materials = createArenaMaterials(scene);
    createArenaFloor(scene, layout.halfSize * 2);
    createArenaWalls(scene, layout.halfSize, materials.wallMaterial);
    createArenaLanes(scene, layout.halfSize * 2, materials);
    createArenaPillars(scene, layout.halfSize * 2, materials);
    createArenaSigns(scene, layout.halfSize, nowMs);
    createArenaLights(scene, layout.halfSize);
}

function createArenaFloor(scene: Scene, arenaSize: number): void {
    const floorMaterial = createMatrixMaterial({
        scene: scene,
        name: 'matrix-floor-mat',
        diffuseHex: ARENA_SCENE_THEME.graphite,
        emissiveHex: ARENA_SCENE_THEME.acid,
        emissiveScale: 0.11
    });
    const gridTexture = createMatrixGridTexture(scene);
    floorMaterial.diffuseTexture = gridTexture;
    floorMaterial.emissiveTexture = gridTexture;
    floorMaterial.specularColor = Color3.FromHexString(ARENA_SCENE_THEME.cyan).scale(0.24);

    const floor = MeshBuilder.CreateGround('floor', {
        width: arenaSize,
        height: arenaSize,
        subdivisions: 24
    }, scene);
    floor.material = floorMaterial;
}

interface ArenaWorldMaterials {
    readonly wallMaterial: StandardMaterial;
    readonly laneMaterial: StandardMaterial;
    readonly warningMaterial: StandardMaterial;
}
function createArenaMaterials(scene: Scene): ArenaWorldMaterials {
    const wallMaterial = createMatrixMaterial({
        scene: scene,
        name: 'matrix-black-glass-wall',
        diffuseHex: ARENA_SCENE_THEME.glass,
        emissiveHex: ARENA_SCENE_THEME.cyan,
        emissiveScale: 0.16,
        alpha: 0.92
    });
    wallMaterial.specularColor = Color3.FromHexString(ARENA_SCENE_THEME.white).scale(0.26);

    const laneMaterial = createMatrixMaterial({
        scene: scene,
        name: 'matrix-data-lane-mat',
        diffuseHex: ARENA_SCENE_THEME.acid,
        emissiveHex: ARENA_SCENE_THEME.acid,
        emissiveScale: 1.0,
        alpha: 0.88
    });
    const warningMaterial = createMatrixMaterial({
        scene: scene,
        name: 'matrix-warning-lane-mat',
        diffuseHex: ARENA_SCENE_THEME.magenta,
        emissiveHex: ARENA_SCENE_THEME.magenta,
        emissiveScale: 0.86,
        alpha: 0.86
    });

    return { wallMaterial, laneMaterial, warningMaterial };
}

function createArenaWalls(scene: Scene, halfSize: number, wallMaterial: StandardMaterial): void {
    const arenaSize = halfSize * 2;
    const walls = [
        { name: 'north-wall', position: [0, 2.6, halfSize], scaling: [arenaSize, 5.2, 0.7] },
        { name: 'south-wall', position: [0, 2.6, -halfSize], scaling: [arenaSize, 5.2, 0.7] },
        { name: 'east-wall', position: [halfSize, 2.6, 0], scaling: [0.7, 5.2, arenaSize] },
        { name: 'west-wall', position: [-halfSize, 2.6, 0], scaling: [0.7, 5.2, arenaSize] }
    ] as const;

    for (const spec of walls) {
        const wall = MeshBuilder.CreateBox(spec.name, { size: 1 }, scene);
        wall.position.set(spec.position[0], spec.position[1], spec.position[2]);
        wall.scaling.set(spec.scaling[0], spec.scaling[1], spec.scaling[2]);
        wall.material = wallMaterial;
    }
}

function createArenaLanes(scene: Scene, arenaSize: number, materials: ArenaWorldMaterials): void {
    const { laneMaterial, warningMaterial } = materials;
    const lanePositions = [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42].map((value) =>
        Math.round(value * arenaSize * 100) / 100
    );
    for (const [index, x] of lanePositions.entries()) {
        const lane = MeshBuilder.CreateBox(`matrix-longitude-${index}`, {
            width: index % 3 === 0 ? 0.09 : 0.045,
            height: 0.035,
            depth: arenaSize * 0.88
        }, scene);
        lane.position.set(x, 0.055, 0);
        lane.material = index % 3 === 0 ? warningMaterial : laneMaterial;
    }

    for (const [index, z] of lanePositions.entries()) {
        const lane = MeshBuilder.CreateBox(`matrix-latitude-${index}`, {
            width: arenaSize * 0.88,
            height: 0.035,
            depth: index % 3 === 0 ? 0.09 : 0.045
        }, scene);
        lane.position.set(0, 0.06, z);
        lane.material = index % 3 === 0 ? warningMaterial : laneMaterial;
    }
}

function createArenaPillars(scene: Scene, arenaSize: number, materials: ArenaWorldMaterials): void {
    const { wallMaterial, laneMaterial, warningMaterial } = materials;
    for (const [index, x] of [-0.32, -0.12, 0.16, 0.34].map((value) => value * arenaSize).entries()) {
        for (const z of [-0.34, -0.08, 0.22].map((value) => value * arenaSize)) {
            const pillar = MeshBuilder.CreateCylinder(`pulse-pillar-${index}-${z}`, {
                height: 4.8,
                diameterTop: 0.7,
                diameterBottom: 1.35,
                tessellation: 6
            }, scene);
            pillar.position.set(x, 2.4, z);
            pillar.rotation.y = index * 0.4;
            pillar.material = wallMaterial;

            const ring = MeshBuilder.CreateTorus(`signal-ring-${index}-${z}`, {
                diameter: 2.0,
                thickness: 0.055,
                tessellation: 24
            }, scene);
            ring.position.set(x, 4.25, z);
            ring.rotation.x = Math.PI / 2;
            ring.material = index % 2 === 0 ? laneMaterial : warningMaterial;
        }
    }
}

function createArenaSigns(scene: Scene, halfSize: number, nowMs: () => number): void {
    createArenaRainPanels(scene, halfSize, nowMs);
    for (const [index, sign] of MATRIX_SIGNS.entries()) {
        const side = index % 2 === 0 ? 1 : -1;
        const x = index < 3 ? -halfSize * 0.4 + index * halfSize * 0.4 : side * (halfSize - 1.1);
        const z = index < 3 ? side * (halfSize - 1.05) : -halfSize * 0.25 + index * halfSize * 0.1;
        const rotation = index < 3 ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        createHologramSign({
            scene: scene,
            name: `matrix-sign-${index}`,
            title: sign[0],
            detail: sign[1],
            position: [x, 3.35, z],
            rotationY: rotation,
            accent: index % 2 === 0 ? ARENA_SCENE_THEME.acid : ARENA_SCENE_THEME.cyan
        });
    }

    createPortalRings({
        scene: scene,
        name: 'matrix-portal-nw',
        position: [-halfSize * 0.72, 2.8, halfSize * 0.66],
        accent: ARENA_SCENE_THEME.cyan,
        nowMs
    });
    createPortalRings({
        scene: scene,
        name: 'matrix-portal-se',
        position: [halfSize * 0.7, 2.8, -halfSize * 0.64],
        accent: ARENA_SCENE_THEME.magenta,
        nowMs
    });
    createPortalRings({
        scene: scene,
        name: 'matrix-portal-ne',
        position: [halfSize * 0.66, 2.2, halfSize * 0.64],
        accent: ARENA_SCENE_THEME.amber,
        nowMs
    });
}

function createArenaLights(scene: Scene, halfSize: number): void {
    const hemi = new HemisphericLight('arena-hemi', new Vector3(0.1, 1, -0.2), scene);
    hemi.intensity = 1.16;
    hemi.groundColor = Color3.FromHexString(ARENA_SCENE_THEME.acid).scale(0.18);

    const magenta = new PointLight('magenta-hotspot', new Vector3(-halfSize * 0.4, 5.6, -halfSize * 0.34), scene);
    magenta.diffuse = Color3.FromHexString(ARENA_SCENE_THEME.magenta);
    magenta.intensity = 0.82;
    magenta.range = halfSize * 0.72;

    const cyan = new PointLight('cyan-hotspot', new Vector3(halfSize * 0.4, 4, halfSize * 0.3), scene);
    cyan.diffuse = Color3.FromHexString(ARENA_SCENE_THEME.cyan);
    cyan.intensity = 0.94;
    cyan.range = halfSize * 0.7;

    const acid = new PointLight('acid-hotspot', new Vector3(0, 7.2, 0), scene);
    acid.diffuse = Color3.FromHexString(ARENA_SCENE_THEME.acid);
    acid.intensity = 0.72;
    acid.range = halfSize * 0.9;
}

export function buildLayoutProps(
    scene: Scene,
    root: TransformNode,
    { layout, nowMs }: ArenaWorldLayoutInput
): void {
    for (const prop of layout.props) {
        createLayoutProp(scene, root, { prop, nowMs });
    }

    for (const sign of layout.signs) {
        createHologramSign({
            scene: scene,
            name: `layout-sign-${sign.id}`,
            title: sign.title,
            detail: sign.detail,
            position: sign.position,
            rotationY: sign.rotationY,
            accent: ARENA_SCENE_THEME.acid
        });
    }
}

function createLayoutProp(
    scene: Scene,
    root: TransformNode,
    { prop, nowMs }: ArenaWorldPropInput
): void {
    const color = prop.kind === 'hazard'
        ? ARENA_SCENE_THEME.danger
        : prop.kind === 'portal'
        ? ARENA_SCENE_THEME.magenta
        : prop.kind === 'bounce-pad'
        ? ARENA_SCENE_THEME.amber
        : ARENA_SCENE_THEME.cyan;
    const material = createMatrixMaterial({
        scene: scene,
        name: `layout-prop-${prop.id}-mat`,
        diffuseHex: prop.blocksShots ? ARENA_SCENE_THEME.glass : ARENA_SCENE_THEME.graphite,
        emissiveHex: color,
        emissiveScale: prop.kind === 'cover' ? 0.22 : 0.74,
        alpha: prop.kind === 'cover' ? 0.92 : 0.76
    });

    const mesh = MeshBuilder.CreateBox(`layout-prop-${prop.id}`, {
        width: prop.size[0],
        height: prop.size[1],
        depth: prop.size[2]
    }, scene);
    mesh.parent = root;
    mesh.position = new Vector3(...prop.position);
    mesh.rotation.y = prop.rotationY ?? 0;
    mesh.material = material;

    if (prop.kind === 'portal') {
        createPortalRings({
            scene: scene,
            name: `layout-portal-${prop.id}`,
            position: prop.position,
            accent: color,
            nowMs
        });
    }

    if (prop.label) {
        createHologramSign({
            scene: scene,
            name: `layout-prop-sign-${prop.id}`,
            title: prop.label,
            detail: 'facilities says this is intentional',
            position: [prop.position[0], prop.position[1] + prop.size[1] * 0.72 + 0.9, prop.position[2]],
            rotationY: prop.rotationY ?? 0,
            accent: color
        });
    }
}

interface CreateMatrixMaterialInput {
    readonly scene: Scene;
    readonly name: string;
    readonly diffuseHex: string;
    readonly emissiveHex: string;
    readonly emissiveScale: number;
    readonly alpha?: number;
}

export function createMatrixMaterial(
    { scene, name, diffuseHex, emissiveHex, emissiveScale, alpha = 1 }: CreateMatrixMaterialInput
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.FromHexString(diffuseHex);
    material.emissiveColor = Color3.FromHexString(emissiveHex).scale(emissiveScale);
    material.specularColor = Color3.FromHexString(ARENA_SCENE_THEME.white).scale(0.14);
    material.alpha = alpha;
    material.backFaceCulling = alpha >= 1;
    return material;
}

function createMatrixGridTexture(scene: Scene): DynamicTexture {
    const texture = new DynamicTexture('matrix-floor-grid', { width: 1024, height: 1024 }, scene);
    const ctx = texture.getContext();
    ctx.fillStyle = ARENA_SCENE_THEME.void;
    ctx.fillRect(0, 0, 1024, 1024);

    ctx.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let column = 0; column < 1024; column += 42) {
        for (let row = 0; row < 1024; row += 34) {
            const char = (column * 17 + row * 7) % 9;
            ctx.globalAlpha = 0.08 + ((column + row) % 5) * 0.025;
            ctx.fillStyle = (column + row) % 4 === 0 ? ARENA_SCENE_THEME.cyan : ARENA_SCENE_THEME.acid;
            ctx.fillText(String(char), column + 8, row + 24);
        }
    }

    for (let i = 0; i <= 1024; i += 64) {
        ctx.strokeStyle = i % 256 === 0 ? ARENA_SCENE_THEME.cyan : ARENA_SCENE_THEME.acid;
        ctx.globalAlpha = i % 256 === 0 ? 0.82 : 0.34;
        ctx.lineWidth = i % 256 === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 1024);
        ctx.moveTo(0, i);
        ctx.lineTo(1024, i);
        ctx.stroke();
    }

    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = ARENA_SCENE_THEME.magenta;
    ctx.lineWidth = 2;
    for (let i = 128; i < 1024; i += 256) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(1024, 1024 - i);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    texture.update();
    return texture;
}

interface CreateCodeRainPanelInput {
    readonly scene: Scene;
    readonly name: string;
    readonly position: Vec3Tuple;
    readonly rotationY: number;
    readonly width: number;
    readonly height: number;
    readonly seed: number;
    readonly nowMs: () => number;
}

function createCodeRainPanel(
    { scene, name, position, rotationY, width, height, seed, nowMs }: CreateCodeRainPanelInput
): void {
    const texture = new DynamicTexture(`${name}-texture`, { width: 512, height: 512 }, scene);
    texture.hasAlpha = true;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(0, 18, 13, 0.72)';
    ctx.fillRect(0, 0, 512, 512);
    ctx.font = '22px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let x = 12; x < 512; x += 28) {
        for (let y = -20; y < 532; y += 32) {
            const value = (x * 11 + y * 5 + seed * 31) % 16;
            ctx.globalAlpha = 0.18 + ((x + y + seed) % 7) * 0.075;
            ctx.fillStyle = value % 5 === 0 ? ARENA_SCENE_THEME.cyan : ARENA_SCENE_THEME.acid;
            ctx.fillText(value.toString(16).toUpperCase(), x, y + ((seed * 9 + x) % 32));
        }
    }
    ctx.globalAlpha = 0.58;
    ctx.strokeStyle = ARENA_SCENE_THEME.cyan;
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, 500, 500);
    ctx.globalAlpha = 1;
    texture.update();

    const material = new StandardMaterial(`${name}-mat`, scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.backFaceCulling = false;
    material.alpha = 0.78;

    const panel = MeshBuilder.CreatePlane(name, { width, height }, scene);
    panel.position = new Vector3(...position);
    panel.rotation.y = rotationY;
    panel.material = material;

    scene.onBeforeRenderObservable.add(() => {
        panel.position.y = position[1] + Math.sin(nowMs() / 780 + seed) * 0.08;
    });
}

interface CreateHologramSignInput {
    readonly scene: Scene;
    readonly name: string;
    readonly title: string;
    readonly detail: string;
    readonly position: Vec3Tuple;
    readonly rotationY: number;
    readonly accent: string;
}

function createHologramSign(
    { scene, name, title, detail, position, rotationY, accent }: CreateHologramSignInput
): void {
    const texture = new DynamicTexture(`${name}-texture`, { width: 768, height: 256 }, scene);
    texture.hasAlpha = true;
    drawMatrixPanel({ texture: texture, title: title, detail: detail, accent: accent });

    const material = new StandardMaterial(`${name}-mat`, scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.backFaceCulling = false;
    material.alpha = 0.9;

    const sign = MeshBuilder.CreatePlane(name, { width: 5.8, height: 1.45 }, scene);
    sign.position = new Vector3(...position);
    sign.rotation.y = rotationY;
    sign.material = material;
}

interface CreatePortalRingsInput {
    readonly scene: Scene;
    readonly name: string;
    readonly position: Vec3Tuple;
    readonly accent: string;
    readonly nowMs: () => number;
}

function createPortalRings({ scene, name, position, accent, nowMs }: CreatePortalRingsInput): void {
    const root = new TransformNode(name, scene);
    root.position = new Vector3(...position);

    const primary = createMatrixMaterial({
        scene: scene,
        name: `${name}-primary`,
        diffuseHex: accent,
        emissiveHex: accent,
        emissiveScale: 1,
        alpha: 0.84
    });
    const secondary = createMatrixMaterial({
        scene: scene,
        name: `${name}-secondary`,
        diffuseHex: ARENA_SCENE_THEME.acid,
        emissiveHex: ARENA_SCENE_THEME.acid,
        emissiveScale: 0.84,
        alpha: 0.64
    });

    for (let i = 0; i < 3; i += 1) {
        const ring = MeshBuilder.CreateTorus(`${name}-ring-${i}`, {
            diameter: 2.6 + i * 0.66,
            thickness: 0.035 + i * 0.012,
            tessellation: 48
        }, scene);
        ring.parent = root;
        ring.rotation.x = Math.PI / 2 + i * 0.4;
        ring.rotation.y = i * 0.7;
        ring.material = i === 1 ? secondary : primary;
    }

    scene.onBeforeRenderObservable.add(() => {
        root.rotation.y += 0.005;
        root.rotation.z = Math.sin(nowMs() / 900) * 0.08;
    });
}

interface DrawMatrixPanelInput {
    readonly texture: DynamicTexture;
    readonly title: string;
    readonly detail: string;
    readonly accent: string;
}

export function drawMatrixPanel({ texture, title, detail, accent }: DrawMatrixPanelInput): void {
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 768, 256);
    ctx.fillStyle = 'rgba(1, 8, 8, 0.86)';
    ctx.fillRect(0, 0, 768, 256);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 7;
    ctx.strokeRect(12, 12, 744, 232);
    ctx.fillStyle = accent;
    ctx.font = '700 42px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(title.slice(0, 24), 38, 94);
    ctx.fillStyle = ARENA_SCENE_THEME.white;
    ctx.font = '500 30px system-ui, sans-serif';
    ctx.fillText(detail.slice(0, 42), 40, 152);
    ctx.fillStyle = 'rgba(73, 255, 134, 0.42)';
    ctx.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('AUDIT TRAIL: definitely fine', 42, 210);
    texture.update();
}

interface ArenaBillboardInput {
    readonly scene: Scene;
    readonly name: string;
    readonly textureSize: { readonly width: number; readonly height: number; };
    readonly size: { readonly width: number; readonly height: number; };
    readonly position: Vec3Tuple;
    readonly parent?: TransformNode;
}
export interface ArenaBillboard {
    readonly label: Mesh;
    readonly labelTexture: DynamicTexture;
    readonly labelMaterial: StandardMaterial;
}
export function createArenaBillboard(input: ArenaBillboardInput): ArenaBillboard {
    const labelTexture = new DynamicTexture(`${input.name}-texture`, input.textureSize, input.scene);
    labelTexture.hasAlpha = true;
    const labelMaterial = new StandardMaterial(`${input.name}-mat`, input.scene);
    labelMaterial.diffuseTexture = labelTexture;
    labelMaterial.emissiveTexture = labelTexture;
    labelMaterial.opacityTexture = labelTexture;
    labelMaterial.backFaceCulling = false;
    const label = MeshBuilder.CreatePlane(input.name, input.size, input.scene);
    label.position = new Vector3(...input.position);
    label.parent = input.parent ?? null;
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = labelMaterial;
    return { label, labelTexture, labelMaterial };
}
const MATRIX_RAIN_PANELS = [{
    name: 'matrix-rain-north-a',
    positionScale: [-0.32, 1],
    positionOffset: [0, -0.42],
    rotationY: Math.PI,
    width: 11.8,
    height: 4.2,
    seed: 1
}, {
    name: 'matrix-rain-north-b',
    positionScale: [0.32, 1],
    positionOffset: [0, -0.42],
    rotationY: Math.PI,
    width: 11.8,
    height: 4.2,
    seed: 2
}, {
    name: 'matrix-rain-south-a',
    positionScale: [-0.32, -1],
    positionOffset: [0, 0.42],
    rotationY: 0,
    width: 11.8,
    height: 4.2,
    seed: 3
}, {
    name: 'matrix-rain-south-b',
    positionScale: [0.32, -1],
    positionOffset: [0, 0.42],
    rotationY: 0,
    width: 11.8,
    height: 4.2,
    seed: 4
}, {
    name: 'matrix-rain-east',
    positionScale: [1, 0],
    positionOffset: [-0.42, 0],
    rotationY: -Math.PI / 2,
    width: 15.5,
    height: 4.4,
    seed: 5
}, {
    name: 'matrix-rain-west',
    positionScale: [-1, 0],
    positionOffset: [0.42, 0],
    rotationY: Math.PI / 2,
    width: 15.5,
    height: 4.4,
    seed: 6
}] as const;
function createArenaRainPanels(scene: Scene, halfSize: number, nowMs: () => number): void {
    for (const panel of MATRIX_RAIN_PANELS) {
        createCodeRainPanel({
            scene,
            name: panel.name,
            position: [
                halfSize * panel.positionScale[0] + panel.positionOffset[0],
                2.85,
                halfSize * panel.positionScale[1] + panel.positionOffset[1]
            ],
            rotationY: panel.rotationY,
            width: panel.width,
            height: panel.height,
            seed: panel.seed,
            nowMs
        });
    }
}

interface ArenaWorldLayoutInput {
    readonly layout: ArenaLayoutSpec;
    readonly nowMs: () => number;
}

interface ArenaWorldPropInput {
    readonly prop: ArenaLayoutProp;
    readonly nowMs: () => number;
}
