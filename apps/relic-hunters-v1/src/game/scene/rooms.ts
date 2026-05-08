import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
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
import { directionBetweenRooms, roomClueHotspot } from './prompts.ts';
import type { CardinalDirection } from './types.ts';

export type CastleMaterials = Readonly<{
    wall: StandardMaterial;
    ceiling: StandardMaterial;
    wood: StandardMaterial;
    trim: StandardMaterial;
    metal: StandardMaterial;
    gold: StandardMaterial;
    clothBlue: StandardMaterial;
    clothCoral: StandardMaterial;
    torch: StandardMaterial;
    crack: StandardMaterial;
    rubble: StandardMaterial;
    portal: StandardMaterial;
}>;

export type RoomRuntime = Readonly<{
    scene: Scene;
    castleMaterials: CastleMaterials;
    flickerLights: PointLight[];
}>;

export function createCastleMaterials(scene: Scene): CastleMaterials {
    return {
        wall: castleMaterial(scene, 'castle-wall-stone', '#b7c0ad', 0.025),
        ceiling: castleMaterial(scene, 'castle-ceiling-stone', '#98a99b', 0.018),
        wood: castleMaterial(scene, 'castle-oak', '#946b3c', 0.015),
        trim: castleMaterial(scene, 'castle-trim', '#d5b86f', 0.04),
        metal: castleMaterial(scene, 'castle-iron', '#9aa7ae', 0.018),
        gold: castleMaterial(scene, 'castle-gold', '#f1c453', 0.12),
        clothBlue: castleMaterial(scene, 'castle-blue-cloth', '#3db7d6', 0.08),
        clothCoral: castleMaterial(scene, 'castle-coral-cloth', '#f9736b', 0.07),
        torch: castleMaterial(scene, 'castle-torch-flame', '#ffbf5c', 0.72),
        crack: castleMaterial(scene, 'castle-crack-shadow', '#2f2d28', 0.005),
        rubble: castleMaterial(scene, 'castle-rubble', '#756b5d', 0.012),
        portal: castleMaterial(scene, 'castle-portal-light', '#8ee7f5', 0.32),
    };
}

export function applyRoomMaterial(
    material: StandardMaterial,
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
    material.diffuseColor = Color3.FromHexString(base);
    material.specularColor = new Color3(0.22, 0.19, 0.12);
    material.emissiveColor = room.collapsed
        ? new Color3(0.035, 0.028, 0.018)
        : room.unstable
        ? new Color3(0.2, 0.07, 0.025)
        : selected
        ? new Color3(0.18, 0.12, 0.035)
        : new Color3(0.035, 0.035, 0.026);
}

