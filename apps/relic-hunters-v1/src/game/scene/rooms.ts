import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { RelicRoom } from '@relic-hunters/mod.ts';
import {
    buildBanner,
    buildCastleWall,
    buildCeilingGrid,
    buildCherryTree,
    buildGardenRock,
    buildLanternPair,
    buildLanternPost,
    buildStoneBase,
    buildTimberColumns,
    buildToriiGate,
    type CastleKitContext,
    type CastleKitMaterialRole,
    type CastleKitPalette
} from './castleKit.ts';
import { CEILING_Y, DOOR_WIDTH, FLOOR_Y, ROOM_SIZE, WALL_HEIGHT, WALL_THICKNESS, WORLD_SCALE } from './constants.ts';
import { RELIC_NEON_THEME, relicNeonAccentForRoom } from './neonTheme.ts';
import { directionBetweenRooms, roomClueHotspots } from './prompts.ts';
import { roomIdentityForRoom, type RoomIdentity } from './roomIdentity.ts';
import { MIN_ROOM_STATIC_BATCH_SIZE, roomStaticBatchKey } from './sceneBatching.ts';
import { applyClearCoat, applyNormalMap, applySheen, createCastleSurfaceTextures } from './textures.ts';
import type { CardinalDirection, ClueHotspot } from './types.ts';

export type CastleMaterials = Readonly<{
    wall: PBRMaterial;
    ceiling: PBRMaterial;
    plaster: PBRMaterial;
    wood: PBRMaterial;
    roofTile: PBRMaterial;
    lacquer: PBRMaterial;
    trim: PBRMaterial;
    metal: PBRMaterial;
    gold: PBRMaterial;
    shoji: PBRMaterial;
    foliage: PBRMaterial;
    water: PBRMaterial;
    holoGlass: PBRMaterial;
    neonCyan: PBRMaterial;
    neonMagenta: PBRMaterial;
    neonViolet: PBRMaterial;
    neonGreen: PBRMaterial;
    neonAmber: PBRMaterial;
    neonWhite: PBRMaterial;
    shadowPanel: PBRMaterial;
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
    const { stoneNormal, woodNormal, metalNormal } = createCastleSurfaceTextures(scene);

    const wall = castleMaterial(scene, 'neon-wall-graphite', RELIC_NEON_THEME.graphiteLift, 0.32, 0.08, 0.36);
    const ceiling = castleMaterial(scene, 'neon-ceiling-panel', RELIC_NEON_THEME.graphite, 0.34, 0.10, 0.34);
    const plaster = castleMaterial(scene, 'neon-hologlass-panel', RELIC_NEON_THEME.glass, 0.54, 0.00, 0.26);
    const wood = castleMaterial(scene, 'neon-carbon-rail', RELIC_NEON_THEME.graphiteLight, 0.26, 0.28, 0.28);
    const roofTile = castleMaterial(scene, 'neon-ceiling-rail', '#a9d9ea', 0.28, 0.26, 0.26);
    const lacquer = castleMaterial(scene, 'neon-magenta-trim', RELIC_NEON_THEME.magenta, 0.92, 0.08, 0.26);
    const trim = castleMaterial(scene, 'neon-cyan-trim', RELIC_NEON_THEME.cyan, 0.95, 0.12, 0.22);
    const metal = castleMaterial(scene, 'neon-brushed-metal', '#b7c9d6', 0.10, 0.82, 0.22);
    const gold = castleMaterial(scene, 'neon-amber-conduit', RELIC_NEON_THEME.amber, 0.82, 0.72, 0.16);
    const shoji = castleMaterial(scene, 'neon-white-panel', RELIC_NEON_THEME.white, 0.28, 0.00, 0.74);
    const foliage = castleMaterial(scene, 'neon-green-accent', RELIC_NEON_THEME.green, 0.74, 0.00, 0.44);
    const water = castleMaterial(scene, 'neon-blue-reflection', RELIC_NEON_THEME.cyanSoft, 0.70, 0.02, 0.20);
    const holoGlass = castleMaterial(scene, 'neon-hologlass', RELIC_NEON_THEME.glass, 0.82, 0.00, 0.16);
    const neonCyan = castleMaterial(scene, 'neon-cyan', RELIC_NEON_THEME.cyan, 1.35, 0.04, 0.18);
    const neonMagenta = castleMaterial(scene, 'neon-magenta', RELIC_NEON_THEME.magenta, 1.28, 0.04, 0.18);
    const neonViolet = castleMaterial(scene, 'neon-violet', RELIC_NEON_THEME.violet, 1.18, 0.06, 0.20);
    const neonGreen = castleMaterial(scene, 'neon-green', RELIC_NEON_THEME.green, 1.15, 0.04, 0.18);
    const neonAmber = castleMaterial(scene, 'neon-amber', RELIC_NEON_THEME.amber, 1.08, 0.08, 0.16);
    const neonWhite = castleMaterial(scene, 'neon-white', RELIC_NEON_THEME.white, 0.92, 0.02, 0.24);
    const shadowPanel = castleMaterial(scene, 'neon-shadow-panel', RELIC_NEON_THEME.shadow, 0.34, 0.08, 0.36);
    const clothBlue = castleMaterial(scene, 'neon-blue-cloth', RELIC_NEON_THEME.cyan, 0.82, 0.00, 0.58);
    const clothCoral = castleMaterial(scene, 'neon-coral-cloth', RELIC_NEON_THEME.coral, 0.82, 0.00, 0.58);
    const torch = castleMaterial(scene, 'neon-energy-flare', RELIC_NEON_THEME.amber, 2.10, 0, 0.55);
    const crack = castleMaterial(scene, 'neon-warning-cut', '#ff2d55', 0.55, 0, 0.80);
    const rubble = castleMaterial(scene, 'neon-carbon-block', '#a8bfd4', 0.18, 0.10, 0.44);
    const portal = castleMaterial(scene, 'neon-portal-light', RELIC_NEON_THEME.cyanSoft, 1.10, 0.12, 0.18);
    holoGlass.alpha = 0.62;
    holoGlass.backFaceCulling = false;

    // Stone surfaces — brick-course bump adds mortar joints and per-stone dome
    applyNormalMap(wall, stoneNormal, 4, 3);
    applyNormalMap(ceiling, stoneNormal, 4, 4);
    applyNormalMap(plaster, stoneNormal, 3, 3, 0.46);
    applyNormalMap(rubble, stoneNormal, 3, 3);
    applyNormalMap(trim, stoneNormal, 3, 3, 0.55);
    applyNormalMap(roofTile, stoneNormal, 5, 2, 0.52);

    // Wood — horizontal grain lines along beam length
    applyNormalMap(wood, woodNormal, 1, 6);
    applyNormalMap(lacquer, woodNormal, 1, 5, 0.35);

    // Metal — fine machining scratches; gold gets a subtle version
    applyNormalMap(metal, metalNormal, 2, 2);
    applyNormalMap(gold, metalNormal, 2, 2, 0.35);

    // Lacquer / jewellery clear coat — thin glossy layer on top of the PBR base
    applyClearCoat(gold, 0.88, 0.05); // mirror-like gilded surface
    applyClearCoat(trim, 0.48, 0.22); // polished stone/gilt trim
    applyClearCoat(lacquer, 0.88, 0.06);
    applyClearCoat(water, 0.5, 0.08);
    applyClearCoat(portal, 0.38, 0.14); // magical glass-like glow

    // Woven cloth sheen — fabric micro-fibres catch grazing light
    applySheen(clothBlue, 0.88, 0.62);
    applySheen(clothCoral, 0.88, 0.62);
    applySheen(shoji, 0.5, 0.84);
    applySheen(foliage, 0.45, 0.62);

    return {
        wall,
        ceiling,
        plaster,
        wood,
        roofTile,
        lacquer,
        trim,
        metal,
        gold,
        shoji,
        foliage,
        water,
        holoGlass,
        neonCyan,
        neonMagenta,
        neonViolet,
        neonGreen,
        neonAmber,
        neonWhite,
        shadowPanel,
        clothBlue,
        clothCoral,
        torch,
        crack,
        rubble,
        portal
    };
}

export function applyRoomMaterial(
    material: PBRMaterial,
    room: RelicRoom,
    selected: boolean
): void {
    const accent = relicNeonAccentForRoom(room);
    material.albedoColor = Color3.FromHexString(selected ? accent.secondary : accent.base);
    material.emissiveColor = Color3.FromHexString(accent.emissive).scale(
        room.collapsed ? 0.24 : selected ? 0.58 : room.unstable ? 0.46 : 0.28
    );
    material.metallic = 0.10;
    material.roughness = 0.38;
}

export function createIntroCastleScene(
    scene: Scene,
    materials: CastleMaterials
): readonly Mesh[] {
    const meshes: Mesh[] = [];
    const add = (mesh: Mesh, material: PBRMaterial) => {
        mesh.material = material;
        meshes.push(mesh);
        return mesh;
    };

    const floor = add(
        MeshBuilder.CreateBox(
            'intro-great-hall-floor',
            { width: 8.4, height: 0.12, depth: 16.5 },
            scene
        ),
        materials.wall
    );
    floor.position.set(0, FLOOR_Y, 0.5);

    const ceiling = add(
        MeshBuilder.CreateBox(
            'intro-great-hall-ceiling',
            { width: 8.7, height: 0.16, depth: 16.5 },
            scene
        ),
        materials.ceiling
    );
    ceiling.position.set(0, 5.05, 0.5);

    for (const side of [-1, 1]) {
        const wall = add(
            MeshBuilder.CreateBox(
                `intro-great-hall-wall-${side}`,
                { width: 0.22, height: 4.9, depth: 16.5 },
                scene
            ),
            materials.wall
        );
        wall.position.set(side * 4.28, 2.48, 0.5);

        for (let index = 0; index < 4; index += 1) {
            const window = add(
                MeshBuilder.CreateBox(
                    `intro-stained-window-${side}-${index}`,
                    { width: 0.04, height: 1.18, depth: 0.62 },
                    scene
                ),
                index % 2 === 0 ? materials.portal : materials.clothBlue
            );
            window.position.set(side * 4.14, 2.92, -4.9 + index * 3.1);
            window.rotation.y = Math.PI / 2;
        }

        for (let index = 0; index < 5; index += 1) {
            const pillar = add(
                MeshBuilder.CreateCylinder(
                    `intro-pillar-${side}-${index}`,
                    { height: 4.8, diameter: 0.42, tessellation: 10 },
                    scene
                ),
                materials.trim
            );
            pillar.position.set(side * 3.58, 2.42, -5.8 + index * 3.2);

            const banner = add(
                MeshBuilder.CreateBox(
                    `intro-banner-${side}-${index}`,
                    { width: 0.62, height: 1.36, depth: 0.045 },
                    scene
                ),
                index % 2 === 0 ? materials.clothCoral : materials.clothBlue
            );
            banner.position.set(side * 3.98, 2.72, -4.4 + index * 2.7);
            banner.rotation.y = Math.PI / 2;
        }

        const statue = add(
            MeshBuilder.CreateCylinder(
                `intro-guardian-statue-${side}`,
                { height: 1.5, diameterTop: 0.42, diameterBottom: 0.62, tessellation: 7 },
                scene
            ),
            materials.rubble
        );
        statue.position.set(side * 2.82, 0.82, -3.6);
        const crown = add(
            MeshBuilder.CreateCylinder(
                `intro-guardian-crown-${side}`,
                { height: 0.18, diameter: 0.52, tessellation: 8 },
                scene
            ),
            materials.gold
        );
        crown.position.set(side * 2.82, 1.66, -3.6);
    }

    const runner = add(
        MeshBuilder.CreateBox(
            'intro-great-hall-runner',
            { width: 1.36, height: 0.035, depth: 12.4 },
            scene
        ),
        materials.clothCoral
    );
    runner.position.set(0, 0.12, 0.8);

    const throneBase = add(
        MeshBuilder.CreateBox(
            'intro-throne-dais',
            { width: 2.7, height: 0.35, depth: 1.4 },
            scene
        ),
        materials.trim
    );
    throneBase.position.set(0, 0.25, 6.88);

    const throneBack = add(
        MeshBuilder.CreateBox(
            'intro-throne-back',
            { width: 1.18, height: 2.2, depth: 0.26 },
            scene
        ),
        materials.gold
    );
    throneBack.position.set(0, 1.28, 7.24);

    const throneSeat = add(
        MeshBuilder.CreateBox(
            'intro-throne-seat',
            { width: 1.32, height: 0.42, depth: 0.82 },
            scene
        ),
        materials.wood
    );
    throneSeat.position.set(0, 0.62, 6.92);

    for (let index = 0; index < 3; index += 1) {
        const ring = add(
            MeshBuilder.CreateTorus(
                `intro-chandelier-ring-${index}`,
                { diameter: 1.15 - index * 0.24, thickness: 0.035, tessellation: 32 },
                scene
            ),
            materials.metal
        );
        ring.position.set(0, 3.7 - index * 0.18, -1.8 + index * 2.8);
        ring.rotation.x = Math.PI / 2;

        for (let flameIndex = 0; flameIndex < 4; flameIndex += 1) {
            const angle = (Math.PI * 2 * flameIndex) / 4;
            const flame = add(
                MeshBuilder.CreateSphere(
                    `intro-chandelier-flame-${index}-${flameIndex}`,
                    { diameter: 0.16, segments: 10 },
                    scene
                ),
                materials.torch
            );
            flame.position.set(
                Math.cos(angle) * (0.58 - index * 0.12),
                3.58 - index * 0.18,
                -1.8 + index * 2.8 + Math.sin(angle) * (0.58 - index * 0.12)
            );
        }
    }

    return meshes;
}

