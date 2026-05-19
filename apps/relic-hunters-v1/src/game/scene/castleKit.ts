import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { CardinalDirection } from './types.ts';

export type CastleKitMaterialRole =
    | 'stone'
    | 'plaster'
    | 'wood'
    | 'roofTile'
    | 'lacquer'
    | 'metal'
    | 'gold'
    | 'paper'
    | 'foliage'
    | 'water'
    | 'lantern'
    | 'accentBlue'
    | 'accentCoral'
    | 'crack'
    | 'rubble'
    | 'portal';

export type CastleKitPalette = Readonly<Record<CastleKitMaterialRole, PBRMaterial>>;

export type CastleWallSegmentPlan = Readonly<{
    name: string;
    position: Readonly<{ x: number; z: number }>;
    size: Readonly<{ width: number; depth: number }>;
    direction: CardinalDirection;
    hasDoor: boolean;
}>;

export type CastleKitContext = Readonly<{
    scene: Scene;
    add(mesh: Mesh, material?: PBRMaterial): Mesh;
    materials: CastleKitPalette;
    prefix: string;
    roomSize: number;
    wallHeight: number;
    wallThickness: number;
    doorWidth: number;
    floorY: number;
    ceilingY: number;
}>;

export function planCastleWallSegments({
    direction,
    hasDoor,
    roomSize,
    wallThickness,
    doorWidth,
}: Readonly<{
    direction: CardinalDirection;
    hasDoor: boolean;
    roomSize: number;
    wallThickness: number;
    doorWidth: number;
}>): readonly CastleWallSegmentPlan[] {
    const northSouth = direction === 'north' || direction === 'south';
    const sign = direction === 'north' || direction === 'west' ? -1 : 1;
    const wallPosition = sign * roomSize / 2;

    if (!hasDoor) {
        return [{
            name: `${direction}-full`,
            direction,
            hasDoor,
            position: {
                x: northSouth ? 0 : wallPosition,
                z: northSouth ? wallPosition : 0,
            },
            size: {
                width: northSouth ? roomSize + wallThickness : wallThickness,
                depth: northSouth ? wallThickness : roomSize + wallThickness,
            },
        }];
    }

    const segmentLength = (roomSize - doorWidth) / 2;
    return [-1, 1].map((side) => {
        const offset = side * (doorWidth / 2 + segmentLength / 2);
        return {
            name: `${direction}-${side < 0 ? 'left' : 'right'}`,
            direction,
            hasDoor,
            position: {
                x: northSouth ? offset : wallPosition,
                z: northSouth ? wallPosition : offset,
            },
            size: {
                width: northSouth ? segmentLength : wallThickness,
                depth: northSouth ? wallThickness : segmentLength,
            },
        };
    });
}

export function buildStoneBase(ctx: CastleKitContext): readonly Mesh[] {
    const meshes: Mesh[] = [];
    meshes.push(addBox(
        ctx,
        'stone-base',
        {
            width: ctx.roomSize + 0.82,
            height: 0.22,
            depth: ctx.roomSize + 0.82,
        },
        'stone',
        new Vector3(0, -0.08, 0),
    ));
    for (const side of [-1, 1]) {
        meshes.push(addBox(
            ctx,
            `floor-border-ns-${side}`,
            { width: ctx.roomSize + 0.5, height: 0.06, depth: 0.24 },
            'lacquer',
            new Vector3(0, 0.08, side * (ctx.roomSize / 2 - 0.22)),
        ));
        meshes.push(addBox(
            ctx,
            `floor-border-ew-${side}`,
            { width: 0.24, height: 0.06, depth: ctx.roomSize + 0.5 },
            'lacquer',
            new Vector3(side * (ctx.roomSize / 2 - 0.22), 0.08, 0),
        ));
    }
    return meshes;
}

export function buildCastleWall(
    ctx: CastleKitContext,
    direction: CardinalDirection,
    hasDoor: boolean,
): readonly Mesh[] {
    const meshes: Mesh[] = [];
    const segments = planCastleWallSegments({
        direction,
        hasDoor,
        roomSize: ctx.roomSize,
        wallThickness: ctx.wallThickness,
        doorWidth: ctx.doorWidth,
    });

    for (const segment of segments) {
        const position = new Vector3(segment.position.x, ctx.wallHeight / 2, segment.position.z);
        meshes.push(addBox(
            ctx,
            `plaster-wall-${segment.name}`,
            {
                width: segment.size.width,
                height: ctx.wallHeight,
                depth: segment.size.depth,
            },
            'plaster',
            position,
        ));
        meshes.push(...buildWallRails(ctx, segment));
    }

    if (hasDoor) {
        meshes.push(...buildDoorFrame(ctx, direction));
    }

    return meshes;
}

