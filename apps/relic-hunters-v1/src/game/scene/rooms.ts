import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { Scene } from '@babylonjs/core/scene.js';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import '@babylonjs/loaders/glTF/index.js';
import type { RelicRoom } from '@relic-hunters/mod.ts';
import {
    CEILING_Y,
    DOOR_WIDTH,
    FLOOR_Y,
    ROOM_SIZE,
    WALL_HEIGHT,
    WALL_THICKNESS,
    WORLD_SCALE,
} from './constants.ts';
import { directionBetweenRooms, roomClueHotspots } from './prompts.ts';
import type { CardinalDirection, ClueHotspot } from './types.ts';

export type CastleMaterials = Readonly<{
    wall: PBRMaterial;
    ceiling: PBRMaterial;
    wood: PBRMaterial;
    trim: PBRMaterial;
    metal: PBRMaterial;
    gold: PBRMaterial;
    clothBlue: PBRMaterial;
    clothCoral: PBRMaterial;
    torch: PBRMaterial;
    crack: PBRMaterial;
    rubble: PBRMaterial;
    portal: PBRMaterial;
}>;

export type RoomRuntime = Readonly<{
    scene: Scene;
    castleMaterials: CastleMaterials;
    flickerLights: PointLight[];
}>;

export function createCastleMaterials(scene: Scene): CastleMaterials {
    return {
        wall: castleMaterial(scene, 'castle-wall-stone', '#b7c0ad', 0.025, 0, 0.92),
        ceiling: castleMaterial(scene, 'castle-ceiling-stone', '#98a99b', 0.018, 0, 0.94),
        wood: castleMaterial(scene, 'castle-oak', '#946b3c', 0.015, 0, 0.88),
        trim: castleMaterial(scene, 'castle-trim', '#d5b86f', 0.04, 0.1, 0.75),
        metal: castleMaterial(scene, 'castle-iron', '#9aa7ae', 0.018, 0.6, 0.65),
        gold: castleMaterial(scene, 'castle-gold', '#f1c453', 0.12, 0.9, 0.2),
        clothBlue: castleMaterial(scene, 'castle-blue-cloth', '#3db7d6', 0.08, 0, 0.95),
        clothCoral: castleMaterial(scene, 'castle-coral-cloth', '#f9736b', 0.07, 0, 0.95),
        torch: castleMaterial(scene, 'castle-torch-flame', '#ffbf5c', 0.72, 0, 1.0),
        crack: castleMaterial(scene, 'castle-crack-shadow', '#2f2d28', 0.005, 0, 1.0),
        rubble: castleMaterial(scene, 'castle-rubble', '#756b5d', 0.012, 0, 0.88),
        portal: castleMaterial(scene, 'castle-portal-light', '#8ee7f5', 0.32, 0.15, 0.45),
    };
}

export function applyRoomMaterial(
    material: PBRMaterial,
    room: RelicRoom,
    selected: boolean,
): void {
    const base = room.collapsed
        ? '#514a3f'
        : room.unstable
        ? '#df7a45'
        : selected
        ? '#f3c969'
        : room.kind === 'exit'
        ? '#7dd3fc'
        : room.kind === 'treasure'
        ? '#b7e66e'
        : room.kind === 'shrine'
        ? '#b9a7f4'
        : room.kind === 'monster'
        ? '#b86f7f'
        : room.kind === 'trap'
        ? '#f19a64'
        : room.kind === 'storage'
        ? '#c69b5f'
        : '#93b7aa';
    material.albedoColor = Color3.FromHexString(base);
    material.emissiveColor = room.collapsed ? new Color3(0.035, 0.028, 0.018)
        : room.unstable ? new Color3(0.2, 0.07, 0.025)
        : selected ? new Color3(0.18, 0.12, 0.035)
        : new Color3(0.035, 0.035, 0.026);
    material.metallic = 0;
    material.roughness = 0.9;
}

export function createIntroCastleScene(
    scene: Scene,
    materials: CastleMaterials,
): readonly Mesh[] {
    const meshes: Mesh[] = [];
    const add = (mesh: Mesh, material: PBRMaterial) => {
        mesh.material = material;
        meshes.push(mesh);
        return mesh;
    };

    const floor = add(MeshBuilder.CreateBox(
        'intro-great-hall-floor',
        { width: 8.4, height: 0.12, depth: 16.5 },
        scene,
    ), materials.wall);
    floor.position.set(0, FLOOR_Y, 0.5);

    const ceiling = add(MeshBuilder.CreateBox(
        'intro-great-hall-ceiling',
        { width: 8.7, height: 0.16, depth: 16.5 },
        scene,
    ), materials.ceiling);
    ceiling.position.set(0, 5.05, 0.5);

    for (const side of [-1, 1]) {
        const wall = add(MeshBuilder.CreateBox(
            `intro-great-hall-wall-${side}`,
            { width: 0.22, height: 4.9, depth: 16.5 },
            scene,
        ), materials.wall);
        wall.position.set(side * 4.28, 2.48, 0.5);

        for (let index = 0; index < 4; index += 1) {
            const window = add(MeshBuilder.CreateBox(
                `intro-stained-window-${side}-${index}`,
                { width: 0.04, height: 1.18, depth: 0.62 },
                scene,
            ), index % 2 === 0 ? materials.portal : materials.clothBlue);
            window.position.set(side * 4.14, 2.92, -4.9 + index * 3.1);
            window.rotation.y = Math.PI / 2;
        }

        for (let index = 0; index < 5; index += 1) {
            const pillar = add(MeshBuilder.CreateCylinder(
                `intro-pillar-${side}-${index}`,
                { height: 4.8, diameter: 0.42, tessellation: 10 },
                scene,
            ), materials.trim);
            pillar.position.set(side * 3.58, 2.42, -5.8 + index * 3.2);

            const banner = add(MeshBuilder.CreateBox(
                `intro-banner-${side}-${index}`,
                { width: 0.62, height: 1.36, depth: 0.045 },
                scene,
            ), index % 2 === 0 ? materials.clothCoral : materials.clothBlue);
            banner.position.set(side * 3.98, 2.72, -4.4 + index * 2.7);
            banner.rotation.y = Math.PI / 2;
        }

        const statue = add(MeshBuilder.CreateCylinder(
            `intro-guardian-statue-${side}`,
            { height: 1.5, diameterTop: 0.42, diameterBottom: 0.62, tessellation: 7 },
            scene,
        ), materials.rubble);
        statue.position.set(side * 2.82, 0.82, -3.6);
        const crown = add(MeshBuilder.CreateCylinder(
            `intro-guardian-crown-${side}`,
            { height: 0.18, diameter: 0.52, tessellation: 8 },
            scene,
        ), materials.gold);
        crown.position.set(side * 2.82, 1.66, -3.6);
    }

    const runner = add(MeshBuilder.CreateBox(
        'intro-great-hall-runner',
        { width: 1.36, height: 0.035, depth: 12.4 },
        scene,
    ), materials.clothCoral);
    runner.position.set(0, 0.12, 0.8);

    const throneBase = add(MeshBuilder.CreateBox(
        'intro-throne-dais',
        { width: 2.7, height: 0.35, depth: 1.4 },
        scene,
    ), materials.trim);
    throneBase.position.set(0, 0.25, 6.88);

    const throneBack = add(MeshBuilder.CreateBox(
        'intro-throne-back',
        { width: 1.18, height: 2.2, depth: 0.26 },
        scene,
    ), materials.gold);
    throneBack.position.set(0, 1.28, 7.24);

    const throneSeat = add(MeshBuilder.CreateBox(
        'intro-throne-seat',
        { width: 1.32, height: 0.42, depth: 0.82 },
        scene,
    ), materials.wood);
    throneSeat.position.set(0, 0.62, 6.92);

    for (let index = 0; index < 3; index += 1) {
        const ring = add(MeshBuilder.CreateTorus(
            `intro-chandelier-ring-${index}`,
            { diameter: 1.15 - index * 0.24, thickness: 0.035, tessellation: 32 },
            scene,
        ), materials.metal);
        ring.position.set(0, 3.7 - index * 0.18, -1.8 + index * 2.8);
        ring.rotation.x = Math.PI / 2;

        for (let flameIndex = 0; flameIndex < 4; flameIndex += 1) {
            const angle = (Math.PI * 2 * flameIndex) / 4;
            const flame = add(MeshBuilder.CreateSphere(
                `intro-chandelier-flame-${index}-${flameIndex}`,
                { diameter: 0.16, segments: 10 },
                scene,
            ), materials.torch);
            flame.position.set(
                Math.cos(angle) * (0.58 - index * 0.12),
                3.58 - index * 0.18,
                -1.8 + index * 2.8 + Math.sin(angle) * (0.58 - index * 0.12),
            );
        }
    }

    return meshes;
}