export function createNeonMapBase(
    runtime: RoomRuntime,
    rooms: readonly RelicRoom[]
): readonly Mesh[] {
    if (rooms.length === 0) {
        return [];
    }

    const xs = rooms.map((room) => roomWorldPosition(room).x);
    const zs = rooms.map((room) => roomWorldPosition(room).z);
    const minX = Math.min(...xs) - ROOM_SIZE * 0.92;
    const maxX = Math.max(...xs) + ROOM_SIZE * 0.92;
    const minZ = Math.min(...zs) - ROOM_SIZE * 0.92;
    const maxZ = Math.max(...zs) + ROOM_SIZE * 0.92;
    const width = Math.max(ROOM_SIZE * 1.8, maxX - minX);
    const depth = Math.max(ROOM_SIZE * 1.8, maxZ - minZ);
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const meshes: Mesh[] = [];
    const add = (mesh: Mesh, material: PBRMaterial) => {
        mesh.material = material;
        meshes.push(mesh);
        return mesh;
    };

    const base = add(
        MeshBuilder.CreateBox(
            'neon-map-base-foundation',
            { width, height: 0.16, depth },
            runtime.scene
        ),
        runtime.castleMaterials.shadowPanel
    );
    base.position.set(centerX, FLOOR_Y - 0.22, centerZ);
    base.metadata = { neonMapBase: true };

    const glass = add(
        MeshBuilder.CreateBox(
            'neon-map-base-glow-plane',
            { width: width * 0.985, height: 0.035, depth: depth * 0.985 },
            runtime.scene
        ),
        runtime.castleMaterials.holoGlass
    );
    glass.position.set(centerX, FLOOR_Y - 0.11, centerZ);
    glass.visibility = 0.86;
    glass.metadata = { neonMapBase: true };

    const luminousDeck = add(
        MeshBuilder.CreateBox(
            'neon-map-base-luminous-deck',
            { width: width * 1.035, height: 0.026, depth: depth * 1.035 },
            runtime.scene
        ),
        runtime.castleMaterials.plaster
    );
    luminousDeck.position.set(centerX, FLOOR_Y - 0.032, centerZ);
    luminousDeck.visibility = 0.96;
    luminousDeck.metadata = { neonMapBase: true };

    const gridCountX = Math.max(2, Math.ceil(width / WORLD_SCALE));
    const gridCountZ = Math.max(2, Math.ceil(depth / WORLD_SCALE));
    for (let index = 0; index <= gridCountX; index += 1) {
        const x = minX + (width * index) / gridCountX;
        const line = add(
            MeshBuilder.CreateBox(
                `neon-map-grid-x-${index}`,
                { width: 0.035, height: 0.04, depth },
                runtime.scene
            ),
            index % 2 === 0 ? runtime.castleMaterials.neonCyan : runtime.castleMaterials.neonViolet
        );
        line.position.set(x, FLOOR_Y - 0.06, centerZ);
        line.visibility = 0.74;
        line.metadata = { neonMapBase: true };
    }

    for (let index = 0; index <= gridCountZ; index += 1) {
        const z = minZ + (depth * index) / gridCountZ;
        const line = add(
            MeshBuilder.CreateBox(
                `neon-map-grid-z-${index}`,
                { width, height: 0.04, depth: 0.035 },
                runtime.scene
            ),
            index % 2 === 0 ? runtime.castleMaterials.neonMagenta : runtime.castleMaterials.neonCyan
        );
        line.position.set(centerX, FLOOR_Y - 0.055, z);
        line.visibility = 0.70;
        line.metadata = { neonMapBase: true };
    }

    return meshes;
}

export function createCastleCorridor(
    runtime: RoomRuntime,
    from: RelicRoom,
    to: RelicRoom
): readonly Mesh[] {
    const fromPosition = roomWorldPosition(from);
    const toPosition = roomWorldPosition(to);
    const delta = toPosition.subtract(fromPosition);
    const horizontal = Math.abs(delta.x) > Math.abs(delta.z);
    const center = new Vector3(
        (fromPosition.x + toPosition.x) / 2,
        0,
        (fromPosition.z + toPosition.z) / 2
    );
    const span = (horizontal ? Math.abs(delta.x) : Math.abs(delta.z)) - ROOM_SIZE;
    if (span <= 0.18) {
        return [];
    }

    const meshes: Mesh[] = [];
    const corridorWidth = 2.05;
    const add = (mesh: Mesh, material: PBRMaterial) => {
        mesh.position.addInPlace(center);
        mesh.material = material;
        meshes.push(mesh);
        return mesh;
    };

    const floor = add(
        MeshBuilder.CreateBox(
            `corridor-floor-${from.id}-${to.id}`,
            {
                width: horizontal ? span + WALL_THICKNESS : corridorWidth,
                height: 0.1,
                depth: horizontal ? corridorWidth : span + WALL_THICKNESS
            },
            runtime.scene
        ),
        runtime.castleMaterials.shadowPanel
    );
    floor.position.y = FLOOR_Y;

    const ceiling = add(
        MeshBuilder.CreateBox(
            `corridor-ceiling-${from.id}-${to.id}`,
            {
                width: horizontal ? span + WALL_THICKNESS : corridorWidth,
                height: 0.1,
                depth: horizontal ? corridorWidth : span + WALL_THICKNESS
            },
            runtime.scene
        ),
        runtime.castleMaterials.holoGlass
    );
    ceiling.position.y = CEILING_Y;
    ceiling.visibility = 0.78;

    for (const side of [-1, 1]) {
        const wall = add(
            MeshBuilder.CreateBox(
                `corridor-wall-${from.id}-${to.id}-${side}`,
                {
                    width: horizontal ? span + WALL_THICKNESS : WALL_THICKNESS,
                    height: WALL_HEIGHT,
                    depth: horizontal ? WALL_THICKNESS : span + WALL_THICKNESS
                },
                runtime.scene
            ),
            runtime.castleMaterials.holoGlass
        );
        wall.position.y = WALL_HEIGHT / 2;
        wall.visibility = 0.72;
        if (horizontal) {
            wall.position.z += side * (corridorWidth / 2 + WALL_THICKNESS / 2);
        }
        else {
            wall.position.x += side * (corridorWidth / 2 + WALL_THICKNESS / 2);
        }

        const rail = add(
            MeshBuilder.CreateBox(
                `corridor-neon-rail-${from.id}-${to.id}-${side}`,
                {
                    width: horizontal ? span + WALL_THICKNESS : 0.075,
                    height: 0.075,
                    depth: horizontal ? 0.075 : span + WALL_THICKNESS
                },
                runtime.scene
            ),
            side < 0 ? runtime.castleMaterials.neonCyan : runtime.castleMaterials.neonMagenta
        );
        rail.position.y = FLOOR_Y + 0.14;
        if (horizontal) {
            rail.position.z += side * (corridorWidth / 2 - 0.12);
        }
        else {
            rail.position.x += side * (corridorWidth / 2 - 0.12);
        }
    }

    const beamCount = Math.max(1, Math.floor(span / 1.2));
    for (let index = 0; index < beamCount; index += 1) {
        const offset = span * ((index + 1) / (beamCount + 1) - 0.5);
        const beam = add(
            MeshBuilder.CreateBox(
                `corridor-beam-${from.id}-${to.id}-${index}`,
                {
                    width: horizontal ? 0.16 : corridorWidth + 0.28,
                    height: 0.16,
                    depth: horizontal ? corridorWidth + 0.28 : 0.16
                },
                runtime.scene
            ),
            index % 2 === 0 ? runtime.castleMaterials.neonViolet : runtime.castleMaterials.neonCyan
        );
        beam.position.y = CEILING_Y - 0.12;
        if (horizontal) {
            beam.position.x += offset;
        }
        else {
            beam.position.z += offset;
        }
    }

    return meshes;
}

export function createRoomProps(
    runtime: RoomRuntime,
    room: RelicRoom,
    rooms: readonly RelicRoom[],
    root: Mesh
): readonly Mesh[] {
    const props: Mesh[] = [];
    const materials = runtime.castleMaterials;
    const add = (mesh: Mesh, material: PBRMaterial = materials.wall) => {
        mesh.metadata = {
            ...(metadataRecord(mesh.metadata) ?? {}),
            roomId: room.id
        };
        mesh.material = material;
        props.push(mesh);
        return mesh;
    };

    const doorDirections = roomDoorDirections(room, rooms);
    const kit = createRoomCastleKit(runtime.scene, add, materials, room.id);
    buildStoneBase(kit);
    addNeonRoomEnvelope(runtime, add, room, materials, doorDirections);
    for (const direction of ['north', 'south', 'east', 'west'] as const) {
        buildCastleWall(kit, direction, doorDirections.has(direction));
    }
    buildCeilingGrid(kit);
    addStoneCourseDetail(add, room, materials);
    buildTimberColumns(kit);
    addCastleCracks(add, room, materials);
    addJapaneseCastleAccents(kit, room);
    addRoomIdentitySilhouette(runtime, kit, add, room, roomIdentityForRoom(room));
    addHighFantasyRoomDecor(add, room, materials);
    addRoomKindProps(runtime, add, room, materials);
    addClueHotspot(add, room, materials);
    addRubblePile(add, room, materials);

    return finalizeRoomProps(props, root, room.id);
}