export function buildCeilingGrid(ctx: CastleKitContext): readonly Mesh[] {
    const meshes: Mesh[] = [];
    meshes.push(addBox(
        ctx,
        'ceiling-roof-tile',
        { width: ctx.roomSize + 0.34, height: 0.16, depth: ctx.roomSize + 0.34 },
        'roofTile',
        new Vector3(0, ctx.ceilingY, 0),
    ));

    for (const offset of [-ctx.roomSize * 0.32, 0, ctx.roomSize * 0.32]) {
        meshes.push(addBox(
            ctx,
            `ceiling-rafter-ns-${offset.toFixed(1)}`,
            { width: 0.22, height: 0.26, depth: ctx.roomSize + 0.46 },
            'wood',
            new Vector3(offset, ctx.ceilingY - 0.18, 0),
        ));
        meshes.push(addBox(
            ctx,
            `ceiling-rafter-ew-${offset.toFixed(1)}`,
            { width: ctx.roomSize + 0.46, height: 0.22, depth: 0.22 },
            'wood',
            new Vector3(0, ctx.ceilingY - 0.16, offset),
        ));
    }

    for (const side of [-1, 1]) {
        meshes.push(addBox(
            ctx,
            `roof-eave-ns-${side}`,
            { width: ctx.roomSize + 0.9, height: 0.28, depth: 0.58 },
            'roofTile',
            new Vector3(0, ctx.ceilingY + 0.04, side * (ctx.roomSize / 2 + 0.18)),
        ));
        meshes.push(addBox(
            ctx,
            `roof-eave-ew-${side}`,
            { width: 0.58, height: 0.28, depth: ctx.roomSize + 0.9 },
            'roofTile',
            new Vector3(side * (ctx.roomSize / 2 + 0.18), ctx.ceilingY + 0.04, 0),
        ));
    }

    return meshes;
}

export function buildTimberColumns(ctx: CastleKitContext): readonly Mesh[] {
    const meshes: Mesh[] = [];
    for (const x of [-1, 1]) {
        for (const z of [-1, 1]) {
            const post = ctx.add(MeshBuilder.CreateCylinder(
                `${ctx.prefix}-lacquer-column-${x}-${z}`,
                { height: ctx.wallHeight, diameter: 0.34, tessellation: 10 },
                ctx.scene,
            ), ctx.materials.lacquer);
            post.position.set(
                x * (ctx.roomSize / 2 - 0.34),
                ctx.wallHeight / 2,
                z * (ctx.roomSize / 2 - 0.34),
            );
            meshes.push(post);
            meshes.push(addBox(
                ctx,
                `column-base-${x}-${z}`,
                { width: 0.62, height: 0.16, depth: 0.62 },
                'stone',
                new Vector3(
                    x * (ctx.roomSize / 2 - 0.34),
                    0.08,
                    z * (ctx.roomSize / 2 - 0.34),
                ),
            ));
            meshes.push(addBox(
                ctx,
                `column-cap-${x}-${z}`,
                { width: 0.7, height: 0.22, depth: 0.7 },
                'gold',
                new Vector3(
                    x * (ctx.roomSize / 2 - 0.34),
                    ctx.wallHeight - 0.18,
                    z * (ctx.roomSize / 2 - 0.34),
                ),
            ));
        }
    }
    return meshes;
}

export function buildLanternPair(
    ctx: CastleKitContext,
    side: 'north' | 'south',
): readonly Mesh[] {
    const z = side === 'north' ? -ctx.roomSize / 2 + 0.58 : ctx.roomSize / 2 - 0.58;
    return [-1.6, 1.6].flatMap((x) => buildLanternPost(ctx, `wall-lantern-${side}-${x}`, x, z));
}

