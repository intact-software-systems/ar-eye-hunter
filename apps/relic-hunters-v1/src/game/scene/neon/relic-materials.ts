import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { type RelicRoom } from '@relic-hunters/mod.ts';

import { RELIC_NEON_THEME, relicNeonAccentForRoom } from '../neonTheme.ts';

interface CreateTextMaterialInput {
    title: string;
    detail: string;
    accent: string;
}

interface PbrMaterialInput {
    readonly scene: Scene;
    readonly name: string;
    readonly albedo: string;
    readonly emissive: string;
    readonly emissiveScale: number;
    readonly metallic: number;
    readonly roughness: number;
    readonly alpha: number;
}

interface EmissiveMaterialInput {
    readonly scene: Scene;
    readonly name: string;
    readonly diffuse: string;
    readonly emissive: string;
    readonly emissiveScale: number;
}

interface WriteWrappedTextInput {
    readonly drawing: TextDrawingContext;
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly maxWidth: number;
    readonly lineHeight: number;
}

export interface FacilityMaterials {
    readonly floor: PBRMaterial;
    readonly floorPanel: PBRMaterial;
    readonly wall: PBRMaterial;
    readonly glass: PBRMaterial;
    readonly corridor: PBRMaterial;
    readonly cyan: PBRMaterial;
    readonly magenta: PBRMaterial;
    readonly violet: PBRMaterial;
    readonly amber: PBRMaterial;
    readonly green: PBRMaterial;
    readonly danger: PBRMaterial;
    readonly white: PBRMaterial;
    readonly avatarCore: PBRMaterial;
}

const FACILITY_MATERIAL_DEFINITIONS: Readonly<Record<keyof FacilityMaterials, Omit<PbrMaterialInput, 'scene'>>> = {
    floor: {
        name: 'next-floor',
        albedo: RELIC_NEON_THEME.floor,
        emissive: '#18344a',
        emissiveScale: 0.26,
        metallic: 0.34,
        roughness: 0.22,
        alpha: 1
    },
    floorPanel: {
        name: 'next-floor-panel',
        albedo: RELIC_NEON_THEME.floorPanel,
        emissive: '#20536b',
        emissiveScale: 0.36,
        metallic: 0.42,
        roughness: 0.2,
        alpha: 1
    },
    wall: {
        name: 'next-wall',
        albedo: RELIC_NEON_THEME.graphiteLift,
        emissive: '#101c2c',
        emissiveScale: 0.15,
        metallic: 0.36,
        roughness: 0.45,
        alpha: 1
    },
    glass: {
        name: 'next-hologlass',
        albedo: RELIC_NEON_THEME.glass,
        emissive: '#0e3447',
        emissiveScale: 0.52,
        metallic: 0.05,
        roughness: 0.08,
        alpha: 0.34
    },
    corridor: {
        name: 'next-corridor',
        albedo: RELIC_NEON_THEME.graphite,
        emissive: '#152d40',
        emissiveScale: 0.22,
        metallic: 0.48,
        roughness: 0.28,
        alpha: 1
    },
    cyan: {
        name: 'next-cyan',
        albedo: '#07111f',
        emissive: RELIC_NEON_THEME.cyan,
        emissiveScale: 1.55,
        metallic: 0.08,
        roughness: 0.18,
        alpha: 1
    },
    magenta: {
        name: 'next-magenta',
        albedo: '#14091a',
        emissive: RELIC_NEON_THEME.magenta,
        emissiveScale: 1.45,
        metallic: 0.08,
        roughness: 0.18,
        alpha: 1
    },
    violet: {
        name: 'next-violet',
        albedo: '#100d20',
        emissive: RELIC_NEON_THEME.violet,
        emissiveScale: 1.25,
        metallic: 0.12,
        roughness: 0.22,
        alpha: 1
    },
    amber: {
        name: 'next-amber',
        albedo: '#181305',
        emissive: RELIC_NEON_THEME.amber,
        emissiveScale: 1.25,
        metallic: 0.16,
        roughness: 0.2,
        alpha: 1
    },
    green: {
        name: 'next-green',
        albedo: '#07180f',
        emissive: RELIC_NEON_THEME.green,
        emissiveScale: 1.3,
        metallic: 0.1,
        roughness: 0.18,
        alpha: 1
    },
    danger: {
        name: 'next-danger',
        albedo: '#19070c',
        emissive: RELIC_NEON_THEME.coral,
        emissiveScale: 1.2,
        metallic: 0.08,
        roughness: 0.2,
        alpha: 1
    },
    white: {
        name: 'next-white',
        albedo: '#0d1824',
        emissive: RELIC_NEON_THEME.white,
        emissiveScale: 0.9,
        metallic: 0.08,
        roughness: 0.16,
        alpha: 1
    },
    avatarCore: {
        name: 'next-avatar-core',
        albedo: '#172434',
        emissive: '#25445c',
        emissiveScale: 0.12,
        metallic: 0.36,
        roughness: 0.38,
        alpha: 1
    }
};

