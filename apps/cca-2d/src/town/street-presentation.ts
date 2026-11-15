import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutArt } from '../cutout-art.ts';
import { TOWN_FOUNTAIN } from './map.ts';
import type { TownPresentation } from './presentation.ts';
import { getTownJet } from './props.ts';

export class TownStreetPresentation {
    private readonly cart: TransformNode;
    private readonly spray: Mesh;
    private readonly drops: readonly Mesh[];
    private readonly fountainSign: Mesh;
    private readonly cartSign: Mesh;
    private readonly art: CutoutArt;

    constructor(scene: Scene, art: CutoutArt) {
        this.art = art;
        const basin = CreateBox('fountain-basin', { width: 2.4, depth: 2.4, height: 0.55 }, scene);
        basin.position.set(0, 0.27, TOWN_FOUNTAIN.z);
        basin.material = art.paper('fountain-stone', '#747a6b');
        const water = CreateGround('basin-water', { width: 2, height: 2 }, scene);
        water.position.set(0, 0.56, TOWN_FOUNTAIN.z);
        water.material = art.paper('fountain-water', '#87b5ba');
        this.fountainSign = CreatePlane('fountain-face', { width: 1.5, height: 1.8 }, scene);
        this.fountainSign.position.set(0, 1.3, TOWN_FOUNTAIN.z);
        this.fountainSign.rotation.x = 0.55;
        this.cart = createParcelCart(scene, art);
        this.cartSign = CreatePlane('cart-label', { width: 1.8, height: 0.55 }, scene);
        this.cartSign.parent = this.cart;
        this.cartSign.position.set(0, 1.65, 0);
        this.cartSign.rotation.x = 0.55;
        this.spray = CreateGround('fountain-spray', { width: 1.6, height: 5.5 }, scene);
        this.spray.material = art.texture(
            'water-trail',
            '<path d="M85 0H172L245 240Q123 269 12 240z" fill="#8abac2" fill-opacity=".65"/><path d="M80 80l40 20m10 50l50 20M50 215l60 12" stroke="#dbefdd" stroke-width="8"/>'
        );
        this.spray.material.transparencyMode = 2;
        this.drops = Array.from({ length: 8 }, () => {
            const drop = CreatePlane('water-droplet', { size: 0.3 }, scene);
            drop.material = art.texture(
                'water-drop',
                '<path fill="#b7dadb" stroke="#619aab" stroke-width="15" d="M128 12Q15 137 52 202Q128 290 210 204Q247 144 128 12z"/>'
            );
            drop.rotation.x = 0.55;
            return drop;
        });
    }

    render(frame: TownPresentation.Frame): void {
        const { town, now, reducedMotion } = frame;
        this.cart.position.set(town.cart.x, 0, town.cart.z);
        this.cart.rotation.z = town.cart.loose && !reducedMotion ? Math.sin(now * 12) * 0.035 : 0;
        const direction = getTownJet(town, now);
        this.spray.setEnabled(town.fountain.broken);
        this.spray.position.set(direction.x * 2.75, 0.065, TOWN_FOUNTAIN.z + direction.z * 2.75);
        this.spray.rotation.y = Math.atan2(direction.x, direction.z);
        this.drops.forEach((drop, index) => {
            drop.setEnabled(town.fountain.broken);
            const distance = 1 + (reducedMotion ? index / 8 : (now * 0.8 + index / 8) % 1) * 4.5;
            drop.position.set(
                direction.x * distance,
                0.3 + Math.sin(distance / 5.5 * Math.PI),
                TOWN_FOUNTAIN.z + direction.z * distance
            );
        });
        this.fountainSign.material = this.art.texture(
            `fountain-${town.fountain.broken}`,
            `<path d="M28 245V80Q26 7 128 7T228 80V245z" fill="#9ba290" stroke="#434e48" stroke-width="8"/><path d="M52 72l58 18m38 0l56-18M71 175h114" stroke="#434e48" stroke-width="12"/><circle cx="90" cy="107" r="9"/><circle cx="166" cy="107" r="9"/><text x="128" y="225" text-anchor="middle" font-size="22" font-weight="bold" fill="#263a37">${
                town.fountain.broken ? 'LEAKING!' : 'NO SPLASHING'
            }</text>`
        );
        this.cartSign.material = this.art.texture(
            `cart-${town.cart.loose}`,
            `<path d="M4 48H252V210H4z" fill="#e7ce99" stroke="#5f503e" stroke-width="9"/><text transform="translate(0,-110) scale(1,1.8)" x="128" y="145" text-anchor="middle" font-family="sans-serif" font-size="35" font-weight="900" fill="#4e4136">${
                town.cart.loose ? 'RUNAWAY!' : 'DO NOT PUSH'
            }</text>`
        );
    }
}

function createParcelCart(scene: Scene, art: CutoutArt): TransformNode {
    const root = new TransformNode('parcel-cart', scene);
    const tray = CreateBox('cart-tray', { width: 1.7, depth: 1.3, height: 0.3 }, scene);
    tray.parent = root;
    tray.position.y = 0.45;
    tray.material = art.paper('cart-wood', '#755945');
    for (const x of [-0.65, 0.65]) {
        const wheel = CreatePlane('cart-wheel', { size: 0.5 }, scene);
        wheel.parent = root;
        wheel.position.set(x, 0.22, -0.68);
        wheel.material = art.texture(
            'cart-wheel',
            '<circle cx="128" cy="128" r="110" fill="#48463f"/><circle cx="128" cy="128" r="37" fill="#b6a384"/>'
        );
        const parcel = CreateBox('cart-parcel', { width: 0.7, depth: 0.9, height: x < 0 ? 0.65 : 0.9 }, scene);
        parcel.parent = root;
        parcel.position.set(x * 0.65, 0.85, 0);
        parcel.material = art.paper(`parcel-${x}`, x < 0 ? '#b38c5d' : '#d5b27b');
        const tape = CreateBox('parcel-tape', { width: 0.12, depth: 0.91, height: x < 0 ? 0.66 : 0.91 }, scene);
        tape.parent = root;
        tape.position.copyFrom(parcel.position);
        tape.material = art.paper('parcel-tape', '#e6cf95');
    }
    return root;
}