export function buildLanternPost(
    ctx: CastleKitContext,
    name: string,
    x: number,
    z: number,
): readonly Mesh[] {
    const meshes: Mesh[] = [];
    meshes.push(addBox(
        ctx,
        `${name}-slab`,
        { width: 0.5, height: 0.09, depth: 0.5 },
        'stone',
        new Vector3(x, 0.16, z),
    ));
    const stem = ctx.add(MeshBuilder.CreateCylinder(
        `${ctx.prefix}-${name}-stem`,
        { height: 0.55, diameter: 0.12, tessellation: 6 },
        ctx.scene,
    ), ctx.materials.stone);
    stem.position.set(x, 0.48, z);
    meshes.push(stem);

    const body = ctx.add(MeshBuilder.CreateCylinder(
        `${ctx.prefix}-${name}-paper`,
        { height: 0.36, diameter: 0.34, tessellation: 6 },
        ctx.scene,
    ), ctx.materials.paper);
    body.position.set(x, 0.92, z);
    meshes.push(body);

    const roof = ctx.add(MeshBuilder.CreateCylinder(
        `${ctx.prefix}-${name}-roof`,
        { height: 0.16, diameterTop: 0.08, diameterBottom: 0.46, tessellation: 6 },
        ctx.scene,
    ), ctx.materials.roofTile);
    roof.position.set(x, 1.18, z);
    meshes.push(roof);
    return meshes;
}

export function buildToriiGate(
    ctx: CastleKitContext,
    name: string,
    position: Vector3,
    scale = 1,
): readonly Mesh[] {
    const meshes: Mesh[] = [];
    for (const side of [-1, 1]) {
        const post = ctx.add(MeshBuilder.CreateCylinder(
            `${ctx.prefix}-${name}-post-${side}`,
            { height: 2.25 * scale, diameter: 0.18 * scale, tessellation: 10 },
            ctx.scene,
        ), ctx.materials.lacquer);
        post.position.set(position.x + side * 0.9 * scale, position.y + 1.1 * scale, position.z);
        meshes.push(post);
    }
    meshes.push(addBox(
        ctx,
        `${name}-kasagi`,
        { width: 2.25 * scale, height: 0.16 * scale, depth: 0.18 * scale },
        'lacquer',
        new Vector3(position.x, position.y + 2.24 * scale, position.z),
    ));
    meshes.push(addBox(
        ctx,
        `${name}-nuki`,
        { width: 2.04 * scale, height: 0.1 * scale, depth: 0.14 * scale },
        'wood',
        new Vector3(position.x, position.y + 1.76 * scale, position.z),
    ));
    return meshes;
}

export function buildBanner(
    ctx: CastleKitContext,
    name: string,
    material: 'accentBlue' | 'accentCoral',
    position: Vector3,
    direction: 'east' | 'west' | 'north' | 'south',
): Mesh {
    const northSouth = direction === 'north' || direction === 'south';
    const banner = addBox(
        ctx,
        name,
        {
            width: northSouth ? 0.8 : 0.04,
            height: 1.48,
            depth: northSouth ? 0.04 : 0.8,
        },
        material,
        position,
    );
    return banner;
}

export function buildGardenRock(ctx: CastleKitContext, name: string, position: Vector3, scale = 1): Mesh {
    const rock = ctx.add(MeshBuilder.CreateSphere(
        `${ctx.prefix}-${name}`,
        { diameter: 0.45 * scale, segments: 8 },
        ctx.scene,
    ), ctx.materials.rubble);
    rock.position.copyFrom(position);
    rock.scaling.set(1.25, 0.62, 0.9);
    rock.rotation.y = 0.35;
    return rock;
}

export function buildCherryTree(ctx: CastleKitContext, name: string, position: Vector3, scale = 1): readonly Mesh[] {
    const trunk = ctx.add(MeshBuilder.CreateCylinder(
        `${ctx.prefix}-${name}-trunk`,
        { height: 1.2 * scale, diameter: 0.16 * scale, tessellation: 7 },
        ctx.scene,
    ), ctx.materials.wood);
    trunk.position.set(position.x, position.y + 0.6 * scale, position.z);

    const canopy = ctx.add(MeshBuilder.CreateSphere(
        `${ctx.prefix}-${name}-canopy`,
        { diameter: 1.0 * scale, segments: 10 },
        ctx.scene,
    ), ctx.materials.foliage);
    canopy.position.set(position.x, position.y + 1.35 * scale, position.z);
    canopy.scaling.set(1.35, 0.74, 1.05);
    return [trunk, canopy];
}