export function createCastleCorridor(
    runtime: RoomRuntime,
    from: RelicRoom,
    to: RelicRoom,
): readonly Mesh[] {
    const fromPosition = roomWorldPosition(from);
    const toPosition = roomWorldPosition(to);
    const delta = toPosition.subtract(fromPosition);
    const horizontal = Math.abs(delta.x) > Math.abs(delta.z);
    const center = new Vector3(
        (fromPosition.x + toPosition.x) / 2,
        0,
        (fromPosition.z + toPosition.z) / 2,
    );
    const span = (horizontal ? Math.abs(delta.x) : Math.abs(delta.z)) - ROOM_SIZE;
    if (span <= 0.18) {
        return [];
    }

    const meshes: Mesh[] = [];
    const corridorWidth = 1.18;
    const add = (mesh: Mesh, material: PBRMaterial) => {
        mesh.position.addInPlace(center);
        mesh.material = material;
        meshes.push(mesh);
        return mesh;
    };

    const floor = add(MeshBuilder.CreateBox(
        `corridor-floor-${from.id}-${to.id}`,
        {
            width: horizontal ? span + WALL_THICKNESS : corridorWidth,
            height: 0.1,
            depth: horizontal ? corridorWidth : span + WALL_THICKNESS,
        },
        runtime.scene,
    ), runtime.castleMaterials.wall);
    floor.position.y = FLOOR_Y;

    const ceiling = add(MeshBuilder.CreateBox(
        `corridor-ceiling-${from.id}-${to.id}`,
        {
            width: horizontal ? span + WALL_THICKNESS : corridorWidth,
            height: 0.1,
            depth: horizontal ? corridorWidth : span + WALL_THICKNESS,
        },
        runtime.scene,
    ), runtime.castleMaterials.ceiling);
    ceiling.position.y = CEILING_Y;

    for (const side of [-1, 1]) {
        const wall = add(MeshBuilder.CreateBox(
            `corridor-wall-${from.id}-${to.id}-${side}`,
            {
                width: horizontal ? span + WALL_THICKNESS : WALL_THICKNESS,
                height: WALL_HEIGHT,
                depth: horizontal ? WALL_THICKNESS : span + WALL_THICKNESS,
            },
            runtime.scene,
        ), runtime.castleMaterials.wall);
        wall.position.y = WALL_HEIGHT / 2;
        if (horizontal) {
            wall.position.z += side * (corridorWidth / 2 + WALL_THICKNESS / 2);
        } else {
            wall.position.x += side * (corridorWidth / 2 + WALL_THICKNESS / 2);
        }
    }

    const beamCount = Math.max(1, Math.floor(span / 1.2));
    for (let index = 0; index < beamCount; index += 1) {
        const offset = span * ((index + 1) / (beamCount + 1) - 0.5);
        const beam = add(MeshBuilder.CreateBox(
            `corridor-beam-${from.id}-${to.id}-${index}`,
            {
                width: horizontal ? 0.16 : corridorWidth + 0.28,
                height: 0.16,
                depth: horizontal ? corridorWidth + 0.28 : 0.16,
            },
            runtime.scene,
        ), runtime.castleMaterials.wood);
        beam.position.y = CEILING_Y - 0.12;
        if (horizontal) {
            beam.position.x += offset;
        } else {
            beam.position.z += offset;
        }
    }

    return meshes;
}

export function createRoomProps(
    runtime: RoomRuntime,
    room: RelicRoom,
    rooms: readonly RelicRoom[],
    root: Mesh,
): readonly Mesh[] {
    const props: Mesh[] = [];
    const materials = runtime.castleMaterials;
    const add = (mesh: Mesh, material: PBRMaterial = materials.wall) => {
        mesh.parent = root;
        mesh.metadata = { roomId: room.id };
        mesh.material = material;
        props.push(mesh);
        return mesh;
    };

    const doorDirections = roomDoorDirections(room, rooms);
    for (const direction of ['north', 'south', 'east', 'west'] as const) {
        addCastleWall(add, direction, doorDirections.has(direction), materials);
    }
    addCastleCeiling(add, materials);
    addStoneCourseDetail(add, room, materials);
    addCastleColumns(add, materials);
    addCastleCracks(add, room, materials);
    addCastleDoorLight(add, room, materials);
    addHighFantasyRoomDecor(add, room, materials);
    addRoomKindProps(runtime, add, room, materials);
    addClueHotspot(add, room, materials);
    addRubblePile(add, room, materials);

    return props;
}

export function createRoomLights(runtime: RoomRuntime, room: RelicRoom): readonly PointLight[] {
    const world = roomWorldPosition(room);
    const lights: PointLight[] = [];
    const addLight = (
        name: string,
        local: Vector3,
        color: Color3,
        intensity: number,
        range: number,
    ) => {
        const light = new PointLight(
            name,
            new Vector3(world.x + local.x, local.y, world.z + local.z),
            runtime.scene,
        );
        light.diffuse = color;
        light.specular = color.scale(0.45);
        light.intensity = intensity;
        light.range = range;
        light.metadata = {
            baseIntensity: intensity,
            flickerSeed: Math.random() * 1000,
        };
        lights.push(light);
        runtime.flickerLights.push(light);
        return light;
    };

    const torchColor = room.kind === 'monster'
        ? Color3.FromHexString('#ff6060')
        : room.kind === 'trap'
        ? Color3.FromHexString('#ff8c3a')
        : Color3.FromHexString('#ffbf5c');
    const mystery = room.kind === 'exit'
        ? Color3.FromHexString('#8ee7f5')
        : room.kind === 'shrine'
        ? Color3.FromHexString('#b9a7f4')
        : room.kind === 'treasure'
        ? Color3.FromHexString('#f1c453')
        : room.kind === 'monster'
        ? Color3.FromHexString('#ff8080')
        : room.kind === 'trap'
        ? Color3.FromHexString('#f19a64')
        : Color3.FromHexString('#ffd08a');
    const torchZ = room.kind === 'exit' ? ROOM_SIZE / 2 - 0.28 : -ROOM_SIZE / 2 + 0.28;
    const torchIntensity = room.kind === 'monster' ? 0.72 : room.kind === 'trap' ? 0.64 : 0.58;
    for (const x of [-1.35, 1.35]) {
        addLight(
            `room-torch-light-${room.id}-${x}`,
            new Vector3(x, 1.8, torchZ),
            torchColor,
            torchIntensity,
            6.4,
        );
    }

    const centerIntensity = room.kind === 'shrine' ? 0.52
        : room.kind === 'treasure' ? 0.48
        : room.kind === 'exit' ? 0.46
        : room.kind === 'hallway' ? 0.22
        : 0.34;
    addLight(
        `room-clue-light-${room.id}`,
        new Vector3(0, 1.25, 0),
        mystery,
        centerIntensity,
        5.2,
    );

    return lights;
}

export function roomWorldPosition(room: RelicRoom): Vector3 {
    return new Vector3(room.x * WORLD_SCALE, 0, room.z * WORLD_SCALE);
}

function castleMaterial(
    scene: Scene,
    name: string,
    hex: string,
    emissiveScale: number,
    metallic: number,
    roughness: number,
): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    const color = Color3.FromHexString(hex);
    material.albedoColor = color;
    material.emissiveColor = color.scale(emissiveScale);
    material.metallic = metallic;
    material.roughness = roughness;
    return material;
}

function addRoomKindProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    switch (room.kind) {
        case 'entrance':
            addEntranceProps(runtime, add, room, materials);
            break;
        case 'hallway':
            addHallwayProps(runtime, add, room, materials);
            break;
        case 'storage':
            addStorageProps(runtime, add, room, materials);
            break;
        case 'shrine':
            addShrineProps(runtime, add, room, materials);
            break;
        case 'trap':
            addTrapProps(runtime, add, room, materials);
            break;
        case 'treasure':
            addTreasureProps(runtime, add, room, materials);
            break;
        case 'monster':
            addMonsterProps(runtime, add, room, materials);
            break;
        case 'exit':
            addExitProps(runtime, add, room, materials);
            break;
    }
}

function addEntranceProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const portcullis = add(MeshBuilder.CreateBox(
        `prop-portcullis-${room.id}`,
        { width: 1.05, height: 1.08, depth: 0.08 },
        runtime.scene,
    ), materials.metal);
    portcullis.position.set(0, 1.34, -ROOM_SIZE / 2 + 0.14);
    portcullis.rotation.z = 0.035;

    for (const side of [-1, 1]) {
        const banner = add(MeshBuilder.CreateBox(
            `prop-banner-${room.id}-${side}`,
            { width: 0.32, height: 0.88, depth: 0.035 },
            runtime.scene,
        ), side < 0 ? materials.clothBlue : materials.clothCoral);
        banner.position.set(side * 1.12, 2.02, -ROOM_SIZE / 2 + 0.08);
    }
}

function addHallwayProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const runner = add(MeshBuilder.CreateBox(
        `prop-runner-${room.id}`,
        { width: 1.2, height: 0.025, depth: 4.6 },
        runtime.scene,
    ), materials.clothBlue);
    runner.position.set(0, 0.08, 0);

    for (const side of [-1, 1]) {
        const shield = add(MeshBuilder.CreateCylinder(
            `prop-shield-${room.id}-${side}`,
            { height: 0.055, diameter: 0.44, tessellation: 6 },
            runtime.scene,
        ), side < 0 ? materials.clothCoral : materials.clothBlue);
        shield.position.set(side * (ROOM_SIZE / 2 - 0.08), 1.82, 0.76);
        shield.rotation.z = Math.PI / 2;
        shield.rotation.y = Math.PI / 2;
    }
}

function addStorageProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    for (const [index, offset] of [-0.52, 0.08, 0.56].entries()) {
        const crate = add(MeshBuilder.CreateBox(
            `prop-crate-${room.id}-${index}`,
            { width: 0.74, height: 0.56, depth: 0.68 },
            runtime.scene,
        ), materials.wood);
        crate.position.set(offset * 1.9, 0.36, 1.02 - index * 0.68);
        crate.rotation.y = offset * 0.35;
    }
    for (const side of [-1, 1]) {
        const barrel = add(MeshBuilder.CreateCylinder(
            `prop-barrel-${room.id}-${side}`,
            { height: 0.74, diameter: 0.48, tessellation: 12 },
            runtime.scene,
        ), materials.wood);
        barrel.position.set(side * 1.38, 0.46, -1.02);
    }
}

function addShrineProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const altar = add(MeshBuilder.CreateCylinder(
        `prop-altar-${room.id}`,
        { height: 0.74, diameter: 1.12, tessellation: 8 },
        runtime.scene,
    ), materials.trim);
    altar.position.set(0, 0.48, 0);

    const sigil = add(MeshBuilder.CreateTorus(
        `prop-sigil-${room.id}`,
        { diameter: 1.38, thickness: 0.045, tessellation: 36 },
        runtime.scene,
    ), materials.portal);
    sigil.position.set(0, 0.92, 0);
    sigil.rotation.x = Math.PI / 2;
}

function addTrapProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    for (let index = 0; index < 4; index += 1) {
        const spike = add(MeshBuilder.CreateCylinder(
            `prop-spike-${room.id}-${index}`,
            { height: 0.74, diameterBottom: 0.24, diameterTop: 0, tessellation: 4 },
            runtime.scene,
        ), materials.metal);
        const angle = (Math.PI * 2 * index) / 4;
        spike.position.set(Math.cos(angle) * 0.88, 0.44, Math.sin(angle) * 0.88);
    }
    const warning = add(MeshBuilder.CreateBox(
        `prop-warning-${room.id}`,
        { width: 2.0, height: 0.025, depth: 2.0 },
        runtime.scene,
    ), materials.clothCoral);
    warning.position.set(0, 0.09, 0);
    warning.rotation.y = Math.PI / 4;
}

function addTreasureProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const chest = add(MeshBuilder.CreateBox(
        `prop-chest-${room.id}`,
        { width: 1.18, height: 0.56, depth: 0.72 },
        runtime.scene,
    ), materials.wood);
    chest.position.set(0, 0.4, 0.3);

    const lid = add(MeshBuilder.CreateBox(
        `prop-chest-lid-${room.id}`,
        { width: 1.22, height: 0.16, depth: 0.76 },
        runtime.scene,
    ), materials.gold);
    lid.position.set(0, 0.74, 0.28);
    lid.rotation.x = -0.24;
}

function addMonsterProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const skull = add(MeshBuilder.CreateSphere(
        `prop-skull-${room.id}`,
        { diameter: 0.86, segments: 16 },
        runtime.scene,
    ), materials.rubble);
    skull.position.set(0, 0.86, 0.54);
    skull.scaling.y = 0.76;

    for (const side of [-1, 1]) {
        const horn = add(MeshBuilder.CreateCylinder(
            `prop-horn-${room.id}-${side}`,
            { height: 0.74, diameterBottom: 0.17, diameterTop: 0.03, tessellation: 8 },
            runtime.scene,
        ), materials.metal);
        horn.position.set(side * 0.44, 1.14, 0.48);
        horn.rotation.z = side * 0.65;
    }
}

function addExitProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const gate = add(MeshBuilder.CreateTorus(
        `prop-gate-${room.id}`,
        { diameter: 1.9, thickness: 0.1, tessellation: 32 },
        runtime.scene,
    ), materials.portal);
    gate.position.set(0, 1.54, ROOM_SIZE / 2 - 0.18);
    gate.rotation.x = Math.PI / 2;

    const threshold = add(MeshBuilder.CreateBox(
        `prop-threshold-${room.id}`,
        { width: 1.72, height: 0.04, depth: 1.12 },
        runtime.scene,
    ), materials.gold);
    threshold.position.set(0, 0.1, ROOM_SIZE / 2 - 0.42);
}

function addCastleWall(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    direction: CardinalDirection,
    hasDoor: boolean,
    materials: CastleMaterials,
): void {
    const northSouth = direction === 'north' || direction === 'south';
    const sign = direction === 'north' || direction === 'west' ? -1 : 1;
    const wallPosition = sign * ROOM_SIZE / 2;
    const segmentLength = (ROOM_SIZE - DOOR_WIDTH) / 2;
    const addSegment = (size: Readonly<{ width: number; depth: number }>, x: number, z: number) => {
        const wall = add(MeshBuilder.CreateBox(
            `castle-wall-${direction}-${x}-${z}-${Date.now()}`,
            {
                width: size.width,
                height: WALL_HEIGHT,
                depth: size.depth,
            },
            materials.wall.getScene(),
        ), materials.wall);
        wall.position.set(x, WALL_HEIGHT / 2, z);
        return wall;
    };

    if (!hasDoor) {
        addSegment(
            {
                width: northSouth ? ROOM_SIZE + WALL_THICKNESS : WALL_THICKNESS,
                depth: northSouth ? WALL_THICKNESS : ROOM_SIZE + WALL_THICKNESS,
            },
            northSouth ? 0 : wallPosition,
            northSouth ? wallPosition : 0,
        );
        return;
    }

    for (const side of [-1, 1]) {
        const offset = side * (DOOR_WIDTH / 2 + segmentLength / 2);
        addSegment(
            {
                width: northSouth ? segmentLength : WALL_THICKNESS,
                depth: northSouth ? WALL_THICKNESS : segmentLength,
            },
            northSouth ? offset : wallPosition,
            northSouth ? wallPosition : offset,
        );
    }

    const lintel = add(MeshBuilder.CreateBox(
        `castle-door-lintel-${direction}-${Date.now()}`,
        {
            width: northSouth ? DOOR_WIDTH + 0.3 : WALL_THICKNESS + 0.05,
            height: 0.34,
            depth: northSouth ? WALL_THICKNESS + 0.05 : DOOR_WIDTH + 0.3,
        },
        materials.trim.getScene(),
    ), materials.trim);
    lintel.position.set(northSouth ? 0 : wallPosition, 2.42, northSouth ? wallPosition : 0);
}

function addCastleCeiling(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    materials: CastleMaterials,
): void {
    const ceiling = add(MeshBuilder.CreateBox(
        `castle-ceiling-${Date.now()}`,
        { width: ROOM_SIZE + 0.14, height: 0.12, depth: ROOM_SIZE + 0.14 },
        materials.ceiling.getScene(),
    ), materials.ceiling);
    ceiling.position.set(0, CEILING_Y, 0);

    for (const [index, offset] of [-2.1, -0.7, 0.7, 2.1].entries()) {
        const beam = add(MeshBuilder.CreateBox(
            `castle-ceiling-beam-${index}-${Date.now()}`,
            { width: ROOM_SIZE + 0.16, height: 0.15, depth: 0.16 },
            materials.wood.getScene(),
        ), materials.wood);
        beam.position.set(0, CEILING_Y - 0.14, offset);
        beam.rotation.z = index === 1 ? 0.025 : 0;
    }
}

function addHighFantasyRoomDecor(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const floorMotif = add(MeshBuilder.CreateTorus(
        `castle-floor-motif-${room.id}`,
        {
            diameter: room.kind === 'treasure' || room.kind === 'shrine' ? 2.6 : 2.05,
            thickness: 0.035,
            tessellation: 44,
        },
        materials.gold.getScene(),
    ), room.kind === 'monster' ? materials.crack : materials.gold);
    floorMotif.position.set(0, 0.13, 0);
    floorMotif.rotation.x = Math.PI / 2;

    const carpet = add(MeshBuilder.CreateBox(
        `castle-carpet-${room.id}`,
        {
            width: room.kind === 'hallway' ? 1.15 : 1.55,
            height: 0.026,
            depth: room.kind === 'hallway' ? ROOM_SIZE - 0.8 : 2.9,
        },
        materials.clothBlue.getScene(),
    ), room.kind === 'trap' || room.kind === 'monster' ? materials.clothCoral : materials.clothBlue);
    carpet.position.set(0, 0.105, 0);

    for (const side of [-1, 1]) {
        const tapestry = add(MeshBuilder.CreateBox(
            `castle-tapestry-${room.id}-${side}`,
            { width: 0.86, height: 1.55, depth: 0.04 },
            materials.clothCoral.getScene(),
        ), side < 0 ? materials.clothBlue : materials.clothCoral);
        tapestry.position.set(side * (ROOM_SIZE / 2 - 0.08), 2.38, -0.62);
        tapestry.rotation.y = Math.PI / 2;

        const bench = add(MeshBuilder.CreateBox(
            `castle-bench-${room.id}-${side}`,
            { width: 0.42, height: 0.28, depth: 1.28 },
            materials.wood.getScene(),
        ), materials.wood);
        bench.position.set(side * (ROOM_SIZE / 2 - 0.62), 0.28, 1.35);
    }

    const chandelier = add(MeshBuilder.CreateTorus(
        `castle-room-chandelier-${room.id}`,
        { diameter: 1.08, thickness: 0.035, tessellation: 28 },
        materials.metal.getScene(),
    ), materials.metal);
    chandelier.position.set(0, CEILING_Y - 0.58, 0);
    chandelier.rotation.x = Math.PI / 2;
}