function addNeonRoomEnvelope(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials,
    doorDirections: ReadonlySet<CardinalDirection>
): void {
    const accent = relicNeonAccentForRoom(room);
    const accentMaterial = room.kind === 'monster'
        ? materials.neonMagenta
        : room.kind === 'trap'
        ? materials.neonAmber
        : room.kind === 'treasure'
        ? materials.neonGreen
        : room.kind === 'shrine'
        ? materials.neonViolet
        : room.kind === 'exit'
        ? materials.neonGreen
        : materials.neonCyan;
    const secondaryMaterial = room.kind === 'monster' || room.kind === 'shrine'
        ? materials.neonViolet
        : room.kind === 'trap'
        ? materials.neonMagenta
        : materials.neonAmber;

    const floorPanel = add(
        MeshBuilder.CreateBox(
            `neon-room-floor-panel-${room.id}`,
            { width: ROOM_SIZE - 0.44, height: 0.035, depth: ROOM_SIZE - 0.44 },
            runtime.scene
        ),
        materials.holoGlass
    );
    floorPanel.position.set(0, 0.17, 0);
    floorPanel.visibility = room.collapsed ? 0.56 : 0.86;

    for (const offset of [-2.4, -1.2, 0, 1.2, 2.4]) {
        const lineX = add(
            MeshBuilder.CreateBox(
                `neon-room-grid-x-${room.id}-${offset}`,
                { width: 0.035, height: 0.045, depth: ROOM_SIZE - 1.1 },
                runtime.scene
            ),
            Math.abs(offset) < 0.01 ? accentMaterial : materials.neonCyan
        );
        lineX.position.set(offset, 0.22, 0);
        lineX.visibility = 0.72;

        const lineZ = add(
            MeshBuilder.CreateBox(
                `neon-room-grid-z-${room.id}-${offset}`,
                { width: ROOM_SIZE - 1.1, height: 0.045, depth: 0.035 },
                runtime.scene
            ),
            Math.abs(offset) < 0.01 ? secondaryMaterial : materials.neonMagenta
        );
        lineZ.position.set(0, 0.225, offset);
        lineZ.visibility = 0.54;
    }

    for (const side of [-1, 1]) {
        const skirtNs = add(
            MeshBuilder.CreateBox(
                `neon-room-skirt-ns-${room.id}-${side}`,
                { width: ROOM_SIZE + 0.64, height: 0.58, depth: 0.16 },
                runtime.scene
            ),
            materials.shadowPanel
        );
        skirtNs.position.set(0, -0.22, side * (ROOM_SIZE / 2 + 0.18));

        const skirtEw = add(
            MeshBuilder.CreateBox(
                `neon-room-skirt-ew-${room.id}-${side}`,
                { width: 0.16, height: 0.58, depth: ROOM_SIZE + 0.64 },
                runtime.scene
            ),
            materials.shadowPanel
        );
        skirtEw.position.set(side * (ROOM_SIZE / 2 + 0.18), -0.22, 0);

        const railNs = add(
            MeshBuilder.CreateBox(
                `neon-room-edge-ns-${room.id}-${side}`,
                { width: ROOM_SIZE + 0.28, height: 0.065, depth: 0.065 },
                runtime.scene
            ),
            side < 0 ? accentMaterial : secondaryMaterial
        );
        railNs.position.set(0, 0.32, side * (ROOM_SIZE / 2 - 0.28));

        const railEw = add(
            MeshBuilder.CreateBox(
                `neon-room-edge-ew-${room.id}-${side}`,
                { width: 0.065, height: 0.065, depth: ROOM_SIZE + 0.28 },
                runtime.scene
            ),
            side < 0 ? secondaryMaterial : accentMaterial
        );
        railEw.position.set(side * (ROOM_SIZE / 2 - 0.28), 0.32, 0);
    }

    for (const direction of ['north', 'south', 'east', 'west'] as const) {
        addHologlassWall(add, runtime.scene, room.id, direction, doorDirections.has(direction), materials);
        if (doorDirections.has(direction)) {
            addNeonDoorFrame(add, runtime.scene, room.id, direction, accentMaterial, secondaryMaterial);
        }
    }

    const halo = add(
        MeshBuilder.CreateTorus(
            `neon-room-kind-halo-${room.id}`,
            { diameter: room.kind === 'exit' ? 4.7 : 4.1, thickness: 0.052, tessellation: 54 },
            runtime.scene
        ),
        accentMaterial
    );
    halo.position.set(0, 0.27, 0);
    halo.rotation.x = Math.PI / 2;
    halo.visibility = room.unstable ? 0.92 : 0.68;

    const accentPlate = add(
        MeshBuilder.CreateBox(
            `neon-room-accent-plate-${room.id}`,
            { width: 1.15, height: 0.05, depth: 0.32 },
            runtime.scene
        ),
        accentMaterial
    );
    accentPlate.position.set(0, 0.34, -ROOM_SIZE / 2 + 0.72);
    accentPlate.visibility = accent.emissive === RELIC_NEON_THEME.coral ? 0.94 : 0.76;
}

function addHologlassWall(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    scene: Scene,
    roomId: string,
    direction: CardinalDirection,
    hasDoor: boolean,
    materials: CastleMaterials
): void {
    const northSouth = direction === 'north' || direction === 'south';
    const sign = direction === 'north' || direction === 'west' ? -1 : 1;
    const wallPosition = sign * (ROOM_SIZE / 2 - 0.08);
    const panelSpan = hasDoor ? (ROOM_SIZE - DOOR_WIDTH) / 2 - 0.18 : ROOM_SIZE - 0.5;
    const panelOffsets = hasDoor
        ? [-1, 1].map((side) => side * (DOOR_WIDTH / 2 + panelSpan / 2 + 0.08))
        : [0];

    for (const offset of panelOffsets) {
        const panel = add(
            MeshBuilder.CreateBox(
                `neon-hologlass-wall-${roomId}-${direction}-${offset}`,
                {
                    width: northSouth ? panelSpan : 0.055,
                    height: 2.05,
                    depth: northSouth ? 0.055 : panelSpan
                },
                scene
            ),
            materials.holoGlass
        );
        panel.position.set(
            northSouth ? offset : wallPosition,
            1.36,
            northSouth ? wallPosition : offset
        );
        panel.visibility = 0.74;
    }
}

function addNeonDoorFrame(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    scene: Scene,
    roomId: string,
    direction: CardinalDirection,
    primary: PBRMaterial,
    secondary: PBRMaterial
): void {
    const northSouth = direction === 'north' || direction === 'south';
    const sign = direction === 'north' || direction === 'west' ? -1 : 1;
    const wallPosition = sign * (ROOM_SIZE / 2 - 0.18);
    const sideOffsets = [-DOOR_WIDTH / 2, DOOR_WIDTH / 2];
    for (const sideOffset of sideOffsets) {
        const upright = add(
            MeshBuilder.CreateBox(
                `neon-door-upright-${roomId}-${direction}-${sideOffset}`,
                {
                    width: northSouth ? 0.08 : 0.10,
                    height: 2.15,
                    depth: northSouth ? 0.10 : 0.08
                },
                scene
            ),
            primary
        );
        upright.position.set(
            northSouth ? sideOffset : wallPosition,
            1.28,
            northSouth ? wallPosition : sideOffset
        );
    }

    const lintel = add(
        MeshBuilder.CreateBox(
            `neon-door-lintel-${roomId}-${direction}`,
            {
                width: northSouth ? DOOR_WIDTH + 0.18 : 0.10,
                height: 0.10,
                depth: northSouth ? 0.10 : DOOR_WIDTH + 0.18
            },
            scene
        ),
        secondary
    );
    lintel.position.set(
        northSouth ? 0 : wallPosition,
        2.37,
        northSouth ? wallPosition : 0
    );
}

export function createRoomLights(runtime: RoomRuntime, room: RelicRoom): readonly PointLight[] {
    const world = roomWorldPosition(room);
    const lights: PointLight[] = [];
    const addLight = (
        name: string,
        local: Vector3,
        color: Color3,
        intensity: number,
        range: number
    ) => {
        const light = new PointLight(
            name,
            new Vector3(world.x + local.x, local.y, world.z + local.z),
            runtime.scene
        );
        light.diffuse = color;
        light.specular = color.scale(0.65);
        light.intensity = intensity;
        light.range = range;
        light.metadata = {
            baseIntensity: intensity,
            flickerSeed: Math.random() * 1000
        };
        lights.push(light);
        runtime.flickerLights.push(light);
        return light;
    };

    const accent = relicNeonAccentForRoom(room);
    const tubeColor = Color3.FromHexString(accent.emissive);
    const centerColor = Color3.FromHexString(accent.secondary);
    const torchZ = room.kind === 'exit' ? ROOM_SIZE / 2 - 0.28 : -ROOM_SIZE / 2 + 0.28;
    const torchIntensity = room.kind === 'monster' ? 1.45 : room.kind === 'trap' ? 1.32 : 1.18;
    for (const x of [-1.35, 1.35]) {
        addLight(
            `room-neon-tube-light-${room.id}-${x}`,
            new Vector3(x, 1.8, torchZ),
            tubeColor,
            torchIntensity,
            11.5
        );
    }

    const centerIntensity = room.kind === 'shrine'
        ? 1.05
        : room.kind === 'treasure'
        ? 0.98
        : room.kind === 'exit'
        ? 1.12
        : room.kind === 'hallway'
        ? 0.74
        : 0.86;
    addLight(
        `room-neon-core-light-${room.id}`,
        new Vector3(0, 1.25, 0),
        centerColor,
        centerIntensity,
        9.0
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
    roughness: number
): PBRMaterial {
    const material = new PBRMaterial(name, scene);
    const color = Color3.FromHexString(hex);
    material.albedoColor = color;
    material.emissiveColor = color.scale(emissiveScale);
    material.metallic = metallic;
    material.roughness = roughness;
    return material;
}

function createRoomCastleKit(
    scene: Scene,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    materials: CastleMaterials,
    roomId: string
): CastleKitContext {
    return {
        scene,
        add,
        materials: toCastleKitPalette(materials),
        prefix: `room-kit-${roomId}`,
        roomSize: ROOM_SIZE,
        wallHeight: WALL_HEIGHT,
        wallThickness: WALL_THICKNESS,
        doorWidth: DOOR_WIDTH,
        floorY: FLOOR_Y,
        ceilingY: CEILING_Y
    };
}

function finalizeRoomProps(
    props: readonly Mesh[],
    root: Mesh,
    roomId: string
): readonly Mesh[] {
    const batches = new Map<string, Mesh[]>();
    const finalized: Mesh[] = [];

    for (const mesh of props) {
        const key = roomStaticBatchKey({
            materialKey: mesh.material ? String(mesh.material.uniqueId) : undefined,
            visibility: mesh.visibility,
            metadata: metadataRecord(mesh.metadata)
        });
        if (!key) {
            finalized.push(mesh);
            continue;
        }

        const batch = batches.get(key);
        if (batch) {
            batch.push(mesh);
        }
        else {
            batches.set(key, [mesh]);
        }
    }

    for (const [key, meshes] of batches.entries()) {
        if (meshes.length < MIN_ROOM_STATIC_BATCH_SIZE) {
            finalized.push(...meshes);
            continue;
        }

        const merged = Mesh.MergeMeshes([...meshes], true, true);
        if (!merged) {
            finalized.push(...meshes);
            continue;
        }

        merged.name = `room-static-batch-${roomId}-${sanitizedBatchKey(key)}`;
        merged.id = merged.name;
        merged.metadata = {
            roomId,
            staticBatch: true,
            batchedMeshCount: meshes.length
        };
        finalized.push(merged);
    }

    for (const mesh of finalized) {
        mesh.parent = root;
        mesh.metadata = {
            ...(metadataRecord(mesh.metadata) ?? {}),
            roomId
        };
    }

    return finalized;
}

function metadataRecord(metadata: unknown): Readonly<Record<string, unknown>> | undefined {
    return metadata && typeof metadata === 'object'
        ? metadata as Readonly<Record<string, unknown>>
        : undefined;
}

function sanitizedBatchKey(key: string): string {
    return key.replace(/[^a-z0-9_-]/gi, '-');
}

function toCastleKitPalette(materials: CastleMaterials): CastleKitPalette {
    return {
        stone: materials.wall,
        plaster: materials.plaster,
        wood: materials.wood,
        roofTile: materials.roofTile,
        lacquer: materials.lacquer,
        metal: materials.metal,
        gold: materials.gold,
        paper: materials.shoji,
        foliage: materials.foliage,
        water: materials.water,
        lantern: materials.torch,
        accentBlue: materials.clothBlue,
        accentCoral: materials.clothCoral,
        crack: materials.crack,
        rubble: materials.rubble,
        portal: materials.portal
    };
}

function addJapaneseCastleAccents(
    kit: CastleKitContext,
    room: RelicRoom
): void {
    buildLanternPair(kit, room.kind === 'exit' ? 'south' : 'north');

    for (const side of [-1, 1]) {
        buildBanner(
            kit,
            `side-banner-${room.id}-${side}`,
            side < 0 ? 'accentBlue' : 'accentCoral',
            new Vector3(side * (kit.roomSize / 2 - 0.07), 2.38, -0.62),
            side < 0 ? 'west' : 'east'
        );
    }

    if (room.kind === 'entrance' || room.kind === 'shrine') {
        buildToriiGate(
            kit,
            `torii-${room.id}`,
            new Vector3(0, 0.12, -kit.roomSize / 2 + 1.12),
            room.kind === 'entrance' ? 1.5 : 1.15
        );
    }

    if (room.kind === 'exit') {
        buildToriiGate(
            kit,
            `exit-garden-gate-${room.id}`,
            new Vector3(0, 0.1, kit.roomSize / 2 - 1.12),
            1.32
        );
        buildCherryTree(
            kit,
            `exit-cherry-left-${room.id}`,
            new Vector3(-kit.roomSize / 2 + 1.9, 0.05, kit.roomSize / 2 - 2.3),
            1.0
        );
        buildCherryTree(
            kit,
            `exit-cherry-right-${room.id}`,
            new Vector3(kit.roomSize / 2 - 1.9, 0.05, kit.roomSize / 2 - 2.3),
            0.9
        );
    }

    if (room.kind === 'monster' || room.kind === 'trap') {
        buildGardenRock(
            kit,
            `broken-garden-rock-${room.id}`,
            new Vector3(-kit.roomSize / 2 + 1.7, 0.26, kit.roomSize / 2 - 1.8),
            1.4
        );
        buildGardenRock(
            kit,
            `fallen-garden-rock-${room.id}`,
            new Vector3(kit.roomSize / 2 - 1.8, 0.24, -kit.roomSize / 2 + 1.7),
            0.95
        );
    }
}

function addRoomIdentitySilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    addIdentityFloorMark(runtime, kit, add, room, identity);

    switch (identity.silhouette) {
        case 'gatehouse':
            addGatehouseSilhouette(runtime, kit, add, room, identity);
            break;
        case 'main-corridor':
            addMainCorridorSilhouette(runtime, kit, add, room, identity);
            break;
        case 'armory-storage':
            addArmoryStorageSilhouette(runtime, kit, add, room, identity);
            break;
        case 'main-shrine':
            addMainShrineSilhouette(runtime, kit, add, room, identity);
            break;
        case 'secret-cell':
            addSecretCellSilhouette(runtime, kit, add, room, identity);
            break;
        case 'treasury':
            addTreasurySilhouette(runtime, kit, add, room, identity);
            break;
        case 'haunted-barracks':
            addHauntedBarracksSilhouette(runtime, kit, add, room, identity);
            break;
        case 'garden-watchtower':
            addGardenWatchtowerSilhouette(runtime, kit, add, room, identity);
            break;
    }
}

