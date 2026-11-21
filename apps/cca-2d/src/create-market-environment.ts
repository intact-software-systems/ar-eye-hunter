import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutArt } from './cutout-art.ts';
import { createTownLayout } from './town/layout/presentation.ts';
import {
    TOWN_GOVERNMENT,
    TOWN_ICE,
    TOWN_LIMIT,
    TOWN_SHOPS,
    type TownShop
} from './town/map.ts';

export interface MarketShopVisual {
    readonly id: string;
    readonly display: TransformNode;
    readonly stock: TransformNode;
    readonly pickup: Mesh | undefined;
}
interface MarketBlock {
    readonly scene: Scene;
    readonly material: StandardMaterial;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
}
interface MarketSign {
    readonly scene: Scene;
    readonly art: CutoutArt;
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly width: number;
    readonly color: string;
}

export function createMarketEnvironment(scene: Scene, art: CutoutArt): readonly MarketShopVisual[] {
    createTownStreet(scene, art);
    createTownGovernment(scene, art);
    createTownLayout(scene, art);
    const shops = TOWN_SHOPS.map((shop) => createTownShop(scene, art, shop));
    createSign({ scene, art, text: 'GRUMPY TOWN', x: 0, y: 0.05, z: -6, width: 5, color: '#d0c29f' }).rotation.x =
        Math.PI / 2;
    createSign({ scene, art, text: 'POWDER  <     >  ZAPPER', x: 0, y: 0.06, z: -10, width: 7, color: '#cab994' })
        .rotation.x = Math.PI / 2;
    return shops;
}

function createTownStreet(scene: Scene, art: CutoutArt): void {
    const floor = CreateGround('market-street', { width: 90, height: 90 }, scene);
    const paving = art.texture(
        'paving',
        '<path fill="#b1a18a" d="M0 0H256V256H0z"/><path fill="none" stroke="#958673" stroke-width="2" d="M0 60h256M0 125h256M0 190h256M67 0v60m100 0v65M48 125v65m133 0v66M214 0v60"/><path fill="none" stroke="#786f62" stroke-width="1" d="M17 80l13 8-5 13 9 17M195 149l-12 8 6 9-10 12"/>',
        false
    );
    floor.material = paving;
    if (paving.diffuseTexture instanceof Texture) {
        paving.diffuseTexture.uScale = 34;
        paving.diffuseTexture.vScale = 34;
    }
    const ice = CreateGround('slippery-ice', { width: TOWN_ICE.width, height: TOWN_ICE.depth }, scene);
    ice.position.set(TOWN_ICE.x, 0.025, TOWN_ICE.z);
    ice.material = art.texture(
        'ice',
        '<path fill="#89c9d0" stroke="#d8ede0" stroke-width="5" d="M5 5H251V251H5z"/><path fill="none" stroke="#deeee2" stroke-width="4" d="M45 36l60 40-19 40 49 16-19 58 74 41M177 18l-21 45 38 47-59 22M5 189l81-73M194 110l57 4M49 213l32-35"/>'
    );
    const road = art.paper('street-stripe', '#d8cba7');
    for (let z = -21; z <= 21; z += 4) {
        createBlock({ scene, material: road, x: -1.7, y: 0.015, z, width: 0.08, height: 0.01, depth: 1 });
        createBlock({ scene, material: road, x: 1.7, y: 0.015, z, width: 0.08, height: 0.01, depth: 1 });
    }
    for (const side of [-1, 1]) {
        createBlock({
            scene,
            material: art.paper('curb', '#746f61'),
            x: side * (TOWN_LIMIT + 0.7),
            y: 0.35,
            z: 0,
            width: 1,
            height: 0.7,
            depth: 51
        });
        createBlock({
            scene,
            material: art.paper('curb', '#746f61'),
            x: 0,
            y: 0.35,
            z: side * (TOWN_LIMIT + 0.7),
            width: 51,
            height: 0.7,
            depth: 1
        });
    }
}