function addClueHotspot(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    for (const clue of roomClueHotspots(room)) {
        addInspectableHotspot(add, room, clue, materials);
    }
}

function addInspectableHotspot(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    clue: ClueHotspot,
    materials: CastleMaterials,
): void {
    const markInspectable = (mesh: Mesh, resolvedOnly = false) => {
        mesh.metadata = {
            ...(mesh.metadata ?? {}),
            roomId: room.id,
            clueHotspotId: clue.id,
            primeAction: 'search',
            resolvedOnly,
        };
        if (resolvedOnly) {
            mesh.isPickable = false;
            mesh.visibility = 0;
        }
        return mesh;
    };

    const ring = markInspectable(add(MeshBuilder.CreateTorus(
        `clue-ring-${clue.id}`,
        {
            diameter: room.kind === 'trap' && clue.id.endsWith('-plates') ? 1.42 : 0.58,
            thickness: 0.03,
            tessellation: 34,
        },
        materials.portal.getScene(),
    ), room.kind === 'treasure' ? materials.gold : materials.portal));
    ring.position.set(clue.x, 0.18, clue.z);
    ring.rotation.x = Math.PI / 2;

    const focus = markInspectable(add(MeshBuilder.CreateSphere(
        `clue-focus-${clue.id}`,
        { diameter: room.kind === 'exit' ? 0.28 : 0.18, segments: 14 },
        materials.portal.getScene(),
    ), room.kind === 'treasure' ? materials.gold : materials.portal));
    focus.position.set(clue.x, room.kind === 'exit' ? 1.15 : 0.64, clue.z);

    const discovered = markInspectable(add(MeshBuilder.CreateTorus(
        `clue-discovered-${clue.id}`,
        { diameter: 0.42, thickness: 0.045, tessellation: 30 },
        materials.gold.getScene(),
    ), materials.gold), true);
    discovered.position.set(clue.x, 0.95, clue.z);
    discovered.rotation.x = Math.PI / 2;

    addHotspotProp(add, room, clue, materials, markInspectable);
}

function addHotspotProp(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    clue: ClueHotspot,
    materials: CastleMaterials,
    markInspectable: (mesh: Mesh, resolvedOnly?: boolean) => Mesh,
): void {
    if (clue.id.endsWith('-crates')) {
        const lockbox = markInspectable(add(MeshBuilder.CreateBox(
            `clue-lockbox-${clue.id}`,
            { width: 0.42, height: 0.22, depth: 0.32 },
            materials.metal.getScene(),
        ), materials.metal));
        lockbox.position.set(clue.x - 0.22, 0.62, clue.z + 0.16);
        lockbox.rotation.y = 0.18;

        const parchment = markInspectable(add(MeshBuilder.CreateBox(
            `clue-parchment-${clue.id}`,
            { width: 0.58, height: 0.026, depth: 0.36 },
            materials.clothCoral.getScene(),
        ), materials.clothCoral));
        parchment.position.set(clue.x + 0.18, 0.72, clue.z - 0.14);
        parchment.rotation.y = -0.28;
    }

    if (clue.id.endsWith('-wax-seal')) {
        const ledger = markInspectable(add(MeshBuilder.CreateBox(
            `clue-ledger-${clue.id}`,
            { width: 0.5, height: 0.035, depth: 0.62 },
            materials.wood.getScene(),
        ), materials.wood));
        ledger.position.set(clue.x, 0.48, clue.z);
        ledger.rotation.y = 0.22;

        const seal = markInspectable(add(MeshBuilder.CreateCylinder(
            `clue-seal-${clue.id}`,
            { height: 0.03, diameter: 0.18, tessellation: 16 },
            materials.clothCoral.getScene(),
        ), materials.clothCoral));
        seal.position.set(clue.x + 0.08, 0.54, clue.z - 0.08);
        seal.rotation.x = Math.PI / 2;
    }

    if (clue.id.endsWith('-broken-crate')) {
        for (let index = 0; index < 3; index += 1) {
            const slat = markInspectable(add(MeshBuilder.CreateBox(
                `clue-crate-slat-${clue.id}-${index}`,
                { width: 0.46, height: 0.055, depth: 0.12 },
                materials.wood.getScene(),
            ), materials.wood));
            slat.position.set(clue.x + index * 0.08, 0.28 + index * 0.08, clue.z);
            slat.rotation.y = -0.55 + index * 0.34;
            slat.rotation.z = 0.18;
        }
    }

    if (clue.id.endsWith('-altar') || clue.id.endsWith('-runes')) {
        for (let index = 0; index < 3; index += 1) {
            const rune = markInspectable(add(MeshBuilder.CreateBox(
                `clue-rune-${clue.id}-${index}`,
                { width: 0.08, height: 0.24, depth: 0.025 },
                materials.portal.getScene(),
            ), materials.portal));
            rune.position.set(clue.x - 0.22 + index * 0.22, 1.0 + index * 0.08, clue.z);
            rune.rotation.z = -0.4 + index * 0.4;
        }
    }

    if (clue.id.endsWith('-rune-wall')) {
        for (let index = 0; index < 4; index += 1) {
            const rune = markInspectable(add(MeshBuilder.CreateBox(
                `clue-wall-rune-${clue.id}-${index}`,
                { width: 0.08, height: 0.28, depth: 0.026 },
                materials.portal.getScene(),
            ), materials.portal));
            rune.position.set(clue.x + index * 0.12, 1.16 + index * 0.08, clue.z);
            rune.rotation.z = -0.48 + index * 0.26;
        }
    }

    if (clue.id.endsWith('-cracked-statue')) {
        const statue = markInspectable(add(MeshBuilder.CreateCylinder(
            `clue-cracked-statue-${clue.id}`,
            { height: 0.78, diameterTop: 0.26, diameterBottom: 0.44, tessellation: 7 },
            materials.rubble.getScene(),
        ), materials.rubble));
        statue.position.set(clue.x, 0.54, clue.z);
        const crack = markInspectable(add(MeshBuilder.CreateBox(
            `clue-statue-crack-${clue.id}`,
            { width: 0.035, height: 0.58, depth: 0.026 },
            materials.portal.getScene(),
        ), materials.portal));
        crack.position.set(clue.x + 0.04, 0.64, clue.z - 0.16);
        crack.rotation.z = 0.18;
    }

    if (clue.id.endsWith('-plates')) {
        for (let index = 0; index < 4; index += 1) {
            const plate = markInspectable(add(MeshBuilder.CreateBox(
                `clue-pressure-plate-${clue.id}-${index}`,
                { width: 0.58, height: 0.028, depth: 0.58 },
                materials.metal.getScene(),
            ), index % 2 === 0 ? materials.metal : materials.crack));
            plate.position.set(
                (index % 2 === 0 ? -0.35 : 0.35),
                0.14,
                (index < 2 ? -0.35 : 0.35),
            );
        }
    }

    if (clue.id.endsWith('-wall-scratches')) {
        for (let index = 0; index < 3; index += 1) {
            const scratch = markInspectable(add(MeshBuilder.CreateBox(
                `clue-trap-scratch-${clue.id}-${index}`,
                { width: 0.72, height: 0.018, depth: 0.035 },
                materials.crack.getScene(),
            ), materials.crack));
            scratch.position.set(-0.65 + index * 0.54, 0.17, -1.05);
            scratch.rotation.y = -0.45 + index * 0.25;
        }
    }

    if (clue.id.endsWith('-loose-tile')) {
        const tile = markInspectable(add(MeshBuilder.CreateBox(
            `clue-loose-tile-${clue.id}`,
            { width: 0.62, height: 0.035, depth: 0.62 },
            materials.trim.getScene(),
        ), materials.trim));
        tile.position.set(clue.x, 0.15, clue.z);
        tile.rotation.y = 0.18;
        tile.rotation.z = 0.04;
    }

    if (clue.id.endsWith('-mirror')) {
        const plaque = markInspectable(add(MeshBuilder.CreateBox(
            `clue-mirror-plaque-${clue.id}`,
            { width: 0.64, height: 0.5, depth: 0.045 },
            materials.metal.getScene(),
        ), materials.metal));
        plaque.position.set(clue.x, 1.18, clue.z);
        plaque.rotation.y = -0.34;
    }

    if (clue.id.endsWith('-coin-trail')) {
        for (let index = 0; index < 5; index += 1) {
            const coin = markInspectable(add(MeshBuilder.CreateCylinder(
                `clue-coin-trail-${clue.id}-${index}`,
                { height: 0.026, diameter: 0.16, tessellation: 14 },
                materials.gold.getScene(),
            ), materials.gold));
            coin.position.set(clue.x - 0.48 + index * 0.22, 0.16, clue.z + (index % 2) * 0.12);
            coin.rotation.x = Math.PI / 2;
        }
    }

    if (clue.id.endsWith('-chest')) {
        const latch = markInspectable(add(MeshBuilder.CreateBox(
            `clue-chest-latch-${clue.id}`,
            { width: 0.2, height: 0.18, depth: 0.06 },
            materials.gold.getScene(),
        ), materials.gold));
        latch.position.set(clue.x, 0.74, clue.z - 0.38);
    }

    if (clue.id.endsWith('-bone-altar')) {
        for (const side of [-1, 1]) {
            const chain = markInspectable(add(MeshBuilder.CreateTorus(
                `clue-chain-link-${clue.id}-${side}`,
                { diameter: 0.34, thickness: 0.035, tessellation: 16 },
                materials.metal.getScene(),
            ), materials.metal));
            chain.position.set(side * 0.54, 0.92, clue.z - 0.16);
            chain.rotation.x = Math.PI / 2;

            const bone = markInspectable(add(MeshBuilder.CreateCylinder(
                `clue-bone-${clue.id}-${side}`,
                { height: 0.62, diameter: 0.08, tessellation: 8 },
                materials.rubble.getScene(),
            ), materials.rubble));
            bone.position.set(side * 0.36, 0.28, clue.z + 0.5);
            bone.rotation.z = side * 0.88;
            bone.rotation.x = 0.42;
        }
    }

    if (clue.id.endsWith('-claw-marks')) {
        for (let index = 0; index < 4; index += 1) {
            const mark = markInspectable(add(MeshBuilder.CreateBox(
                `clue-claw-mark-${clue.id}-${index}`,
                { width: 0.58, height: 0.026, depth: 0.035 },
                materials.crack.getScene(),
            ), materials.crack));
            mark.position.set(clue.x, 1.15 + index * 0.12, clue.z + index * 0.035);
            mark.rotation.y = 0.65;
            mark.rotation.z = -0.28;
        }
    }

    if (clue.id.endsWith('-ash-pile')) {
        const ash = markInspectable(add(MeshBuilder.CreateCylinder(
            `clue-ash-pile-${clue.id}`,
            { height: 0.12, diameterTop: 0.68, diameterBottom: 0.86, tessellation: 12 },
            materials.rubble.getScene(),
        ), materials.rubble));
        ash.position.set(clue.x, 0.16, clue.z);
        ash.scaling.y = 0.45;
    }

    if (clue.id.endsWith('-daylight-slit')) {
        const daylight = markInspectable(add(MeshBuilder.CreateBox(
            `clue-daylight-slit-${clue.id}`,
            { width: 0.2, height: 1.15, depth: 0.035 },
            materials.portal.getScene(),
        ), materials.portal));
        daylight.position.set(clue.x, 1.82, clue.z + 0.16);
    }

    if (clue.id.endsWith('-threshold')) {
        const glyph = markInspectable(add(MeshBuilder.CreateTorus(
            `clue-threshold-glyph-${clue.id}`,
            { diameter: 0.52, thickness: 0.035, tessellation: 26 },
            materials.portal.getScene(),
        ), materials.portal));
        glyph.position.set(clue.x, 0.16, clue.z);
        glyph.rotation.x = Math.PI / 2;
    }

    if (room.kind === 'hallway' || room.kind === 'entrance') {
        const chalk = markInspectable(add(MeshBuilder.CreateBox(
            `clue-chalk-${clue.id}`,
            { width: 0.62, height: 0.022, depth: 0.08 },
            materials.portal.getScene(),
        ), materials.portal));
        chalk.position.set(clue.x, 0.16, clue.z);
        chalk.rotation.y = 0.5;
    }
}