function addIdentityFloorMark(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    const material = identity.floorMotif === 'warning-grid'
        ? 'accentCoral'
        : identity.floorMotif === 'vault-ring'
        ? 'gold'
        : identity.floorMotif === 'garden-path'
        ? 'water'
        : identity.accentMaterial;

    if (identity.floorMotif === 'runner') {
        addIdentityBox(
            runtime,
            add,
            room,
            'identity-runner-long',
            {
                width: 1.55,
                height: 0.032,
                depth: ROOM_SIZE - 3.2
            },
            material,
            new Vector3(0, 0.14, 0)
        );
        return;
    }

    if (identity.floorMotif === 'warning-grid') {
        for (const x of [-1.2, 0, 1.2]) {
            addIdentityBox(
                runtime,
                add,
                room,
                `identity-warning-strip-x-${x}`,
                {
                    width: 0.05,
                    height: 0.035,
                    depth: 3.4
                },
                material,
                new Vector3(x, 0.15, 0)
            );
            addIdentityBox(
                runtime,
                add,
                room,
                `identity-warning-strip-z-${x}`,
                {
                    width: 3.4,
                    height: 0.035,
                    depth: 0.05
                },
                material,
                new Vector3(0, 0.155, x)
            );
        }
        return;
    }

    if (identity.floorMotif === 'garden-path') {
        for (let index = 0; index < 5; index += 1) {
            buildGardenRock(
                kit,
                `identity-stepping-stone-${room.id}-${index}`,
                new Vector3(-1.6 + index * 0.8, 0.16, ROOM_SIZE / 2 - 3.8 + index * 0.38),
                0.72
            );
        }
        addIdentityBox(
            runtime,
            add,
            room,
            'identity-water-rill',
            {
                width: ROOM_SIZE - 3.2,
                height: 0.025,
                depth: 0.34
            },
            'water',
            new Vector3(0, 0.125, ROOM_SIZE / 2 - 2.1)
        );
        return;
    }

    const ring = add(
        MeshBuilder.CreateTorus(
            `identity-floor-ring-${room.id}`,
            {
                diameter: identity.floorMotif === 'vault-ring' || identity.floorMotif === 'altar-ring' ? 3.9 : 2.9,
                thickness: identity.floorMotif === 'threshold' ? 0.055 : 0.042,
                tessellation: 44
            },
            runtime.scene
        ),
        kit.materials[material]
    );
    ring.position.set(0, 0.16, 0);
    ring.rotation.x = Math.PI / 2;
}

function addGatehouseSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    const z = -ROOM_SIZE / 2 + 0.75;
    addIdentityBox(
        runtime,
        add,
        room,
        'gatehouse-roof-main',
        {
            width: 5.4,
            height: 0.32,
            depth: 1.05
        },
        'roofTile',
        new Vector3(0, 3.6, z)
    );
    addIdentityBox(
        runtime,
        add,
        room,
        'gatehouse-roof-eave',
        {
            width: 6.2,
            height: 0.18,
            depth: 1.34
        },
        'roofTile',
        new Vector3(0, 3.36, z)
    );
    for (const x of [-2.4, 2.4]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `gatehouse-post-${x}`,
            {
                width: 0.32,
                height: 2.7,
                depth: 0.32
            },
            identity.primaryMaterial,
            new Vector3(x, 1.54, z)
        );
    }
    for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `gatehouse-bars-${x}`,
            {
                width: 0.055,
                height: 1.85,
                depth: 0.08
            },
            identity.accentMaterial,
            new Vector3(x, 1.48, z - 0.18)
        );
    }
}

function addMainCorridorSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    for (const side of [-1, 1]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `corridor-guide-rail-${side}`,
            {
                width: 0.16,
                height: 0.18,
                depth: ROOM_SIZE - 3.0
            },
            identity.primaryMaterial,
            new Vector3(side * 1.65, 0.42, 0)
        );
        for (let index = 0; index < 4; index += 1) {
            buildLanternPost(
                kit,
                `corridor-small-lantern-${room.id}-${side}-${index}`,
                side * 2.35,
                -5.1 + index * 3.4
            );
        }
    }
}

function addArmoryStorageSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    for (const side of [-1, 1]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `armory-shelf-back-${side}`,
            {
                width: 0.18,
                height: 1.6,
                depth: 2.8
            },
            identity.primaryMaterial,
            new Vector3(side * 2.25, 1.0, 0.5)
        );
        for (const z of [-0.7, 0.2, 1.1]) {
            addIdentityBox(
                runtime,
                add,
                room,
                `armory-shelf-${side}-${z}`,
                {
                    width: 0.72,
                    height: 0.12,
                    depth: 0.24
                },
                identity.primaryMaterial,
                new Vector3(side * 2.12, 0.58 + z * 0.22, z)
            );
        }
        for (let index = 0; index < 4; index += 1) {
            const spear = addIdentityCylinder(
                runtime,
                add,
                room,
                `armory-spear-${side}-${index}`,
                {
                    height: 1.75,
                    diameter: 0.045,
                    tessellation: 6
                },
                identity.accentMaterial,
                new Vector3(side * 2.0, 1.05, -1.2 + index * 0.38)
            );
            spear.rotation.z = side * 0.18;
        }
    }
    addIdentityBox(
        runtime,
        add,
        room,
        'armory-crate-tower-bottom',
        {
            width: 1.15,
            height: 0.5,
            depth: 0.95
        },
        identity.primaryMaterial,
        new Vector3(0, 0.34, -1.3)
    );
    addIdentityBox(
        runtime,
        add,
        room,
        'armory-crate-tower-top',
        {
            width: 0.88,
            height: 0.42,
            depth: 0.78
        },
        identity.primaryMaterial,
        new Vector3(0.18, 0.82, -1.28)
    );
}

function addMainShrineSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    addIdentityBox(
        runtime,
        add,
        room,
        'shrine-dais-wide',
        {
            width: 4.0,
            height: 0.28,
            depth: 2.3
        },
        'wood',
        new Vector3(0, 0.23, 1.2)
    );
    addIdentityBox(
        runtime,
        add,
        room,
        'shrine-dais-gold',
        {
            width: 3.15,
            height: 0.18,
            depth: 1.58
        },
        'gold',
        new Vector3(0, 0.5, 1.2)
    );
    addIdentityBox(
        runtime,
        add,
        room,
        'shrine-shoji-screen',
        {
            width: 3.6,
            height: 1.72,
            depth: 0.06
        },
        identity.primaryMaterial,
        new Vector3(0, 1.58, ROOM_SIZE / 2 - 1.1)
    );
    buildToriiGate(
        kit,
        `identity-shrine-torii-${room.id}`,
        new Vector3(0, 0.16, ROOM_SIZE / 2 - 2.1),
        1.24
    );
    const halo = add(
        MeshBuilder.CreateTorus(
            `identity-shrine-halo-${room.id}`,
            { diameter: 1.45, thickness: 0.05, tessellation: 36 },
            runtime.scene
        ),
        kit.materials[identity.accentMaterial]
    );
    halo.position.set(0, 1.7, ROOM_SIZE / 2 - 1.18);
}

function addSecretCellSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    const z = ROOM_SIZE / 2 - 1.25;
    for (const x of [-1.5, -0.9, -0.3, 0.3, 0.9, 1.5]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `cell-bar-${x}`,
            {
                width: 0.08,
                height: 2.35,
                depth: 0.08
            },
            identity.primaryMaterial,
            new Vector3(x, 1.32, z)
        );
    }
    for (const y of [0.68, 1.45, 2.18]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `cell-crossbar-${y}`,
            {
                width: 3.55,
                height: 0.08,
                depth: 0.08
            },
            identity.primaryMaterial,
            new Vector3(0, y, z)
        );
    }
    for (const x of [-0.72, 0.72]) {
        const spike = addIdentityCylinder(
            runtime,
            add,
            room,
            `cell-warning-spike-${x}`,
            {
                height: 0.92,
                diameterBottom: 0.24,
                diameterTop: 0.02,
                tessellation: 4
            },
            identity.accentMaterial,
            new Vector3(x, 0.58, -0.7)
        );
        spike.rotation.z = x * 0.22;
    }
}

function addTreasurySilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    addIdentityBox(
        runtime,
        add,
        room,
        'treasury-plinth-base',
        {
            width: 2.4,
            height: 0.42,
            depth: 1.8
        },
        identity.accentMaterial,
        new Vector3(0, 0.32, 0.45)
    );
    addIdentityBox(
        runtime,
        add,
        room,
        'treasury-plinth-top',
        {
            width: 1.75,
            height: 0.22,
            depth: 1.18
        },
        identity.primaryMaterial,
        new Vector3(0, 0.68, 0.45)
    );
    for (const [index, x] of [-1.25, -0.72, 0.82, 1.32].entries()) {
        const stack = addIdentityCylinder(
            runtime,
            add,
            room,
            `treasury-coin-stack-${index}`,
            {
                height: 0.12 + index * 0.045,
                diameter: 0.42,
                tessellation: 16
            },
            identity.primaryMaterial,
            new Vector3(x, 0.24 + index * 0.02, -0.9 + (index % 2) * 0.5)
        );
        stack.rotation.x = Math.PI / 2;
    }
    const vault = add(
        MeshBuilder.CreateTorus(
            `identity-treasury-vault-ring-${room.id}`,
            { diameter: 2.85, thickness: 0.13, tessellation: 42 },
            runtime.scene
        ),
        kit.materials[identity.primaryMaterial]
    );
    vault.position.set(0, 1.78, ROOM_SIZE / 2 - 1.2);
    vault.rotation.x = Math.PI / 2;
}

function addHauntedBarracksSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    for (let index = 0; index < 4; index += 1) {
        const beam = addIdentityBox(
            runtime,
            add,
            room,
            `barracks-broken-beam-${index}`,
            {
                width: 3.0 - index * 0.28,
                height: 0.18,
                depth: 0.24
            },
            'wood',
            new Vector3(-1.4 + index * 0.82, 1.7 + index * 0.2, -0.8 + index * 0.35)
        );
        beam.rotation.z = -0.55 + index * 0.24;
        beam.rotation.y = 0.3;
    }
    for (let index = 0; index < 4; index += 1) {
        const claw = addIdentityBox(
            runtime,
            add,
            room,
            `barracks-claw-${index}`,
            {
                width: 1.25,
                height: 0.035,
                depth: 0.05
            },
            identity.accentMaterial,
            new Vector3(-0.9 + index * 0.42, 1.46 + index * 0.18, -ROOM_SIZE / 2 + 0.16)
        );
        claw.rotation.z = -0.68;
    }
    addIdentityBox(
        runtime,
        add,
        room,
        'barracks-torn-banner',
        {
            width: 0.9,
            height: 1.62,
            depth: 0.05
        },
        identity.dangerMaterial ?? 'accentCoral',
        new Vector3(ROOM_SIZE / 2 - 0.1, 2.1, 0)
    );
}

function addGardenWatchtowerSilhouette(
    runtime: RoomRuntime,
    kit: CastleKitContext,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    identity: RoomIdentity
): void {
    for (const x of [-1.05, 1.05]) {
        addIdentityBox(
            runtime,
            add,
            room,
            `watchtower-post-${x}`,
            {
                width: 0.18,
                height: 2.45,
                depth: 0.18
            },
            'wood',
            new Vector3(x, 1.32, ROOM_SIZE / 2 - 2.35)
        );
    }
    addIdentityBox(
        runtime,
        add,
        room,
        'watchtower-roof',
        {
            width: 3.2,
            height: 0.28,
            depth: 1.5
        },
        'roofTile',
        new Vector3(0, 2.68, ROOM_SIZE / 2 - 2.35)
    );
    const beacon = addIdentityCylinder(
        runtime,
        add,
        room,
        'escape-beacon',
        {
            height: 3.1,
            diameter: 0.34,
            tessellation: 18
        },
        identity.primaryMaterial,
        new Vector3(0, 1.72, ROOM_SIZE / 2 - 1.0)
    );
    beacon.visibility = 0.72;
    buildCherryTree(
        kit,
        `identity-exit-cherry-${room.id}`,
        new Vector3(-ROOM_SIZE / 2 + 2.7, 0.08, ROOM_SIZE / 2 - 3.0),
        1.25
    );
}

function addIdentityBox(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    name: string,
    size: Readonly<{ width: number; height: number; depth: number; }>,
    material: CastleKitMaterialRole,
    position: Vector3
): Mesh {
    const mesh = add(
        MeshBuilder.CreateBox(`identity-${room.id}-${name}`, size, runtime.scene),
        toCastleKitPalette(runtime.castleMaterials)[material]
    );
    mesh.position.copyFrom(position);
    return mesh;
}

function addIdentityCylinder(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    name: string,
    options: Parameters<typeof MeshBuilder.CreateCylinder>[1],
    material: CastleKitMaterialRole,
    position: Vector3
): Mesh {
    const mesh = add(
        MeshBuilder.CreateCylinder(`identity-${room.id}-${name}`, options, runtime.scene),
        toCastleKitPalette(runtime.castleMaterials)[material]
    );
    mesh.position.copyFrom(position);
    return mesh;
}

function addRoomKindProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
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
    materials: CastleMaterials
): void {
    const portcullis = add(
        MeshBuilder.CreateBox(
            `prop-portcullis-${room.id}`,
            { width: 1.05, height: 1.08, depth: 0.08 },
            runtime.scene
        ),
        materials.metal
    );
    portcullis.position.set(0, 1.34, -ROOM_SIZE / 2 + 0.14);
    portcullis.rotation.z = 0.035;

    for (const side of [-1, 1]) {
        const banner = add(
            MeshBuilder.CreateBox(
                `prop-banner-${room.id}-${side}`,
                { width: 0.32, height: 0.88, depth: 0.035 },
                runtime.scene
            ),
            side < 0 ? materials.clothBlue : materials.clothCoral
        );
        banner.position.set(side * 1.12, 2.02, -ROOM_SIZE / 2 + 0.08);
    }
}

function addHallwayProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const runner = add(
        MeshBuilder.CreateBox(
            `prop-runner-${room.id}`,
            { width: 1.2, height: 0.025, depth: 4.6 },
            runtime.scene
        ),
        materials.clothBlue
    );
    runner.position.set(0, 0.08, 0);

    for (const side of [-1, 1]) {
        const shield = add(
            MeshBuilder.CreateCylinder(
                `prop-shield-${room.id}-${side}`,
                { height: 0.055, diameter: 0.44, tessellation: 6 },
                runtime.scene
            ),
            side < 0 ? materials.clothCoral : materials.clothBlue
        );
        shield.position.set(side * (ROOM_SIZE / 2 - 0.08), 1.82, 0.76);
        shield.rotation.z = Math.PI / 2;
        shield.rotation.y = Math.PI / 2;
    }
}

function addStorageProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    for (const [index, offset] of [-0.52, 0.08, 0.56].entries()) {
        const crate = add(
            MeshBuilder.CreateBox(
                `prop-crate-${room.id}-${index}`,
                { width: 0.74, height: 0.56, depth: 0.68 },
                runtime.scene
            ),
            materials.wood
        );
        crate.position.set(offset * 1.9, 0.36, 1.02 - index * 0.68);
        crate.rotation.y = offset * 0.35;
    }
    for (const side of [-1, 1]) {
        const barrel = add(
            MeshBuilder.CreateCylinder(
                `prop-barrel-${room.id}-${side}`,
                { height: 0.74, diameter: 0.48, tessellation: 12 },
                runtime.scene
            ),
            materials.wood
        );
        barrel.position.set(side * 1.38, 0.46, -1.02);
    }
}

function addShrineProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const altar = add(
        MeshBuilder.CreateCylinder(
            `prop-altar-${room.id}`,
            { height: 0.74, diameter: 1.12, tessellation: 8 },
            runtime.scene
        ),
        materials.trim
    );
    altar.position.set(0, 0.48, 0);

    const sigil = add(
        MeshBuilder.CreateTorus(
            `prop-sigil-${room.id}`,
            { diameter: 1.38, thickness: 0.045, tessellation: 36 },
            runtime.scene
        ),
        materials.portal
    );
    sigil.position.set(0, 0.92, 0);
    sigil.rotation.x = Math.PI / 2;
}

function addTrapProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    for (let index = 0; index < 4; index += 1) {
        const spike = add(
            MeshBuilder.CreateCylinder(
                `prop-spike-${room.id}-${index}`,
                { height: 0.74, diameterBottom: 0.24, diameterTop: 0, tessellation: 4 },
                runtime.scene
            ),
            materials.metal
        );
        const angle = (Math.PI * 2 * index) / 4;
        spike.position.set(Math.cos(angle) * 0.88, 0.44, Math.sin(angle) * 0.88);
    }
    const warning = add(
        MeshBuilder.CreateBox(
            `prop-warning-${room.id}`,
            { width: 2.0, height: 0.025, depth: 2.0 },
            runtime.scene
        ),
        materials.clothCoral
    );
    warning.position.set(0, 0.09, 0);
    warning.rotation.y = Math.PI / 4;
}

function addTreasureProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const chest = add(
        MeshBuilder.CreateBox(
            `prop-chest-${room.id}`,
            { width: 1.18, height: 0.56, depth: 0.72 },
            runtime.scene
        ),
        materials.wood
    );
    chest.position.set(0, 0.4, 0.3);

    const lid = add(
        MeshBuilder.CreateBox(
            `prop-chest-lid-${room.id}`,
            { width: 1.22, height: 0.16, depth: 0.76 },
            runtime.scene
        ),
        materials.gold
    );
    lid.position.set(0, 0.74, 0.28);
    lid.rotation.x = -0.24;
}

function addMonsterProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const skull = add(
        MeshBuilder.CreateSphere(
            `prop-skull-${room.id}`,
            { diameter: 0.86, segments: 16 },
            runtime.scene
        ),
        materials.rubble
    );
    skull.position.set(0, 0.86, 0.54);
    skull.scaling.y = 0.76;

    for (const side of [-1, 1]) {
        const horn = add(
            MeshBuilder.CreateCylinder(
                `prop-horn-${room.id}-${side}`,
                { height: 0.74, diameterBottom: 0.17, diameterTop: 0.03, tessellation: 8 },
                runtime.scene
            ),
            materials.metal
        );
        horn.position.set(side * 0.44, 1.14, 0.48);
        horn.rotation.z = side * 0.65;
    }
}

function addExitProps(
    runtime: RoomRuntime,
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const gate = add(
        MeshBuilder.CreateTorus(
            `prop-gate-${room.id}`,
            { diameter: 1.9, thickness: 0.1, tessellation: 32 },
            runtime.scene
        ),
        materials.portal
    );
    gate.position.set(0, 1.54, ROOM_SIZE / 2 - 0.18);
    gate.rotation.x = Math.PI / 2;

    const threshold = add(
        MeshBuilder.CreateBox(
            `prop-threshold-${room.id}`,
            { width: 1.72, height: 0.04, depth: 1.12 },
            runtime.scene
        ),
        materials.gold
    );
    threshold.position.set(0, 0.1, ROOM_SIZE / 2 - 0.42);
}