function createTownShop(scene: Scene, art: CutoutArt, shop: TownShop): MarketShopVisual {
    const display = new TransformNode(`display-${shop.id}`, scene);
    display.position.set(shop.x, 0, shop.z);
    const wood = art.paper('wood', '#8b6148');
    const counter = createBlock({
        scene,
        material: wood,
        x: 0,
        y: 0.52,
        z: 0,
        width: shop.width,
        height: 1.04,
        depth: shop.depth
    });
    counter.parent = display;
    const awning = new TransformNode(`awning-${shop.id}`, scene);
    awning.position.set(shop.x, 0, shop.z);
    createShopAwning(scene, art, { shop, display: awning });
    const stock = new TransformNode(`stock-${shop.id}`, scene);
    stock.parent = display;
    for (let item = 0; item < 6; item++) {
        const fruit = CreateSphere('stock-fruit', { diameter: 0.4, segments: 4 }, scene);
        fruit.material = art.paper(`fruit-${shop.color}`, shop.kind === 'fruit' ? '#ce943f' : shop.color);
        fruit.position.set(-1 + item * 0.4, 1.18, -0.85);
        fruit.parent = stock;
    }
    const sign = createSign({ scene, art, text: shop.sign, x: 0, y: 0.7, z: -1.25, width: 2.7, color: '#dec59a' });
    sign.parent = display;
    const pickup = shop.kind === 'fruit' ? undefined : CreatePlane(`pickup-${shop.id}`, { size: 1.1 }, scene);
    if (pickup) {
        pickup.rotation.x = 0.55;
        pickup.position.set(shop.x, 0.8, shop.z - 2.5);
        pickup.material = art.texture(
            `pickup-${shop.kind}`,
            shop.kind === 'powder'
                ? '<circle cx="128" cy="128" r="119" fill="#b9a1c7" stroke="#523e5a" stroke-width="8"/><path fill="#f3e0b5" d="M87 57H164V83L186 210H63L86 82z"/><text x="128" y="165" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="60">P</text>'
                : '<circle cx="128" cy="128" r="119" fill="#d2c668" stroke="#655b2b" stroke-width="8"/><path fill="#f3edc9" stroke="#534d2e" stroke-width="7" d="M147 23L56 141H119L96 232 202 107H140z"/>'
        );
    }
    return { id: shop.id, display, stock, pickup };
}

interface ShopAwningInput {
    readonly shop: TownShop;
    readonly display: TransformNode;
}
function createShopAwning(scene: Scene, art: CutoutArt, input: ShopAwningInput): void {
    const { shop, display } = input;
    for (const side of [-1, 1]) {
        createBlock({
            scene,
            material: art.paper('wood', '#8b6148'),
            x: side * 1.35,
            y: 1.65,
            z: 0.8,
            width: 0.1,
            height: 3.1,
            depth: 0.1
        }).parent = display;
    }
    for (let stripe = 0; stripe < 6; stripe++) {
        const material = art.paper(stripe % 2 ? 'canvas-cream' : shop.id, stripe % 2 ? '#ddcba5' : shop.color);
        const roof = createBlock({
            scene,
            material,
            x: -1.3 + stripe * 0.52,
            y: 2.7,
            z: 0,
            width: 0.53,
            height: 0.08,
            depth: 2.7
        });
        roof.parent = display;
        roof.rotation.x = -0.15;
        createBlock({
            scene,
            material,
            x: -1.3 + stripe * 0.52,
            y: 2.33,
            z: -1.3,
            width: 0.53,
            height: 0.4,
            depth: 0.04
        }).parent = display;
    }
}

function createTownGovernment(scene: Scene, art: CutoutArt): void {
    const { x, z, width, depth } = TOWN_GOVERNMENT;
    createBlock({ scene, material: art.paper('government-paper', '#8b8b79'), x, y: 1.7, z, width, height: 3.4, depth });
    createBlock({
        scene,
        material: art.paper('government-roof', '#555e61'),
        x,
        y: 3.6,
        z,
        width: width + 0.4,
        height: 0.4,
        depth: depth + 0.3
    });
    createBlock({
        scene,
        material: art.paper('government-door', '#293632'),
        x,
        y: 1.1,
        z: z - depth / 2 - 0.02,
        width: 1.8,
        height: 2.2,
        depth: 0.05
    });
    for (const side of [-1, 1]) {
        createBlock({
            scene,
            material: art.paper('government-column', '#c5c4aa'),
            x: side * 2.3,
            y: 1.6,
            z: z - 1.55,
            width: 0.4,
            height: 3.2,
            depth: 0.4
        });
        createBlock({
            scene,
            material: art.paper('government-window', '#4d6268'),
            x: side * 1.6,
            y: 1.7,
            z: z - 1.52,
            width: 0.7,
            height: 1.2,
            depth: 0.05
        });
    }
    createSign({ scene, art, text: 'MINISTRY OF NO FUN', x, y: 3, z: z - 1.65, width: 5.4, color: '#d6cba4' });
    createSign({ scene, art, text: 'POLICE', x, y: 2.3, z: z - 1.7, width: 1.8, color: '#97a7af' });
}

function createSign(input: MarketSign): Mesh {
    const { scene, art, text, x, y, z, width, color } = input;
    const sign = CreatePlane('market-sign', { width, height: width * 0.26 }, scene);
    sign.position.set(x, y, z);
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    sign.material = art.texture(
        `sign-${text}`,
        `<path fill="${color}" d="M5 14L251 5 246 250 9 242z"/><text transform="translate(0,-440) scale(1,4)" x="128" y="163" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="${
            text.length > 12 ? 21 : 30
        }" fill="#30352c">${escaped}</text>`
    );
    return sign;
}

function createBlock(input: MarketBlock): Mesh {
    const { scene, material, x, y, z, width, height, depth } = input;
    const block = CreateBox('market-cardboard', { width, height, depth }, scene);
    block.position.set(x, y, z);
    block.material = material;
    block.isPickable = false;
    return block;
}
