import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutArt } from './cutout-art.ts';
import { PRACTICE_ICE, PRACTICE_OBSTACLES } from './practice-rules.ts';

interface CreateStallInput {
    readonly scene: Scene;
    readonly art: CutoutArt;
    readonly x: number;
    readonly z: number;
    readonly index: number;
}
interface CreateBankInput {
    readonly scene: Scene;
    readonly art: CutoutArt;
    readonly x: number;
    readonly z: number;
}
interface CreateCrateInput {
    readonly scene: Scene;
    readonly art: CutoutArt;
    readonly x: number;
    readonly z: number;
}
interface CreatePuddleInput {
    readonly scene: Scene;
    readonly art: CutoutArt;
    readonly x: number;
    readonly z: number;
}
interface CreateSignInput {
    readonly scene: Scene;
    readonly art: CutoutArt;
    readonly text: string;
    readonly x: number;
    readonly z: number;
    readonly width: number;
    readonly color: string;
    readonly y: number;
}
interface CreateBlockInput {
    readonly scene: Scene;
    readonly material: StandardMaterial;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
}

export function createMarketEnvironment(scene: Scene, art: CutoutArt): void {
    const floor = CreateGround('market-street', { width: 80, height: 80 }, scene);
    const paving = art.texture(
        'paving',
        '<path fill="#b1a18a" d="M0 0H256V256H0z"/><path fill="none" stroke="#958673" stroke-width="2" d="M0 60h256M0 125h256M0 190h256M67 0v60m100 0v65M48 125v65m133 0v66M214 0v60"/><path fill="none" stroke="#786f62" stroke-width="1" d="M17 80l13 8-5 13 9 17M195 149l-12 8 6 9-10 12"/>',
        false
    );
    floor.material = paving;
    if (paving.diffuseTexture instanceof Texture) {
        paving.diffuseTexture.uScale = 30;
        paving.diffuseTexture.vScale = 30;
    }
    createIce(scene, art);
    PRACTICE_OBSTACLES.forEach((obstacle, index) => {
        if (index === 4) {
            createBank({ scene, art, x: obstacle.x, z: obstacle.z });
        }
        else {
            createStall({ scene, art, x: obstacle.x, z: obstacle.z, index });
        }
    });
    createSign({ scene, art, text: 'SLIPPERY', x: -1.7, z: 4.7, width: 1.2, color: '#d9b65d', y: 1.1 });
    createSign({ scene, art, text: 'MARKET / NO REFUNDS', x: -5, z: 7.1, width: 2.9, color: '#e2d1aa', y: 1.1 });
    createCrate({ scene, art, x: -2.8, z: -5.5 });
    createCrate({ scene, art, x: 2.9, z: 6.2 });
    createCrate({ scene, art, x: -7.5, z: -0.7 });
    createPuddle({ scene, art, x: -2.1, z: -0.1 });
}

function createIce(scene: Scene, art: CutoutArt): void {
    const ice = CreateGround('slippery-ice', { width: PRACTICE_ICE.width, height: PRACTICE_ICE.depth }, scene);
    ice.position.set(PRACTICE_ICE.x, 0.025, PRACTICE_ICE.z);
    ice.material = art.texture(
        'ice',
        '<path fill="#89c9d0" stroke="#d8ede0" stroke-width="5" d="M19 5L110 12 172 3 239 22 248 83 231 139 251 214 188 247 113 234 40 249 7 217 23 162 5 90z"/><path fill="none" stroke="#deeee2" stroke-width="4" d="M45 36l60 40-19 40 49 16-19 58 74 41M177 18l-21 45 38 47-59 22M17 189l69-73M194 110l46 4M49 213l32-35"/><path fill="#c2e5df" opacity=".6" d="M20 72l64-41-45 48zM136 184l90-45-65 60z"/>'
    );
}