function addHighFantasyRoomDecor(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const floorMotif = add(
        MeshBuilder.CreateTorus(
            `castle-floor-motif-${room.id}`,
            {
                diameter: room.kind === 'treasure' || room.kind === 'shrine' ? 2.6 : 2.05,
                thickness: 0.035,
                tessellation: 44
            },
            materials.gold.getScene()
        ),
        room.kind === 'monster' ? materials.crack : materials.gold
    );
    floorMotif.position.set(0, 0.13, 0);
    floorMotif.rotation.x = Math.PI / 2;

    const carpet = add(
        MeshBuilder.CreateBox(
            `castle-carpet-${room.id}`,
            {
                width: room.kind === 'hallway' ? 1.15 : 1.55,
                height: 0.026,
                depth: room.kind === 'hallway' ? ROOM_SIZE - 0.8 : 2.9
            },
            materials.clothBlue.getScene()
        ),
        room.kind === 'trap' || room.kind === 'monster' ? materials.clothCoral : materials.clothBlue
    );
    carpet.position.set(0, 0.105, 0);

    for (const side of [-1, 1]) {
        const tapestry = add(
            MeshBuilder.CreateBox(
                `castle-tapestry-${room.id}-${side}`,
                { width: 0.86, height: 1.55, depth: 0.04 },
                materials.clothCoral.getScene()
            ),
            side < 0 ? materials.clothBlue : materials.clothCoral
        );
        tapestry.position.set(side * (ROOM_SIZE / 2 - 0.08), 2.38, -0.62);
        tapestry.rotation.y = Math.PI / 2;

        const bench = add(
            MeshBuilder.CreateBox(
                `castle-bench-${room.id}-${side}`,
                { width: 0.42, height: 0.28, depth: 1.28 },
                materials.wood.getScene()
            ),
            materials.wood
        );
        bench.position.set(side * (ROOM_SIZE / 2 - 0.62), 0.28, 1.35);
    }

    const chandelier = add(
        MeshBuilder.CreateTorus(
            `castle-room-chandelier-${room.id}`,
            { diameter: 1.08, thickness: 0.035, tessellation: 28 },
            materials.metal.getScene()
        ),
        materials.metal
    );
    chandelier.position.set(0, CEILING_Y - 0.58, 0);
    chandelier.rotation.x = Math.PI / 2;
}

function addClueHotspot(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    for (const clue of roomClueHotspots(room)) {
        addInspectableHotspot(add, room, clue, materials);
    }
}

function addInspectableHotspot(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    clue: ClueHotspot,
    materials: CastleMaterials
): void {
    const markInspectable = (mesh: Mesh, resolvedOnly = false) => {
        mesh.metadata = {
            ...(mesh.metadata ?? {}),
            roomId: room.id,
            clueHotspotId: clue.id,
            primeAction: 'search',
            resolvedOnly
        };
        if (resolvedOnly) {
            mesh.isPickable = false;
            mesh.visibility = 0;
        }
        return mesh;
    };

    const ring = markInspectable(add(
        MeshBuilder.CreateTorus(
            `clue-ring-${clue.id}`,
            {
                diameter: room.kind === 'trap' && clue.id.endsWith('-plates') ? 1.42 : 0.58,
                thickness: 0.03,
                tessellation: 34
            },
            materials.portal.getScene()
        ),
        room.kind === 'treasure' ? materials.gold : materials.portal
    ));
    ring.position.set(clue.x, 0.18, clue.z);
    ring.rotation.x = Math.PI / 2;

    const focus = markInspectable(add(
        MeshBuilder.CreateSphere(
            `clue-focus-${clue.id}`,
            { diameter: room.kind === 'exit' ? 0.28 : 0.18, segments: 14 },
            materials.portal.getScene()
        ),
        room.kind === 'treasure' ? materials.gold : materials.portal
    ));
    focus.position.set(clue.x, room.kind === 'exit' ? 1.15 : 0.64, clue.z);

    const discovered = markInspectable(
        add(
            MeshBuilder.CreateTorus(
                `clue-discovered-${clue.id}`,
                { diameter: 0.42, thickness: 0.045, tessellation: 30 },
                materials.gold.getScene()
            ),
            materials.gold
        ),
        true
    );
    discovered.position.set(clue.x, 0.95, clue.z);
    discovered.rotation.x = Math.PI / 2;

    addHotspotProp(add, room, clue, materials, markInspectable);
}

function addHotspotProp(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    clue: ClueHotspot,
    materials: CastleMaterials,
    markInspectable: (mesh: Mesh, resolvedOnly?: boolean) => Mesh
): void {
    if (clue.id.endsWith('-crates')) {
        const lockbox = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-lockbox-${clue.id}`,
                { width: 0.42, height: 0.22, depth: 0.32 },
                materials.metal.getScene()
            ),
            materials.metal
        ));
        lockbox.position.set(clue.x - 0.22, 0.62, clue.z + 0.16);
        lockbox.rotation.y = 0.18;

        const parchment = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-parchment-${clue.id}`,
                { width: 0.58, height: 0.026, depth: 0.36 },
                materials.clothCoral.getScene()
            ),
            materials.clothCoral
        ));
        parchment.position.set(clue.x + 0.18, 0.72, clue.z - 0.14);
        parchment.rotation.y = -0.28;
    }

    if (clue.id.endsWith('-wax-seal')) {
        const ledger = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-ledger-${clue.id}`,
                { width: 0.5, height: 0.035, depth: 0.62 },
                materials.wood.getScene()
            ),
            materials.wood
        ));
        ledger.position.set(clue.x, 0.48, clue.z);
        ledger.rotation.y = 0.22;

        const seal = markInspectable(add(
            MeshBuilder.CreateCylinder(
                `clue-seal-${clue.id}`,
                { height: 0.03, diameter: 0.18, tessellation: 16 },
                materials.clothCoral.getScene()
            ),
            materials.clothCoral
        ));
        seal.position.set(clue.x + 0.08, 0.54, clue.z - 0.08);
        seal.rotation.x = Math.PI / 2;
    }

    if (clue.id.endsWith('-broken-crate')) {
        for (let index = 0; index < 3; index += 1) {
            const slat = markInspectable(add(
                MeshBuilder.CreateBox(
                    `clue-crate-slat-${clue.id}-${index}`,
                    { width: 0.46, height: 0.055, depth: 0.12 },
                    materials.wood.getScene()
                ),
                materials.wood
            ));
            slat.position.set(clue.x + index * 0.08, 0.28 + index * 0.08, clue.z);
            slat.rotation.y = -0.55 + index * 0.34;
            slat.rotation.z = 0.18;
        }
    }

    if (clue.id.endsWith('-altar') || clue.id.endsWith('-runes')) {
        for (let index = 0; index < 3; index += 1) {
            const rune = markInspectable(add(
                MeshBuilder.CreateBox(
                    `clue-rune-${clue.id}-${index}`,
                    { width: 0.08, height: 0.24, depth: 0.025 },
                    materials.portal.getScene()
                ),
                materials.portal
            ));
            rune.position.set(clue.x - 0.22 + index * 0.22, 1.0 + index * 0.08, clue.z);
            rune.rotation.z = -0.4 + index * 0.4;
        }
    }

    if (clue.id.endsWith('-rune-wall')) {
        for (let index = 0; index < 4; index += 1) {
            const rune = markInspectable(add(
                MeshBuilder.CreateBox(
                    `clue-wall-rune-${clue.id}-${index}`,
                    { width: 0.08, height: 0.28, depth: 0.026 },
                    materials.portal.getScene()
                ),
                materials.portal
            ));
            rune.position.set(clue.x + index * 0.12, 1.16 + index * 0.08, clue.z);
            rune.rotation.z = -0.48 + index * 0.26;
        }
    }

    if (clue.id.endsWith('-cracked-statue')) {
        const statue = markInspectable(add(
            MeshBuilder.CreateCylinder(
                `clue-cracked-statue-${clue.id}`,
                { height: 0.78, diameterTop: 0.26, diameterBottom: 0.44, tessellation: 7 },
                materials.rubble.getScene()
            ),
            materials.rubble
        ));
        statue.position.set(clue.x, 0.54, clue.z);
        const crack = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-statue-crack-${clue.id}`,
                { width: 0.035, height: 0.58, depth: 0.026 },
                materials.portal.getScene()
            ),
            materials.portal
        ));
        crack.position.set(clue.x + 0.04, 0.64, clue.z - 0.16);
        crack.rotation.z = 0.18;
    }

    if (clue.id.endsWith('-plates')) {
        for (let index = 0; index < 4; index += 1) {
            const plate = markInspectable(add(
                MeshBuilder.CreateBox(
                    `clue-pressure-plate-${clue.id}-${index}`,
                    { width: 0.58, height: 0.028, depth: 0.58 },
                    materials.metal.getScene()
                ),
                index % 2 === 0 ? materials.metal : materials.crack
            ));
            plate.position.set(
                index % 2 === 0 ? -0.35 : 0.35,
                0.14,
                index < 2 ? -0.35 : 0.35
            );
        }
    }

    if (clue.id.endsWith('-wall-scratches')) {
        for (let index = 0; index < 3; index += 1) {
            const scratch = markInspectable(add(
                MeshBuilder.CreateBox(
                    `clue-trap-scratch-${clue.id}-${index}`,
                    { width: 0.72, height: 0.018, depth: 0.035 },
                    materials.crack.getScene()
                ),
                materials.crack
            ));
            scratch.position.set(-0.65 + index * 0.54, 0.17, -1.05);
            scratch.rotation.y = -0.45 + index * 0.25;
        }
    }

    if (clue.id.endsWith('-loose-tile')) {
        const tile = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-loose-tile-${clue.id}`,
                { width: 0.62, height: 0.035, depth: 0.62 },
                materials.trim.getScene()
            ),
            materials.trim
        ));
        tile.position.set(clue.x, 0.15, clue.z);
        tile.rotation.y = 0.18;
        tile.rotation.z = 0.04;
    }

    if (clue.id.endsWith('-mirror')) {
        const plaque = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-mirror-plaque-${clue.id}`,
                { width: 0.64, height: 0.5, depth: 0.045 },
                materials.metal.getScene()
            ),
            materials.metal
        ));
        plaque.position.set(clue.x, 1.18, clue.z);
        plaque.rotation.y = -0.34;
    }

    if (clue.id.endsWith('-coin-trail')) {
        for (let index = 0; index < 5; index += 1) {
            const coin = markInspectable(add(
                MeshBuilder.CreateCylinder(
                    `clue-coin-trail-${clue.id}-${index}`,
                    { height: 0.026, diameter: 0.16, tessellation: 14 },
                    materials.gold.getScene()
                ),
                materials.gold
            ));
            coin.position.set(clue.x - 0.48 + index * 0.22, 0.16, clue.z + (index % 2) * 0.12);
            coin.rotation.x = Math.PI / 2;
        }
    }

    if (clue.id.endsWith('-chest')) {
        const latch = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-chest-latch-${clue.id}`,
                { width: 0.2, height: 0.18, depth: 0.06 },
                materials.gold.getScene()
            ),
            materials.gold
        ));
        latch.position.set(clue.x, 0.74, clue.z - 0.38);
    }

    if (clue.id.endsWith('-bone-altar')) {
        for (const side of [-1, 1]) {
            const chain = markInspectable(add(
                MeshBuilder.CreateTorus(
                    `clue-chain-link-${clue.id}-${side}`,
                    { diameter: 0.34, thickness: 0.035, tessellation: 16 },
                    materials.metal.getScene()
                ),
                materials.metal
            ));
            chain.position.set(side * 0.54, 0.92, clue.z - 0.16);
            chain.rotation.x = Math.PI / 2;

            const bone = markInspectable(add(
                MeshBuilder.CreateCylinder(
                    `clue-bone-${clue.id}-${side}`,
                    { height: 0.62, diameter: 0.08, tessellation: 8 },
                    materials.rubble.getScene()
                ),
                materials.rubble
            ));
            bone.position.set(side * 0.36, 0.28, clue.z + 0.5);
            bone.rotation.z = side * 0.88;
            bone.rotation.x = 0.42;
        }
    }

    if (clue.id.endsWith('-claw-marks')) {
        for (let index = 0; index < 4; index += 1) {
            const mark = markInspectable(add(
                MeshBuilder.CreateBox(
                    `clue-claw-mark-${clue.id}-${index}`,
                    { width: 0.58, height: 0.026, depth: 0.035 },
                    materials.crack.getScene()
                ),
                materials.crack
            ));
            mark.position.set(clue.x, 1.15 + index * 0.12, clue.z + index * 0.035);
            mark.rotation.y = 0.65;
            mark.rotation.z = -0.28;
        }
    }

    if (clue.id.endsWith('-ash-pile')) {
        const ash = markInspectable(add(
            MeshBuilder.CreateCylinder(
                `clue-ash-pile-${clue.id}`,
                { height: 0.12, diameterTop: 0.68, diameterBottom: 0.86, tessellation: 12 },
                materials.rubble.getScene()
            ),
            materials.rubble
        ));
        ash.position.set(clue.x, 0.16, clue.z);
        ash.scaling.y = 0.45;
    }

    if (clue.id.endsWith('-daylight-slit')) {
        const daylight = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-daylight-slit-${clue.id}`,
                { width: 0.2, height: 1.15, depth: 0.035 },
                materials.portal.getScene()
            ),
            materials.portal
        ));
        daylight.position.set(clue.x, 1.82, clue.z + 0.16);
    }

    if (clue.id.endsWith('-threshold')) {
        const glyph = markInspectable(add(
            MeshBuilder.CreateTorus(
                `clue-threshold-glyph-${clue.id}`,
                { diameter: 0.52, thickness: 0.035, tessellation: 26 },
                materials.portal.getScene()
            ),
            materials.portal
        ));
        glyph.position.set(clue.x, 0.16, clue.z);
        glyph.rotation.x = Math.PI / 2;
    }

    if (room.kind === 'hallway' || room.kind === 'entrance') {
        const chalk = markInspectable(add(
            MeshBuilder.CreateBox(
                `clue-chalk-${clue.id}`,
                { width: 0.62, height: 0.022, depth: 0.08 },
                materials.portal.getScene()
            ),
            materials.portal
        ));
        chalk.position.set(clue.x, 0.16, clue.z);
        chalk.rotation.y = 0.5;
    }
}