export function createIntroCastleScene(
    scene: Scene,
    materials: CastleMaterials,
): readonly Mesh[] {
    const meshes: Mesh[] = [];
    const add = (mesh: Mesh, material: StandardMaterial) => {
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
    const add = (mesh: Mesh, material: StandardMaterial) => {
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
    const add = (mesh: Mesh, material: StandardMaterial = materials.wall) => {
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

    const warm = Color3.FromHexString('#ffbf5c');
    const mystery = room.kind === 'exit'
        ? Color3.FromHexString('#8ee7f5')
        : room.kind === 'shrine'
        ? Color3.FromHexString('#b9a7f4')
        : room.kind === 'treasure'
        ? Color3.FromHexString('#f1c453')
        : Color3.FromHexString('#ffd08a');
    const torchZ = room.kind === 'exit' ? ROOM_SIZE / 2 - 0.28 : -ROOM_SIZE / 2 + 0.28;
    for (const x of [-1.35, 1.35]) {
        addLight(
            `room-torch-light-${room.id}-${x}`,
            new Vector3(x, 1.8, torchZ),
            warm,
            0.58,
            6.4,
        );
    }

    addLight(
        `room-clue-light-${room.id}`,
        new Vector3(0, 1.25, 0),
        mystery,
        room.kind === 'hallway' ? 0.22 : 0.34,
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
): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    const color = Color3.FromHexString(hex);
    material.diffuseColor = color;
    material.emissiveColor = color.scale(emissiveScale);
    material.specularColor = color.scale(0.14);
    return material;
}

function addRoomKindProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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

    for (let index = 0; index < 4; index += 1) {
        const angle = (Math.PI * 2 * index) / 4;
        const flame = add(MeshBuilder.CreateSphere(
            `castle-room-chandelier-flame-${room.id}-${index}`,
            { diameter: 0.14, segments: 10 },
            materials.torch.getScene(),
        ), materials.torch);
        flame.position.set(Math.cos(angle) * 0.52, CEILING_Y - 0.68, Math.sin(angle) * 0.52);
    }
}

function addClueHotspot(
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
): void {
    const clue = roomClueHotspot(room);
    const markInspectable = (mesh: Mesh) => {
        mesh.metadata = {
            ...(mesh.metadata ?? {}),
            roomId: room.id,
            clueHotspotId: clue.id,
            primeAction: 'search',
        };
        return mesh;
    };

    const ring = markInspectable(add(MeshBuilder.CreateTorus(
        `clue-ring-${clue.id}`,
        {
            diameter: room.kind === 'trap' ? 1.42 : 0.88,
            thickness: 0.035,
            tessellation: 34,
        },
        materials.portal.getScene(),
    ), room.kind === 'treasure' ? materials.gold : materials.portal));
    ring.position.set(clue.x, 0.18, clue.z);
    ring.rotation.x = Math.PI / 2;

    const focus = markInspectable(add(MeshBuilder.CreateSphere(
        `clue-focus-${clue.id}`,
        { diameter: room.kind === 'exit' ? 0.3 : 0.22, segments: 14 },
        materials.portal.getScene(),
    ), room.kind === 'treasure' ? materials.gold : materials.portal));
    focus.position.set(clue.x, room.kind === 'exit' ? 1.15 : 0.64, clue.z);

    if (room.kind === 'storage') {
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

    if (room.kind === 'shrine' || room.kind === 'exit') {
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

    if (room.kind === 'trap') {
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

    if (room.kind === 'treasure') {
        const plaque = markInspectable(add(MeshBuilder.CreateBox(
            `clue-mirror-plaque-${clue.id}`,
            { width: 0.64, height: 0.5, depth: 0.045 },
            materials.metal.getScene(),
        ), materials.metal));
        plaque.position.set(clue.x + 0.95, 1.18, clue.z - 0.52);
        plaque.rotation.y = -0.34;

        for (let index = 0; index < 5; index += 1) {
            const coin = markInspectable(add(MeshBuilder.CreateCylinder(
                `clue-coin-trail-${clue.id}-${index}`,
                { height: 0.026, diameter: 0.16, tessellation: 14 },
                materials.gold.getScene(),
            ), materials.gold));
            coin.position.set(clue.x - 0.72 + index * 0.28, 0.16, clue.z + 0.62 + (index % 2) * 0.16);
            coin.rotation.x = Math.PI / 2;
        }
    }

    if (room.kind === 'monster') {
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

    if (room.kind === 'exit') {
        const daylight = markInspectable(add(MeshBuilder.CreateBox(
            `clue-daylight-slit-${clue.id}`,
            { width: 0.2, height: 1.15, depth: 0.035 },
            materials.portal.getScene(),
        ), materials.portal));
        daylight.position.set(clue.x, 1.82, clue.z + 0.16);
    }
}

function addStoneCourseDetail(
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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

        const flame = add(MeshBuilder.CreateSphere(
            `castle-torch-flame-${room.id}-${x}`,
            { diameter: 0.18, segments: 12 },
            materials.torch.getScene(),
        ), materials.torch);
        flame.position.set(x, 1.48, side * (ROOM_SIZE / 2 - 0.14));
    }
}

function addRubblePile(
    add: (mesh: Mesh, material?: StandardMaterial) => Mesh,
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