function createStall(input: CreateStallInput): void {
    const { scene, art, x, z, index } = input;
    const wood = art.paper('wood', '#8b6148');
    const cream = art.paper('canvas-cream', '#ddcba5');
    const stripe = art.paper(index % 2 ? 'rust' : 'teal', index % 2 ? '#a75038' : '#367876');
    createBlock({ scene, material: wood, x, y: 0.52, z, width: 3, height: 1.04, depth: 2.4 });
    for (const side of [-1, 1]) {
        createBlock({
            scene,
            material: wood,
            x: x + side * 1.35,
            y: 1.65,
            z: z + 0.8,
            width: 0.1,
            height: 3.1,
            depth: 0.1
        });
    }
    for (let strip = 0; strip < 6; strip++) {
        const awning = createBlock({
            scene,
            material: strip % 2 ? cream : stripe,
            x: x - 1.3 + strip * 0.52,
            y: 2.7,
            z,
            width: 0.53,
            height: 0.08,
            depth: 2.7
        });
        awning.rotation.x = -0.15;
        createBlock({
            scene,
            material: strip % 2 ? cream : stripe,
            x: x - 1.3 + strip * 0.52,
            y: 2.33,
            z: z - 1.3,
            width: 0.53,
            height: 0.4,
            depth: 0.04
        });
    }
    const fruit = art.paper(index % 2 ? 'apples' : 'oranges', index % 2 ? '#a94d35' : '#ce943f');
    for (let item = 0; item < 6; item++) {
        const sphere = CreateSphere('paper-fruit', { diameter: 0.38, segments: 4 }, scene);
        sphere.material = fruit;
        sphere.position.set(x - 1 + item * 0.4, 1.15, z - 0.85);
    }
    createSign({
        scene,
        art,
        text: index % 2 ? 'BAD APPLES' : 'ODD FRUIT',
        x,
        z: z - 1.22,
        width: 2,
        color: '#d8bc8e',
        y: 1.1
    });
}

function createBank(input: CreateBankInput): void {
    const { scene, art, x, z } = input;
    const green = art.paper('bank-paper', '#65765c');
    createBlock({ scene, material: green, x, y: 1.45, z, width: 3.8, height: 2.9, depth: 2.4 });
    createBlock({
        scene,
        material: art.paper('bank-roof', '#435744'),
        x,
        y: 3,
        z,
        width: 4.1,
        height: 0.2,
        depth: 2.7
    });
    createBlock({
        scene,
        material: art.paper('window', '#293632'),
        x,
        y: 1.4,
        z: z - 1.22,
        width: 1.8,
        height: 1.2,
        depth: 0.05
    });
    for (let bar = 0; bar < 4; bar++) {
        createBlock({
            scene,
            material: art.paper('bars', '#a4a393'),
            x: x - 0.65 + bar * 0.43,
            y: 1.4,
            z: z - 1.27,
            width: 0.06,
            height: 1.2,
            depth: 0.05
        });
    }
    createSign({ scene, art, text: 'BANK', x, z: z - 1.3, width: 2.8, color: '#d6cba4', y: 2.55 });
}

function createCrate(input: CreateCrateInput): void {
    const { scene, art, x, z } = input;
    const crate = createBlock({
        scene,
        material: art.paper('cardboard', '#ad8855'),
        x,
        y: 0.3,
        z,
        width: 0.75,
        height: 0.6,
        depth: 0.7
    });
    crate.rotation.y = 0.3;
    const seam = createBlock({
        scene,
        material: art.paper('tape', '#c6ad78'),
        x,
        y: 0.62,
        z,
        width: 0.15,
        height: 0.02,
        depth: 0.7
    });
    seam.rotation.y = 0.3;
}

function createPuddle(input: CreatePuddleInput): void {
    const { scene, art, x, z } = input;
    const puddle = CreateGround('spilled-water', { width: 2, height: 1.5 }, scene);
    puddle.position.set(x, 0.03, z);
    puddle.material = art.texture(
        'water',
        '<path fill="#428eaa" d="M30 120Q-5 80 62 62T151 78Q260 55 235 128T143 174Q60 230 22 172z"/><path fill="none" stroke="#9ad2d7" stroke-width="8" d="M34 148q40 35 88-1m24-47q30-7 53 17"/>'
    );
    const bucket = createBlock({
        scene,
        material: art.paper('bucket', '#777f7b'),
        x: x - 0.7,
        y: 0.3,
        z: z + 0.3,
        width: 0.65,
        height: 0.65,
        depth: 0.6
    });
    bucket.rotation.z = -0.6;
}

function createSign(input: CreateSignInput): void {
    const { scene, art, text, x, z, width, color, y } = input;
    const sign = CreatePlane('market-sign', { width, height: width * 0.26 }, scene);
    sign.position.set(x, y, z);
    sign.material = art.texture(
        `sign-${text}`,
        `<path fill="${color}" d="M5 14L251 5 246 250 9 242z"/><text transform="translate(0,-440) scale(1,4)" x="128" y="163" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="${
            text.length > 12 ? 21 : 44
        }" fill="#30352c">${text}</text>`
    );
}

function createBlock(input: CreateBlockInput): Mesh {
    const { scene, material, x, y, z, width, height, depth } = input;
    const block = CreateBox('market-cardboard', { width, height, depth }, scene);
    block.position.set(x, y, z);
    block.material = material;
    block.isPickable = false;
    return block;
}