function addStoneCourseDetail(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const courses = [0.9, 1.55, 2.2, 2.85, 3.5, 4.15];
    for (const y of courses) {
        for (const direction of ['north', 'south'] as const) {
            const seam = add(
                MeshBuilder.CreateBox(
                    `stone-course-${room.id}-${direction}-${y}`,
                    { width: ROOM_SIZE - 0.65, height: 0.018, depth: 0.018 },
                    materials.crack.getScene()
                ),
                materials.crack
            );
            seam.position.set(0, y, direction === 'north' ? -ROOM_SIZE / 2 + 0.095 : ROOM_SIZE / 2 - 0.095);
        }
        for (const direction of ['east', 'west'] as const) {
            const seam = add(
                MeshBuilder.CreateBox(
                    `stone-course-${room.id}-${direction}-${y}`,
                    { width: 0.018, height: 0.018, depth: ROOM_SIZE - 0.65 },
                    materials.crack.getScene()
                ),
                materials.crack
            );
            seam.position.set(direction === 'west' ? -ROOM_SIZE / 2 + 0.095 : ROOM_SIZE / 2 - 0.095, y, 0);
        }
    }

    for (let index = 0; index < 12; index += 1) {
        const side = index % 4;
        const offset = -ROOM_SIZE / 2 + 0.86 + (index % 3) * 1.9;
        const y = 1.18 + Math.floor(index / 4) * 0.96;
        const vertical = add(
            MeshBuilder.CreateBox(
                `stone-vertical-joint-${room.id}-${index}`,
                {
                    width: side < 2 ? 0.018 : 0.022,
                    height: 0.5,
                    depth: side < 2 ? 0.022 : 0.018
                },
                materials.crack.getScene()
            ),
            materials.crack
        );

        if (side === 0 || side === 1) {
            vertical.position.set(offset, y, side === 0 ? -ROOM_SIZE / 2 + 0.092 : ROOM_SIZE / 2 - 0.092);
        }
        else {
            vertical.position.set(side === 2 ? -ROOM_SIZE / 2 + 0.092 : ROOM_SIZE / 2 - 0.092, y, offset);
        }
    }
}

function addCastleCracks(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const crackCount = room.kind === 'trap' || room.kind === 'monster' || room.unstable ? 4 : 2;
    for (let index = 0; index < crackCount; index += 1) {
        const floorCrack = add(
            MeshBuilder.CreateBox(
                `castle-floor-crack-${room.id}-${index}`,
                { width: 0.72 - index * 0.08, height: 0.018, depth: 0.035 },
                materials.crack.getScene()
            ),
            materials.crack
        );
        floorCrack.position.set(-0.62 + index * 0.42, 0.105, -0.48 + index * 0.22);
        floorCrack.rotation.y = index * 0.68;

        if (index < 2) {
            const ceilingCrack = add(
                MeshBuilder.CreateBox(
                    `castle-ceiling-crack-${room.id}-${index}`,
                    { width: 0.56, height: 0.02, depth: 0.035 },
                    materials.crack.getScene()
                ),
                materials.crack
            );
            ceilingCrack.position.set(0.34 - index * 0.62, CEILING_Y - 0.22, 0.34 + index * 0.28);
            ceilingCrack.rotation.y = -0.5 + index * 0.85;
        }
    }
}

function addCastleDoorLight(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const side = room.kind === 'exit' ? 1 : -1;
    for (const x of [-0.8, 0.8]) {
        const bracket = add(
            MeshBuilder.CreateCylinder(
                `castle-torch-bracket-${room.id}-${x}`,
                { height: 0.34, diameter: 0.045, tessellation: 8 },
                materials.wood.getScene()
            ),
            materials.wood
        );
        bracket.position.set(x, 1.26, side * (ROOM_SIZE / 2 - 0.08));
        bracket.rotation.x = Math.PI / 2;
    }
}