export function buildBridge(ctx: CastleKitContext, name: string, length: number, horizontal: boolean): readonly Mesh[] {
    const meshes: Mesh[] = [];
    meshes.push(addBox(
        ctx,
        `${name}-deck`,
        {
            width: horizontal ? length : 1.1,
            height: 0.12,
            depth: horizontal ? 1.1 : length,
        },
        'wood',
        new Vector3(0, 0.05, 0),
    ));
    for (const side of [-1, 1]) {
        meshes.push(addBox(
            ctx,
            `${name}-rail-${side}`,
            {
                width: horizontal ? length : 0.12,
                height: 0.24,
                depth: horizontal ? 0.12 : length,
            },
            'lacquer',
            new Vector3(
                horizontal ? 0 : side * 0.64,
                0.32,
                horizontal ? side * 0.64 : 0,
            ),
        ));
    }
    return meshes;
}

function buildWallRails(ctx: CastleKitContext, segment: CastleWallSegmentPlan): readonly Mesh[] {
    const northSouth = segment.direction === 'north' || segment.direction === 'south';
    return [
        addBox(
            ctx,
            `wall-base-rail-${segment.name}`,
            {
                width: northSouth ? segment.size.width : 0.22,
                height: 0.14,
                depth: northSouth ? 0.22 : segment.size.depth,
            },
            'wood',
            new Vector3(segment.position.x, 0.76, segment.position.z),
        ),
        addBox(
            ctx,
            `wall-top-rail-${segment.name}`,
            {
                width: northSouth ? segment.size.width : 0.26,
                height: 0.2,
                depth: northSouth ? 0.26 : segment.size.depth,
            },
            'wood',
            new Vector3(segment.position.x, ctx.wallHeight - 0.54, segment.position.z),
        ),
    ];
}

function buildDoorFrame(ctx: CastleKitContext, direction: CardinalDirection): readonly Mesh[] {
    const northSouth = direction === 'north' || direction === 'south';
    const sign = direction === 'north' || direction === 'west' ? -1 : 1;
    const wallPosition = sign * ctx.roomSize / 2;
    const meshes: Mesh[] = [];
    for (const side of [-1, 1]) {
        meshes.push(addBox(
            ctx,
            `door-post-${direction}-${side}`,
            {
                width: northSouth ? 0.22 : ctx.wallThickness + 0.12,
                height: 2.65,
                depth: northSouth ? ctx.wallThickness + 0.12 : 0.22,
            },
            'wood',
            new Vector3(
                northSouth ? side * (ctx.doorWidth / 2 + 0.08) : wallPosition,
                1.34,
                northSouth ? wallPosition : side * (ctx.doorWidth / 2 + 0.08),
            ),
        ));
    }

    meshes.push(addBox(
        ctx,
        `door-lintel-${direction}`,
        {
            width: northSouth ? ctx.doorWidth + 0.55 : ctx.wallThickness + 0.16,
            height: 0.32,
            depth: northSouth ? ctx.wallThickness + 0.16 : ctx.doorWidth + 0.55,
        },
        'lacquer',
        new Vector3(northSouth ? 0 : wallPosition, 2.78, northSouth ? wallPosition : 0),
    ));
    meshes.push(addBox(
        ctx,
        `door-threshold-${direction}`,
        {
            width: northSouth ? ctx.doorWidth + 0.28 : ctx.wallThickness + 0.08,
            height: 0.08,
            depth: northSouth ? ctx.wallThickness + 0.08 : ctx.doorWidth + 0.28,
        },
        'stone',
        new Vector3(northSouth ? 0 : wallPosition, 0.12, northSouth ? wallPosition : 0),
    ));
    return meshes;
}

function addBox(
    ctx: CastleKitContext,
    name: string,
    size: Readonly<{ width: number; height: number; depth: number }>,
    material: CastleKitMaterialRole,
    position: Vector3,
): Mesh {
    const mesh = ctx.add(MeshBuilder.CreateBox(`${ctx.prefix}-${name}`, size, ctx.scene), ctx.materials[material]);
    mesh.position.copyFrom(position);
    return mesh;
}