export function createFacilityMaterials(scene: Scene): FacilityMaterials {
    return {
        floor: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.floor }),
        floorPanel: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.floorPanel }),
        wall: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.wall }),
        glass: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.glass }),
        corridor: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.corridor }),
        cyan: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.cyan }),
        magenta: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.magenta }),
        violet: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.violet }),
        amber: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.amber }),
        green: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.green }),
        danger: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.danger }),
        white: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.white }),
        avatarCore: createPbrMaterial({ scene, ...FACILITY_MATERIAL_DEFINITIONS.avatarCore })
    };
}

export function createTextMaterial(
    scene: Scene,
    name: string,
    options: CreateTextMaterialInput
): StandardMaterial {
    const texture = new DynamicTexture(`${name}-texture`, { width: 768, height: 256 }, scene, false);
    const drawing = texture.getContext();
    drawing.clearRect(0, 0, 768, 256);
    drawing.fillStyle = 'rgba(5, 12, 22, 0.92)';
    drawing.fillRect(0, 0, 768, 256);
    drawing.strokeStyle = options.accent;
    drawing.lineWidth = 6;
    drawing.strokeRect(8, 8, 752, 240);
    drawing.fillStyle = options.accent;
    drawing.font = '700 46px monospace';
    drawing.fillText(options.title, 34, 74);
    drawing.fillStyle = '#e6fbff';
    drawing.font = '600 34px monospace';
    writeWrappedText({ drawing: drawing, text: options.detail, x: 34, y: 132, maxWidth: 700, lineHeight: 42 });
    texture.update();
    return createLabelMaterial(scene, `${name}-material`, texture);
}

export function createLabelMaterial(scene: Scene, name: string, texture: DynamicTexture): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseTexture = texture;
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    return material;
}

function createPbrMaterial(
    { scene, name, albedo, emissive, emissiveScale, metallic, roughness, alpha }: PbrMaterialInput
): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = Color3.FromHexString(albedo);
    material.emissiveColor = Color3.FromHexString(emissive).scale(emissiveScale);
    material.metallic = metallic;
    material.roughness = roughness;
    material.alpha = alpha;
    material.backFaceCulling = alpha >= 1;
    return material;
}

export function createRoomAccentMaterial(scene: Scene, room: RelicRoom): PBRMaterial {
    const accent = relicNeonAccentForRoom(room);
    return createPbrMaterial({
        scene: scene,
        name: `next-room-accent-${room.id}`,
        albedo: accent.base,
        emissive: accent.emissive,
        emissiveScale: room.collapsed ? 0.58 : room.unstable ? 1.35 : 1.08,
        metallic: 0.08,
        roughness: 0.18,
        alpha: 1
    });
}

export function createEmissiveMaterial(
    { scene, name, diffuse, emissive, emissiveScale }: EmissiveMaterialInput
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.FromHexString(diffuse);
    material.emissiveColor = Color3.FromHexString(emissive).scale(emissiveScale);
    return material;
}

interface TextDrawingContext {
    fillText(text: string, x: number, y: number): void;
    measureText(text: string): Readonly<{ width: number; }>;
}

export function writeWrappedText({ drawing, text, x, y, maxWidth, lineHeight }: WriteWrappedTextInput): void {
    const words = text.split(/\s+/);
    let line = '';
    let lineY = y;
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (drawing.measureText(test).width > maxWidth && line) {
            drawing.fillText(line, x, lineY);
            line = word;
            lineY += lineHeight;
        }
        else {
            line = test;
        }
    }
    if (line) {
        drawing.fillText(line, x, lineY);
    }
}

export function attachNeonMesh(root: TransformNode, mesh: Mesh, material: PBRMaterial | StandardMaterial): Mesh {
    mesh.parent = root;
    mesh.material = material;
    return mesh;
}