function addStoneCourseDetail(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const courses = [0.9, 1.55, 2.2, 2.85, 3.5, 4.15];
    for (const y of courses) {
        for (const direction of ['north', 'south'] as const) {
            const seam = add(MeshBuilder.CreateBox(
                `stone-course-${room.id}-${direction}-${y}`,
                { width: ROOM_SIZE - 0.65, height: 0.018, depth: 0.018 },
                materials.crack.getScene(),
            ), materials.crack);
            seam.position.set(0, y, direction === 'north' ? -ROOM_SIZE / 2 + 0.095 : ROOM_SIZE / 2 - 0.095);
        }
        for (const direction of ['east', 'west'] as const) {
            const seam = add(MeshBuilder.CreateBox(
                `stone-course-${room.id}-${direction}-${y}`,
                { width: 0.018, height: 0.018, depth: ROOM_SIZE - 0.65 },
                materials.crack.getScene(),
            ), materials.crack);
            seam.position.set(direction === 'west' ? -ROOM_SIZE / 2 + 0.095 : ROOM_SIZE / 2 - 0.095, y, 0);
        }
    }

    for (let index = 0; index < 12; index += 1) {
        const side = index % 4;
        const offset = -ROOM_SIZE / 2 + 0.86 + (index % 3) * 1.9;
        const y = 1.18 + Math.floor(index / 4) * 0.96;
        const vertical = add(MeshBuilder.CreateBox(
            `stone-vertical-joint-${room.id}-${index}`,
            {
                width: side < 2 ? 0.018 : 0.022,
                height: 0.5,
                depth: side < 2 ? 0.022 : 0.018,
            },
            materials.crack.getScene(),
        ), materials.crack);

        if (side === 0 || side === 1) {
            vertical.position.set(offset, y, side === 0 ? -ROOM_SIZE / 2 + 0.092 : ROOM_SIZE / 2 - 0.092);
        } else {
            vertical.position.set(side === 2 ? -ROOM_SIZE / 2 + 0.092 : ROOM_SIZE / 2 - 0.092, y, offset);
        }
    }
}

function addCastleColumns(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    materials: CastleMaterials,
): void {
    for (const x of [-1, 1]) {
        for (const z of [-1, 1]) {
            const column = add(MeshBuilder.CreateCylinder(
                `castle-column-${x}-${z}-${Date.now()}`,
                { height: WALL_HEIGHT, diameter: 0.22, tessellation: 8 },
                materials.trim.getScene(),
            ), materials.trim);
            column.position.set(
                x * (ROOM_SIZE / 2 - 0.22),
                WALL_HEIGHT / 2,
                z * (ROOM_SIZE / 2 - 0.22),
            );
        }
    }
}

function addCastleCracks(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const crackCount = room.kind === 'trap' || room.kind === 'monster' || room.unstable ? 4 : 2;
    for (let index = 0; index < crackCount; index += 1) {
        const floorCrack = add(MeshBuilder.CreateBox(
            `castle-floor-crack-${room.id}-${index}`,
            { width: 0.72 - index * 0.08, height: 0.018, depth: 0.035 },
            materials.crack.getScene(),
        ), materials.crack);
        floorCrack.position.set(-0.62 + index * 0.42, 0.105, -0.48 + index * 0.22);
        floorCrack.rotation.y = index * 0.68;

        if (index < 2) {
            const ceilingCrack = add(MeshBuilder.CreateBox(
                `castle-ceiling-crack-${room.id}-${index}`,
                { width: 0.56, height: 0.02, depth: 0.035 },
                materials.crack.getScene(),
            ), materials.crack);
            ceilingCrack.position.set(0.34 - index * 0.62, CEILING_Y - 0.22, 0.34 + index * 0.28);
            ceilingCrack.rotation.y = -0.5 + index * 0.85;
        }
    }
}

function addCastleDoorLight(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const side = room.kind === 'exit' ? 1 : -1;
    for (const x of [-0.8, 0.8]) {
        const bracket = add(MeshBuilder.CreateCylinder(
            `castle-torch-bracket-${room.id}-${x}`,
            { height: 0.34, diameter: 0.045, tessellation: 8 },
            materials.wood.getScene(),
        ), materials.wood);
        bracket.position.set(x, 1.26, side * (ROOM_SIZE / 2 - 0.08));
        bracket.rotation.x = Math.PI / 2;
    }
}

function addRubblePile(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const count = room.collapsed || room.unstable ? 8 : 4;
    for (let index = 0; index < count; index += 1) {
        const stone = add(MeshBuilder.CreateBox(
            `castle-rubble-${room.id}-${index}`,
            {
                width: 0.16 + (index % 2) * 0.08,
                height: 0.1 + (index % 3) * 0.035,
                depth: 0.15 + (index % 4) * 0.035,
            },
            materials.rubble.getScene(),
        ), materials.rubble);
        const corner = index % 2 === 0 ? -1 : 1;
        stone.position.set(
            corner * (ROOM_SIZE / 2 - 0.42 - (index % 3) * 0.12),
            0.12 + (index % 3) * 0.02,
            (index < count / 2 ? -1 : 1) * (ROOM_SIZE / 2 - 0.38 - (index % 2) * 0.16),
        );
        stone.rotation.set(index * 0.2, index * 0.31, index * 0.17);
    }
}