function addRubblePile(
    add: (mesh: Mesh, material?: PBRMaterial) => Mesh,
    room: RelicRoom,
    materials: CastleMaterials
): void {
    const count = room.collapsed || room.unstable ? 8 : 4;
    for (let index = 0; index < count; index += 1) {
        const stone = add(
            MeshBuilder.CreateBox(
                `castle-rubble-${room.id}-${index}`,
                {
                    width: 0.16 + (index % 2) * 0.08,
                    height: 0.1 + (index % 3) * 0.035,
                    depth: 0.15 + (index % 4) * 0.035
                },
                materials.rubble.getScene()
            ),
            materials.rubble
        );
        const corner = index % 2 === 0 ? -1 : 1;
        stone.position.set(
            corner * (ROOM_SIZE / 2 - 0.42 - (index % 3) * 0.12),
            0.12 + (index % 3) * 0.02,
            (index < count / 2 ? -1 : 1) * (ROOM_SIZE / 2 - 0.38 - (index % 2) * 0.16)
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
    texture: DynamicTexture
): readonly ParticleSystem[] {
    const world = roomWorldPosition(room);
    const side = room.kind === 'exit' ? 1 : -1;
    const particles: ParticleSystem[] = [];

    // Wall torch flames (matching addCastleDoorLight positions)
    for (const x of [-0.8, 0.8]) {
        const pos = new Vector3(world.x + x, 1.48, world.z + side * (ROOM_SIZE / 2 - 0.14));
        particles.push(spawnTorchFlame(scene, pos, texture, false));
    }

    particles.push(spawnTorchFlame(
        scene,
        new Vector3(world.x, CEILING_Y - 0.68, world.z),
        texture,
        true
    ));

    return particles;
}

export function createRoomAtmosphereParticles(
    scene: Scene,
    room: RelicRoom,
    flameTexture: DynamicTexture
): readonly ParticleSystem[] {
    const world = roomWorldPosition(room);
    switch (room.kind) {
        case 'shrine':
            return [
                spawnAtmoSystem(
                    scene,
                    `shrine-orbs-${room.id}`,
                    world,
                    new Vector3(1.0, 0.4, 1.0),
                    new Color4(0.68, 0.28, 1.0, 0.78),
                    new Color4(0.9, 0.6, 1.0, 0.55),
                    new Color4(0.4, 0.1, 0.8, 0),
                    0.11,
                    0.21,
                    3.8,
                    5.8,
                    3,
                    new Vector3(-0.05, 0.28, -0.05),
                    new Vector3(0.05, 0.55, 0.05),
                    0.04,
                    0.11,
                    new Vector3(0, -0.018, 0),
                    flameTexture
                )
            ];
        case 'monster':
            return [
                spawnAtmoSystem(
                    scene,
                    `monster-wisps-${room.id}`,
                    world,
                    new Vector3(1.5, 0.1, 1.5),
                    new Color4(0.55, 0.06, 0.06, 0.52),
                    new Color4(0.3, 0.08, 0.06, 0.35),
                    new Color4(0.06, 0.02, 0.02, 0),
                    0.22,
                    0.42,
                    2.8,
                    4.5,
                    3,
                    new Vector3(-0.04, 0.12, -0.04),
                    new Vector3(0.04, 0.28, 0.04),
                    0.03,
                    0.08,
                    new Vector3(0, -0.006, 0),
                    flameTexture
                )
            ];
        case 'treasure':
            return [
                spawnAtmoSystem(
                    scene,
                    `treasure-sparks-${room.id}`,
                    new Vector3(world.x, world.y + 0.45, world.z + 0.3),
                    new Vector3(0.5, 0.5, 0.4),
                    new Color4(1.0, 0.88, 0.22, 0.92),
                    new Color4(1.0, 0.7, 0.14, 0.72),
                    new Color4(0.8, 0.5, 0.08, 0),
                    0.04,
                    0.09,
                    0.9,
                    2.0,
                    12,
                    new Vector3(-0.12, 0.5, -0.1),
                    new Vector3(0.12, 1.2, 0.1),
                    0.08,
                    0.24,
                    new Vector3(0, -0.38, 0),
                    flameTexture
                )
            ];
        case 'exit':
            return [
                spawnAtmoSystem(
                    scene,
                    `exit-beams-${room.id}`,
                    new Vector3(world.x, world.y + 0.2, world.z + ROOM_SIZE / 2 - 0.5),
                    new Vector3(0.8, 0.2, 0.2),
                    new Color4(0.68, 0.96, 1.0, 0.76),
                    new Color4(0.85, 1.0, 1.0, 0.55),
                    new Color4(0.5, 0.8, 1.0, 0),
                    0.06,
                    0.14,
                    1.6,
                    3.2,
                    6,
                    new Vector3(-0.04, 1.0, -0.04),
                    new Vector3(0.04, 2.2, 0.04),
                    0.1,
                    0.28,
                    new Vector3(0, -0.04, 0),
                    flameTexture
                )
            ];
        default:
            return [];
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
    texture: DynamicTexture
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
    small: boolean
): ParticleSystem {
    const system = new ParticleSystem(
        `torch-flame-${position.x.toFixed(1)}-${position.y.toFixed(1)}-${position.z.toFixed(1)}-${Date.now()}`,
        small ? 18 : 36,
        scene
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
    system.emitRate = small ? 28 : 54;

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

// --- Japanese castle lobby scene ---

function jpMaterial(
    scene: Scene,
    name: string,
    hex: string,
    emissiveScale: number,
    metallic: number,
    roughness: number
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

    const matDarkWood = jpMaterial(scene, 'dark-wood', '#765039', 0.020, 0, 0.62);
    const matRedLacquer = jpMaterial(scene, 'red-lacquer', '#b8402f', 0.07, 0, 0.42);
    const matStone = jpMaterial(scene, 'stone', '#9aa69b', 0.012, 0.02, 0.90);
    const matGold = jpMaterial(scene, 'gold', '#e3b44b', 0.16, 0.72, 0.28);
    const matShoji = jpMaterial(scene, 'shoji', '#f5e8cc', 0.36, 0, 0.96);
    const matLanternRed = jpMaterial(scene, 'lantern-red', '#ff4010', 0.88, 0, 0.92);
    const matLanternAmb = jpMaterial(scene, 'lantern-amb', '#ffb030', 0.72, 0, 0.90);
    const matCrimson = jpMaterial(scene, 'crimson', '#c95142', 0.055, 0, 0.82);
    const matNavy = jpMaterial(scene, 'navy', '#416b82', 0.035, 0, 0.80);
    const matWhiteWall = jpMaterial(scene, 'white-wall', '#f2ead4', 0.05, 0, 0.90);
    const matDarkCeiling = jpMaterial(scene, 'dark-ceil', '#806046', 0.012, 0, 0.84);
    const matAltarWood = jpMaterial(scene, 'altar-wood', '#8a6541', 0.045, 0, 0.52);

    // Surface enhancements for the lobby
    const { stoneNormal, woodNormal, metalNormal } = createCastleSurfaceTextures(scene);

    // Dark polished wood — grain lines + high-gloss lacquer coat
    applyNormalMap(matDarkWood, woodNormal, 1, 5);
    applyNormalMap(matAltarWood, woodNormal, 1, 4, 0.8);
    // Red lacquer — signature Japanese wet-lacquer finish
    applyClearCoat(matRedLacquer, 0.95, 0.04);
    applyNormalMap(matRedLacquer, woodNormal, 1, 5, 0.4);
    // Gold — mirror-like metallic coat
    applyClearCoat(matGold, 0.90, 0.06);
    applyNormalMap(matGold, metalNormal, 2, 2, 0.3);
    // Stone — mortar-joint bump
    applyNormalMap(matStone, stoneNormal, 3, 3);
    applyNormalMap(matWhiteWall, stoneNormal, 3, 3, 0.55);
    // Shoji paper — soft translucent sheen like rice paper
    applySheen(matShoji, 0.65, 0.85);
    // Silk hangings — woven micro-fibre sheen
    applySheen(matCrimson, 0.82, 0.65);
    applySheen(matNavy, 0.82, 0.65);

    // === FLOOR: dark polished wood ===
    add(MeshBuilder.CreateBox('jl-floor', { width: 14, height: 0.14, depth: 26 }, scene), matDarkWood)
        .position.set(0, FLOOR_Y, 0);

    // Gold tatami border
    for (
        const [fw, fd, fx, fz] of [
            [14, 0.36, 0, -12.8],
            [14, 0.36, 0, 12.8],
            [0.36, 26, -6.9, 0],
            [0.36, 26, 6.9, 0]
        ] as [number, number, number, number][]
    ) {
        add(
            MeshBuilder.CreateBox(`jl-tatami-border-${fx}-${fz}`, { width: fw, height: 0.05, depth: fd }, scene),
            matGold
        )
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
        add(
            MeshBuilder.CreateBox(`jl-wall-plaster-${side}`, { width: 0.22, height: 2.3, depth: 26 }, scene),
            matWhiteWall
        )
            .position.set(side * 6.95, 1.15, 0);
        // Upper dark timber
        add(MeshBuilder.CreateBox(`jl-wall-timber-${side}`, { width: 0.2, height: 2.7, depth: 26 }, scene), matDarkWood)
            .position.set(side * 6.95, 3.65, 0);
        // Red lacquer divider rail
        add(
            MeshBuilder.CreateBox(`jl-wall-rail-${side}`, { width: 0.24, height: 0.13, depth: 26 }, scene),
            matRedLacquer
        )
            .position.set(side * 6.95, 2.35, 0);

        // Shoji panels (backlit warm glow) – 6 pairs
        for (let i = 0; i < 6; i++) {
            const z = -10 + i * 4;
            add(
                MeshBuilder.CreateBox(`jl-shoji-${side}-${i}`, { width: 0.05, height: 1.9, depth: 2.8 }, scene),
                matShoji
            )
                .position.set(side * 6.92, 2.6, z);
        }

        // Vertical divider posts between shoji panels
        for (let i = 0; i <= 6; i++) {
            const z = -12 + i * 4;
            add(
                MeshBuilder.CreateBox(`jl-shoji-post-${side}-${i}`, { width: 0.12, height: 2.2, depth: 0.12 }, scene),
                matDarkWood
            )
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
        add(
            MeshBuilder.CreateBox(`jl-gate-post-${side}`, { width: 0.34, height: 4.6, depth: 0.34 }, scene),
            matDarkWood
        )
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
            add(
                MeshBuilder.CreateCylinder(
                    `jl-pillar-${side}-${i}`,
                    { height: 4.9, diameter: 0.46, tessellation: 14 },
                    scene
                ),
                matRedLacquer
            )
                .position.set(side * 4.2, 2.45, z);
            // Stone base pedestal
            add(
                MeshBuilder.CreateBox(`jl-pillar-base-${side}-${i}`, { width: 0.66, height: 0.2, depth: 0.66 }, scene),
                matStone
            )
                .position.set(side * 4.2, FLOOR_Y + 0.1, z);
            // Gold bracket cap (斗)
            add(
                MeshBuilder.CreateBox(`jl-pillar-cap-${side}-${i}`, { width: 0.72, height: 0.26, depth: 0.72 }, scene),
                matGold
            )
                .position.set(side * 4.2, CEILING_Y - 0.3, z);
            // Arm brace (肘木 — horizontal arm from cap)
            add(
                MeshBuilder.CreateBox(`jl-pillar-arm-${side}-${i}`, { width: 1.4, height: 0.14, depth: 0.34 }, scene),
                matDarkWood
            )
                .position.set(side * 4.2, CEILING_Y - 0.18, z);
        }
    }

    // === TORII GATE (大鳥居) at rear, z ≈ 11.0 ===
    const toriiZ = 11.0;
    for (const side of [-1, 1]) {
        // Main pillar
        add(
            MeshBuilder.CreateCylinder(
                `jl-torii-post-${side}`,
                { height: 4.8, diameter: 0.4, tessellation: 14 },
                scene
            ),
            matRedLacquer
        )
            .position.set(side * 2.6, 2.4, toriiZ);
        // Cap sphere at top
        add(MeshBuilder.CreateSphere(`jl-torii-cap-${side}`, { diameter: 0.46, segments: 10 }, scene), matRedLacquer)
            .position.set(side * 2.6, 4.86, toriiZ);
    }
    // Kasagi (top beam) — slight upward curve at ends via angled end caps
    add(MeshBuilder.CreateBox('jl-torii-kasagi', { width: 5.9, height: 0.3, depth: 0.35 }, scene), matRedLacquer)
        .position.set(0, 4.82, toriiZ);
    for (const side of [-1, 1]) {
        const endPiece = add(
            MeshBuilder.CreateBox(`jl-torii-kasagi-end-${side}`, { width: 0.44, height: 0.22, depth: 0.32 }, scene),
            matRedLacquer
        );
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
        add(
            MeshBuilder.CreateCylinder(`${n}-umbrella`, {
                height: 0.22,
                diameterTop: 0.1,
                diameterBottom: 0.64,
                tessellation: 6
            }, scene),
            matStone
        )
            .position.set(lx, 1.52, lz);
        add(MeshBuilder.CreateSphere(`${n}-finial`, { diameter: 0.12, segments: 6 }, scene), matStone)
            .position.set(lx, 1.7, lz);
    }

    // === HANGING CHŌCHIN 提灯 (7 paper lanterns) ===
    const chochinPos: [number, number, number][] = [
        [0, 4.32, -8],
        [-3.0, 4.24, -4],
        [3.0, 4.24, -4],
        [0, 4.36, 0],
        [-3.0, 4.28, 4],
        [3.0, 4.28, 4],
        [0, 4.32, 9]
    ];
    for (let i = 0; i < chochinPos.length; i++) {
        const [x, y, z] = chochinPos[i];
        const n = `jl-chochin-${i}`;
        // Cord
        add(
            MeshBuilder.CreateCylinder(`${n}-cord`, { height: 0.5, diameter: 0.018, tessellation: 4 }, scene),
            matDarkWood
        )
            .position.set(x, y + 0.25, z);
        // Lantern body (oblate sphere, alternating red/amber)
        const lanternMesh = add(
            MeshBuilder.CreateSphere(`${n}-body`, { diameter: 0.46, segments: 10 }, scene),
            i % 2 === 0 ? matLanternRed : matLanternAmb
        );
        lanternMesh.position.set(x, y, z);
        lanternMesh.scaling.set(1, 1.38, 1);
        // Tassel (tiny inverted cone)
        add(
            MeshBuilder.CreateCylinder(`${n}-tassel`, {
                height: 0.16,
                diameterTop: 0.0,
                diameterBottom: 0.06,
                tessellation: 6
            }, scene),
            matRedLacquer
        )
            .position.set(x, y - 0.34, z);
        // Top rim ring
        add(
            MeshBuilder.CreateTorus(`${n}-ring`, { diameter: 0.12, thickness: 0.025, tessellation: 10 }, scene),
            matDarkWood
        )
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
    add(
        MeshBuilder.CreateCylinder('jl-altar-vessel-tray', { height: 0.12, diameter: 0.56, tessellation: 8 }, scene),
        matGold
    )
        .position.set(0, 0.75, altarZ);
    add(
        MeshBuilder.CreateCylinder('jl-altar-vessel-stem', { height: 0.28, diameter: 0.12, tessellation: 8 }, scene),
        matGold
    )
        .position.set(0, 0.97, altarZ);
    add(
        MeshBuilder.CreateCylinder('jl-altar-vessel-bowl', {
            height: 0.24,
            diameterTop: 0.54,
            diameterBottom: 0.36,
            tessellation: 8
        }, scene),
        matGold
    )
        .position.set(0, 1.18, altarZ);
    // Flanking candles
    for (const cx of [-1.4, 1.4]) {
        add(
            MeshBuilder.CreateCylinder(`jl-candle-${cx}`, { height: 0.34, diameter: 0.08, tessellation: 6 }, scene),
            matShoji
        )
            .position.set(cx, 0.79, altarZ);
        // Flame sphere
        const flame = add(
            MeshBuilder.CreateSphere(`jl-flame-${cx}`, { diameter: 0.12, segments: 6 }, scene),
            matLanternAmb
        );
        flame.position.set(cx, 1.0, altarZ);
        flame.scaling.set(1, 1.4, 1);
    }
    // Side offering vases
    for (const vx of [-2.2, 2.2]) {
        add(
            MeshBuilder.CreateCylinder(`jl-vase-${vx}`, {
                height: 0.42,
                diameterTop: 0.26,
                diameterBottom: 0.18,
                tessellation: 8
            }, scene),
            matGold
        )
            .position.set(vx, 0.84, altarZ);
    }

    // === HANGING BANNERS on side walls ===
    for (
        const [bside, bz, bmat] of [
            [-1, -9, matCrimson],
            [1, -9, matNavy],
            [-1, -1, matNavy],
            [1, -1, matCrimson],
            [-1, 7, matCrimson],
            [1, 7, matNavy]
        ] as [number, number, PBRMaterial][]
    ) {
        add(MeshBuilder.CreateBox(`jl-banner-${bside}-${bz}`, { width: 0.04, height: 2.2, depth: 0.88 }, scene), bmat)
            .position.set(bside * 6.8, 3.1, bz);
    }
    // Back wall center banner
    add(MeshBuilder.CreateBox('jl-center-banner', { width: 1.8, height: 0.04, depth: 3.2 }, scene), matCrimson)
        .position.set(0, 3.5, 12.8);

    // === MOON WINDOW 円窓 on back wall ===
    const moonRing = add(
        MeshBuilder.CreateTorus('jl-moon-window', { diameter: 2.0, thickness: 0.11, tessellation: 36 }, scene),
        matGold
    );
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
            add(
                MeshBuilder.CreateBox(`jl-boss-${side}-${i}`, { width: 0.36, height: 0.18, depth: 0.36 }, scene),
                matGold
            )
                .position.set(side * 3.4, CEILING_Y - 0.04, z);
        }
    }

    return meshes;
}