function roomDoorDirections(room: RelicRoom, rooms: readonly RelicRoom[]): Set<CardinalDirection> {
    const directions = new Set<CardinalDirection>();
    for (const neighborId of room.neighbors) {
        const neighbor = rooms.find((candidate) => candidate.id === neighborId);
        if (neighbor) {
            directions.add(directionBetweenRooms(room, neighbor));
        }
    }

    return directions;
}

export function createFlameTexture(scene: Scene): DynamicTexture {
    const size = 32;
    const texture = new DynamicTexture('torch-flame-texture', { width: size, height: size }, scene, false);
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255, 248, 200, 1)');
    gradient.addColorStop(0.3, 'rgba(255, 165, 40, 0.9)');
    gradient.addColorStop(0.65, 'rgba(255, 60, 0, 0.5)');
    gradient.addColorStop(1, 'rgba(180, 20, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    texture.update();
    return texture;
}

export function createRoomTorchParticles(
    scene: Scene,
    room: RelicRoom,
    texture: DynamicTexture,
): readonly ParticleSystem[] {
    const world = roomWorldPosition(room);
    const side = room.kind === 'exit' ? 1 : -1;
    const particles: ParticleSystem[] = [];

    // Wall torch flames (matching addCastleDoorLight positions)
    for (const x of [-0.8, 0.8]) {
        const pos = new Vector3(world.x + x, 1.48, world.z + side * (ROOM_SIZE / 2 - 0.14));
        particles.push(spawnTorchFlame(scene, pos, texture, false));
    }

    // Chandelier flames (matching addHighFantasyRoomDecor positions)
    for (let index = 0; index < 4; index += 1) {
        const angle = (Math.PI * 2 * index) / 4;
        const pos = new Vector3(
            world.x + Math.cos(angle) * 0.52,
            CEILING_Y - 0.68,
            world.z + Math.sin(angle) * 0.52,
        );
        particles.push(spawnTorchFlame(scene, pos, texture, true));
    }

    return particles;
}

export function createRoomAtmosphereParticles(
    scene: Scene,
    room: RelicRoom,
    flameTexture: DynamicTexture,
): readonly ParticleSystem[] {
    const world = roomWorldPosition(room);
    switch (room.kind) {
        case 'shrine':  return [spawnAtmoSystem(scene, `shrine-orbs-${room.id}`,  world, new Vector3(1.0, 0.4, 1.0), new Color4(0.68, 0.28, 1.0, 0.78), new Color4(0.9, 0.6, 1.0, 0.55), new Color4(0.4, 0.1, 0.8, 0), 0.11, 0.21, 3.8, 5.8, 3,  new Vector3(-0.05, 0.28, -0.05), new Vector3(0.05, 0.55, 0.05), 0.04, 0.11, new Vector3(0, -0.018, 0), flameTexture)];
        case 'monster': return [spawnAtmoSystem(scene, `monster-wisps-${room.id}`, world, new Vector3(1.5, 0.1, 1.5), new Color4(0.55, 0.06, 0.06, 0.52), new Color4(0.3, 0.08, 0.06, 0.35), new Color4(0.06, 0.02, 0.02, 0), 0.22, 0.42, 2.8, 4.5, 3,  new Vector3(-0.04, 0.12, -0.04), new Vector3(0.04, 0.28, 0.04), 0.03, 0.08, new Vector3(0, -0.006, 0), flameTexture)];
        case 'treasure':return [spawnAtmoSystem(scene, `treasure-sparks-${room.id}`,new Vector3(world.x, world.y + 0.45, world.z + 0.3), new Vector3(0.5, 0.5, 0.4), new Color4(1.0, 0.88, 0.22, 0.92), new Color4(1.0, 0.7, 0.14, 0.72), new Color4(0.8, 0.5, 0.08, 0), 0.04, 0.09, 0.9, 2.0, 12, new Vector3(-0.12, 0.5, -0.1), new Vector3(0.12, 1.2, 0.1), 0.08, 0.24, new Vector3(0, -0.38, 0), flameTexture)];
        case 'exit':    return [spawnAtmoSystem(scene, `exit-beams-${room.id}`,    new Vector3(world.x, world.y + 0.2, world.z + ROOM_SIZE / 2 - 0.5), new Vector3(0.8, 0.2, 0.2), new Color4(0.68, 0.96, 1.0, 0.76), new Color4(0.85, 1.0, 1.0, 0.55), new Color4(0.5, 0.8, 1.0, 0), 0.06, 0.14, 1.6, 3.2, 6,  new Vector3(-0.04, 1.0, -0.04), new Vector3(0.04, 2.2, 0.04), 0.1,  0.28, new Vector3(0, -0.04, 0), flameTexture)];
        default: return [];
    }
}

function spawnAtmoSystem(
    scene: Scene,
    name: string,
    emitter: Vector3,
    box: Vector3,
    color1: Color4,
    color2: Color4,
    colorDead: Color4,
    minSize: number,
    maxSize: number,
    minLife: number,
    maxLife: number,
    emitRate: number,
    dir1: Vector3,
    dir2: Vector3,
    minPower: number,
    maxPower: number,
    gravity: Vector3,
    texture: DynamicTexture,
): ParticleSystem {
    const sys = new ParticleSystem(name, emitRate * Math.ceil(maxLife) + 4, scene);
    sys.particleTexture = texture;
    sys.emitter = emitter.clone();
    sys.minEmitBox = box.negate();
    sys.maxEmitBox = new Vector3(box.x, box.y, box.z);
    sys.color1 = color1;
    sys.color2 = color2;
    sys.colorDead = colorDead;
    sys.minSize = minSize;
    sys.maxSize = maxSize;
    sys.minLifeTime = minLife;
    sys.maxLifeTime = maxLife;
    sys.emitRate = emitRate;
    sys.direction1 = dir1;
    sys.direction2 = dir2;
    sys.minEmitPower = minPower;
    sys.maxEmitPower = maxPower;
    sys.updateSpeed = 0.012;
    sys.gravity = gravity;
    sys.blendMode = ParticleSystem.BLENDMODE_ADD;
    sys.start();
    return sys;
}

function spawnTorchFlame(
    scene: Scene,
    position: Vector3,
    texture: DynamicTexture,
    small: boolean,
): ParticleSystem {
    const system = new ParticleSystem(
        `torch-flame-${position.x.toFixed(1)}-${position.y.toFixed(1)}-${position.z.toFixed(1)}-${Date.now()}`,
        small ? 30 : 60,
        scene,
    );
    system.particleTexture = texture;
    system.emitter = position.clone();
    system.minEmitBox = new Vector3(-0.03, 0, -0.03);
    system.maxEmitBox = new Vector3(0.03, 0, 0.03);

    system.color1 = new Color4(1.0, 0.8, 0.25, 1.0);
    system.color2 = new Color4(1.0, 0.45, 0.1, 0.85);
    system.colorDead = new Color4(0.4, 0.1, 0.0, 0.0);

    system.minSize = small ? 0.04 : 0.07;
    system.maxSize = small ? 0.1 : 0.18;
    system.minLifeTime = 0.2;
    system.maxLifeTime = small ? 0.42 : 0.58;
    system.emitRate = small ? 50 : 90;

    system.direction1 = new Vector3(-0.06, 1.0, -0.06);
    system.direction2 = new Vector3(0.06, 1.0, 0.06);
    system.minEmitPower = small ? 0.18 : 0.28;
    system.maxEmitPower = small ? 0.45 : 0.75;
    system.updateSpeed = 0.025;

    system.gravity = new Vector3(0, -0.15, 0);
    system.blendMode = ParticleSystem.BLENDMODE_ADD;
    system.start();
    return system;
}

// --- GLB lobby loader ---
// Drop a GLB file at /public/models/lobby.glb and it will replace the procedural lobby.
export async function tryLoadLobbyGlb(scene: Scene): Promise<readonly Mesh[] | null> {
    try {
        const result = await SceneLoader.ImportMeshAsync('', '/models/', 'lobby.glb', scene);
        if (result.meshes.length === 0) return null;
        // Place the imported model at origin
        const root = result.meshes[0];
        root.position.set(0, FLOOR_Y, 0);
        return result.meshes as Mesh[];
    } catch {
        return null;
    }
}

// --- Japanese castle lobby scene ---

function jpMaterial(
    scene: Scene,
    name: string,
    hex: string,
    emissiveScale: number,
    metallic: number,
    roughness: number,
): PBRMaterial {
    const mat = new PBRMaterial(`jp-${name}`, scene);
    const col = Color3.FromHexString(hex);
    mat.albedoColor = col;
    mat.emissiveColor = col.scale(emissiveScale);
    mat.metallic = metallic;
    mat.roughness = roughness;
    return mat;
}

export function createJapaneseLobbyScene(scene: Scene): readonly Mesh[] {
    const meshes: Mesh[] = [];
    const add = (mesh: Mesh, mat: PBRMaterial) => {
        mesh.material = mat;
        meshes.push(mesh);
        return mesh;
    };

    const matDarkWood    = jpMaterial(scene, 'dark-wood',    '#1c0d05', 0.018, 0,    0.60);
    const matRedLacquer  = jpMaterial(scene, 'red-lacquer',  '#8b1800', 0.06,  0,    0.42);
    const matStone       = jpMaterial(scene, 'stone',        '#6b7882', 0.010, 0.02, 0.92);
    const matGold        = jpMaterial(scene, 'gold',         '#c8941a', 0.14,  0.72, 0.28);
    const matShoji       = jpMaterial(scene, 'shoji',        '#f5e8cc', 0.36,  0,    0.96);
    const matLanternRed  = jpMaterial(scene, 'lantern-red',  '#ff4010', 0.88,  0,    0.92);
    const matLanternAmb  = jpMaterial(scene, 'lantern-amb',  '#ffb030', 0.72,  0,    0.90);
    const matCrimson     = jpMaterial(scene, 'crimson',      '#8a0000', 0.05,  0,    0.82);
    const matNavy        = jpMaterial(scene, 'navy',         '#0a1a3a', 0.03,  0,    0.82);
    const matWhiteWall   = jpMaterial(scene, 'white-wall',   '#e2d4b8', 0.04,  0,    0.90);
    const matDarkCeiling = jpMaterial(scene, 'dark-ceil',    '#110803', 0.008, 0,    0.88);
    const matAltarWood   = jpMaterial(scene, 'altar-wood',   '#28160a', 0.04,  0,    0.50);

    // === FLOOR: dark polished wood ===
    add(MeshBuilder.CreateBox('jl-floor', { width: 14, height: 0.14, depth: 26 }, scene), matDarkWood)
        .position.set(0, FLOOR_Y, 0);

    // Gold tatami border
    for (const [fw, fd, fx, fz] of [
        [14, 0.36, 0, -12.8], [14, 0.36, 0, 12.8],
        [0.36, 26, -6.9, 0],  [0.36, 26, 6.9, 0],
    ] as [number, number, number, number][]) {
        add(MeshBuilder.CreateBox(`jl-tatami-border-${fx}-${fz}`, { width: fw, height: 0.05, depth: fd }, scene), matGold)
            .position.set(fx, FLOOR_Y + 0.04, fz);
    }

    // === CEILING: dark timber rafters ===
    add(MeshBuilder.CreateBox('jl-ceiling', { width: 14.4, height: 0.18, depth: 26 }, scene), matDarkCeiling)
        .position.set(0, CEILING_Y + 0.04, 0);

    // Long rafter beams (N-S)
    for (const x of [-3.4, 0, 3.4]) {
        add(MeshBuilder.CreateBox(`jl-rafter-ns-${x}`, { width: 0.28, height: 0.32, depth: 26 }, scene), matDarkWood)
            .position.set(x, CEILING_Y - 0.16, 0);
    }
    // Cross-beams (E-W every 4 units)
    for (let i = 0; i < 7; i++) {
        add(MeshBuilder.CreateBox(`jl-rafter-ew-${i}`, { width: 14.4, height: 0.24, depth: 0.22 }, scene), matDarkWood)
            .position.set(0, CEILING_Y - 0.12, -12 + i * 4);
    }

    // === SIDE WALLS ===
    for (const side of [-1, 1]) {
        // Lower white plaster
        add(MeshBuilder.CreateBox(`jl-wall-plaster-${side}`, { width: 0.22, height: 2.3, depth: 26 }, scene), matWhiteWall)
            .position.set(side * 6.95, 1.15, 0);
        // Upper dark timber
        add(MeshBuilder.CreateBox(`jl-wall-timber-${side}`, { width: 0.2, height: 2.7, depth: 26 }, scene), matDarkWood)
            .position.set(side * 6.95, 3.65, 0);
        // Red lacquer divider rail
        add(MeshBuilder.CreateBox(`jl-wall-rail-${side}`, { width: 0.24, height: 0.13, depth: 26 }, scene), matRedLacquer)
            .position.set(side * 6.95, 2.35, 0);

        // Shoji panels (backlit warm glow) – 6 pairs
        for (let i = 0; i < 6; i++) {
            const z = -10 + i * 4;
            add(MeshBuilder.CreateBox(`jl-shoji-${side}-${i}`, { width: 0.05, height: 1.9, depth: 2.8 }, scene), matShoji)
                .position.set(side * 6.92, 2.6, z);
        }

        // Vertical divider posts between shoji panels
        for (let i = 0; i <= 6; i++) {
            const z = -12 + i * 4;
            add(MeshBuilder.CreateBox(`jl-shoji-post-${side}-${i}`, { width: 0.12, height: 2.2, depth: 0.12 }, scene), matDarkWood)
                .position.set(side * 6.93, 2.5, z);
        }
    }

    // === BACK WALL with torii opening ===
    for (const [bw, bx] of [[3.5, -5.25], [3.5, 5.25]] as [number, number][]) {
        add(MeshBuilder.CreateBox(`jl-back-wall-${bx}`, { width: bw, height: 5.5, depth: 0.24 }, scene), matWhiteWall)
            .position.set(bx, 2.75, 12.88);
    }
    add(MeshBuilder.CreateBox('jl-back-wall-top', { width: 14, height: 1.8, depth: 0.22 }, scene), matWhiteWall)
        .position.set(0, 4.4, 12.88);
    add(MeshBuilder.CreateBox('jl-back-dado', { width: 14, height: 0.92, depth: 0.2 }, scene), matDarkWood)
        .position.set(0, 0.46, 12.88);

    // === FRONT ENTRANCE GATE FRAME ===
    for (const side of [-1, 1]) {
        add(MeshBuilder.CreateBox(`jl-gate-post-${side}`, { width: 0.34, height: 4.6, depth: 0.34 }, scene), matDarkWood)
            .position.set(side * 2.6, 2.3, -12.88);
    }
    add(MeshBuilder.CreateBox('jl-gate-lintel', { width: 5.6, height: 0.42, depth: 0.34 }, scene), matDarkWood)
        .position.set(0, 4.62, -12.88);
    add(MeshBuilder.CreateBox('jl-gate-brace', { width: 5.6, height: 0.16, depth: 0.28 }, scene), matRedLacquer)
        .position.set(0, 4.2, -12.86);

    // === LACQUERED PILLARS (4 pairs) ===
    for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
            const z = -6 + i * 4;
            // Column
            add(MeshBuilder.CreateCylinder(`jl-pillar-${side}-${i}`, { height: 4.9, diameter: 0.46, tessellation: 14 }, scene), matRedLacquer)
                .position.set(side * 4.2, 2.45, z);
            // Stone base pedestal
            add(MeshBuilder.CreateBox(`jl-pillar-base-${side}-${i}`, { width: 0.66, height: 0.2, depth: 0.66 }, scene), matStone)
                .position.set(side * 4.2, FLOOR_Y + 0.1, z);
            // Gold bracket cap (斗)
            add(MeshBuilder.CreateBox(`jl-pillar-cap-${side}-${i}`, { width: 0.72, height: 0.26, depth: 0.72 }, scene), matGold)
                .position.set(side * 4.2, CEILING_Y - 0.3, z);
            // Arm brace (肘木 — horizontal arm from cap)
            add(MeshBuilder.CreateBox(`jl-pillar-arm-${side}-${i}`, { width: 1.4, height: 0.14, depth: 0.34 }, scene), matDarkWood)
                .position.set(side * 4.2, CEILING_Y - 0.18, z);
        }
    }

    // === TORII GATE (大鳥居) at rear, z ≈ 11.0 ===
    const toriiZ = 11.0;
    for (const side of [-1, 1]) {
        // Main pillar
        add(MeshBuilder.CreateCylinder(`jl-torii-post-${side}`, { height: 4.8, diameter: 0.4, tessellation: 14 }, scene), matRedLacquer)
            .position.set(side * 2.6, 2.4, toriiZ);
        // Cap sphere at top
        add(MeshBuilder.CreateSphere(`jl-torii-cap-${side}`, { diameter: 0.46, segments: 10 }, scene), matRedLacquer)
            .position.set(side * 2.6, 4.86, toriiZ);
    }
    // Kasagi (top beam) — slight upward curve at ends via angled end caps
    add(MeshBuilder.CreateBox('jl-torii-kasagi', { width: 5.9, height: 0.3, depth: 0.35 }, scene), matRedLacquer)
        .position.set(0, 4.82, toriiZ);
    for (const side of [-1, 1]) {
        const endPiece = add(MeshBuilder.CreateBox(`jl-torii-kasagi-end-${side}`, { width: 0.44, height: 0.22, depth: 0.32 }, scene), matRedLacquer);
        endPiece.position.set(side * 3.17, 4.9, toriiZ);
        endPiece.rotation.z = side * 0.14;
    }
    // Nuki (second crossbeam, lower)
    add(MeshBuilder.CreateBox('jl-torii-nuki', { width: 5.4, height: 0.17, depth: 0.24 }, scene), matRedLacquer)
        .position.set(0, 3.96, toriiZ);
    // Shimagi wedge blocks (gold accent pins)
    for (const side of [-1, 1]) {
        add(MeshBuilder.CreateBox(`jl-torii-peg-${side}`, { width: 0.12, height: 0.14, depth: 0.12 }, scene), matGold)
            .position.set(side * 2.0, 4.07, toriiZ - 0.06);
    }
    // Shimenawa rope (sacred straw rope, horizontal between posts)
    add(MeshBuilder.CreateBox('jl-torii-rope', { width: 5.3, height: 0.06, depth: 0.06 }, scene), matGold)
        .position.set(0, 4.24, toriiZ - 0.14);

    // === STONE LANTERNS 灯籠 (4 pairs symmetrically placed) ===
    for (const [lx, lz] of [[-3.4, -5.5], [3.4, -5.5], [-3.4, 2.5], [3.4, 2.5]] as [number, number][]) {
        const n = `jl-toro-${lx}-${lz}`;
        add(MeshBuilder.CreateBox(`${n}-slab`, { width: 0.64, height: 0.11, depth: 0.64 }, scene), matStone)
            .position.set(lx, FLOOR_Y + 0.055, lz);
        add(MeshBuilder.CreateCylinder(`${n}-stem`, { height: 0.78, diameter: 0.2, tessellation: 6 }, scene), matStone)
            .position.set(lx, 0.45, lz);
        add(MeshBuilder.CreateCylinder(`${n}-mid`, { height: 0.11, diameter: 0.46, tessellation: 6 }, scene), matStone)
            .position.set(lx, 0.88, lz);
        // Lantern body — shoji material so it glows
        add(MeshBuilder.CreateCylinder(`${n}-body`, { height: 0.54, diameter: 0.48, tessellation: 6 }, scene), matShoji)
            .position.set(lx, 1.17, lz);
        add(MeshBuilder.CreateCylinder(`${n}-umbrella`, { height: 0.22, diameterTop: 0.1, diameterBottom: 0.64, tessellation: 6 }, scene), matStone)
            .position.set(lx, 1.52, lz);
        add(MeshBuilder.CreateSphere(`${n}-finial`, { diameter: 0.12, segments: 6 }, scene), matStone)
            .position.set(lx, 1.7, lz);
    }

    // === HANGING CHŌCHIN 提灯 (7 paper lanterns) ===
    const chochinPos: [number, number, number][] = [
        [0, 4.32, -8],
        [-3.0, 4.24, -4], [3.0, 4.24, -4],
        [0, 4.36, 0],
        [-3.0, 4.28, 4],  [3.0, 4.28, 4],
        [0, 4.32, 9],
    ];
    for (let i = 0; i < chochinPos.length; i++) {
        const [x, y, z] = chochinPos[i];
        const n = `jl-chochin-${i}`;
        // Cord
        add(MeshBuilder.CreateCylinder(`${n}-cord`, { height: 0.5, diameter: 0.018, tessellation: 4 }, scene), matDarkWood)
            .position.set(x, y + 0.25, z);
        // Lantern body (oblate sphere, alternating red/amber)
        const lanternMesh = add(
            MeshBuilder.CreateSphere(`${n}-body`, { diameter: 0.46, segments: 10 }, scene),
            i % 2 === 0 ? matLanternRed : matLanternAmb,
        );
        lanternMesh.position.set(x, y, z);
        lanternMesh.scaling.set(1, 1.38, 1);
        // Tassel (tiny inverted cone)
        add(MeshBuilder.CreateCylinder(`${n}-tassel`, { height: 0.16, diameterTop: 0.0, diameterBottom: 0.06, tessellation: 6 }, scene), matRedLacquer)
            .position.set(x, y - 0.34, z);
        // Top rim ring
        add(MeshBuilder.CreateTorus(`${n}-ring`, { diameter: 0.12, thickness: 0.025, tessellation: 10 }, scene), matDarkWood)
            .position.set(x, y + 0.24, z);
    }

    // === ALTAR PLATFORM 神壇 (at rear, behind torii) ===
    const altarZ = 12.0;
    add(MeshBuilder.CreateBox('jl-altar-step1', { width: 8, height: 0.3, depth: 2.6 }, scene), matDarkWood)
        .position.set(0, 0.15, altarZ);
    add(MeshBuilder.CreateBox('jl-altar-step2', { width: 6.4, height: 0.26, depth: 2.2 }, scene), matAltarWood)
        .position.set(0, 0.43, altarZ);
    add(MeshBuilder.CreateBox('jl-altar-surface', { width: 5.4, height: 0.12, depth: 1.8 }, scene), matGold)
        .position.set(0, 0.62, altarZ);
    // Sacred vessel (三方 mishiki offering stand)
    add(MeshBuilder.CreateCylinder('jl-altar-vessel-tray', { height: 0.12, diameter: 0.56, tessellation: 8 }, scene), matGold)
        .position.set(0, 0.75, altarZ);
    add(MeshBuilder.CreateCylinder('jl-altar-vessel-stem', { height: 0.28, diameter: 0.12, tessellation: 8 }, scene), matGold)
        .position.set(0, 0.97, altarZ);
    add(MeshBuilder.CreateCylinder('jl-altar-vessel-bowl', { height: 0.24, diameterTop: 0.54, diameterBottom: 0.36, tessellation: 8 }, scene), matGold)
        .position.set(0, 1.18, altarZ);
    // Flanking candles
    for (const cx of [-1.4, 1.4]) {
        add(MeshBuilder.CreateCylinder(`jl-candle-${cx}`, { height: 0.34, diameter: 0.08, tessellation: 6 }, scene), matShoji)
            .position.set(cx, 0.79, altarZ);
        // Flame sphere
        const flame = add(MeshBuilder.CreateSphere(`jl-flame-${cx}`, { diameter: 0.12, segments: 6 }, scene), matLanternAmb);
        flame.position.set(cx, 1.0, altarZ);
        flame.scaling.set(1, 1.4, 1);
    }
    // Side offering vases
    for (const vx of [-2.2, 2.2]) {
        add(MeshBuilder.CreateCylinder(`jl-vase-${vx}`, { height: 0.42, diameterTop: 0.26, diameterBottom: 0.18, tessellation: 8 }, scene), matGold)
            .position.set(vx, 0.84, altarZ);
    }

    // === HANGING BANNERS on side walls ===
    for (const [bside, bz, bmat] of [
        [-1, -9, matCrimson], [1, -9, matNavy],
        [-1, -1, matNavy],   [1, -1, matCrimson],
        [-1,  7, matCrimson], [1,  7, matNavy],
    ] as [number, number, PBRMaterial][]) {
        add(MeshBuilder.CreateBox(`jl-banner-${bside}-${bz}`, { width: 0.04, height: 2.2, depth: 0.88 }, scene), bmat)
            .position.set(bside * 6.8, 3.1, bz);
    }
    // Back wall center banner
    add(MeshBuilder.CreateBox('jl-center-banner', { width: 1.8, height: 0.04, depth: 3.2 }, scene), matCrimson)
        .position.set(0, 3.5, 12.8);

    // === MOON WINDOW 円窓 on back wall ===
    const moonRing = add(MeshBuilder.CreateTorus('jl-moon-window', { diameter: 2.0, thickness: 0.11, tessellation: 36 }, scene), matGold);
    moonRing.rotation.x = Math.PI / 2;
    moonRing.position.set(0, 3.9, 12.8);
    // Moon fill (shoji-lit, warm glow)
    const moonFill = add(MeshBuilder.CreateDisc('jl-moon-fill', { radius: 0.98, tessellation: 36 }, scene), matShoji);
    moonFill.rotation.x = -Math.PI / 2;
    moonFill.position.set(0, 3.9, 12.75);

    // === ENTRY STONE STEP ===
    add(MeshBuilder.CreateBox('jl-entry-stone', { width: 5.4, height: 0.1, depth: 1.4 }, scene), matStone)
        .position.set(0, FLOOR_Y + 0.05, -11.4);

    // === DECORATIVE TRIM on ceiling edge ===
    for (const side of [-1, 1]) {
        add(MeshBuilder.CreateBox(`jl-cornice-${side}`, { width: 0.18, height: 0.26, depth: 26 }, scene), matRedLacquer)
            .position.set(side * 6.8, CEILING_Y - 0.14, 0);
    }
    // Ceiling center boss at beam intersections
    for (let i = 0; i < 4; i++) {
        for (const side of [-1, 1]) {
            const z = -6 + i * 4;
            add(MeshBuilder.CreateBox(`jl-boss-${side}-${i}`, { width: 0.36, height: 0.18, depth: 0.36 }, scene), matGold)
                .position.set(side * 3.4, CEILING_Y - 0.04, z);
        }
    }

    return meshes;
}
