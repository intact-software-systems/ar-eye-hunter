import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { MarketShopVisual } from '../create-market-environment.ts';
import { CutoutActor } from '../cutout-actor.ts';
import { CutoutArt } from '../cutout-art.ts';
import { TOWN_SHOPS } from './map.ts';
import type { TownNpc, TownPatch, TownState } from './state.ts';

interface TownOwnerVisual {
    readonly actor: CutoutActor;
    readonly bubble: Mesh;
    readonly target: Mesh;
    readonly cleanup: Mesh;
}
export namespace TownPresentation {
    export interface Input {
        readonly scene: Scene;
        readonly art: CutoutArt;
        readonly shops: readonly MarketShopVisual[];
    }
    export interface Frame {
        readonly town: TownState;
        readonly now: number;
        readonly reducedMotion: boolean;
    }
}
export class TownPresentation {
    private readonly scene: Scene;
    private readonly art: CutoutArt;
    private readonly shops: readonly MarketShopVisual[];
    private readonly owners: readonly TownOwnerVisual[];
    private readonly fruit = new Map<number, Mesh>();
    private readonly patches = new Map<number, Mesh>();
    private readonly zaps = new Map<number, Mesh>();

    constructor(input: TownPresentation.Input) {
        this.scene = input.scene;
        this.art = input.art;
        this.shops = input.shops;
        this.owners = TOWN_SHOPS.map((shop) => {
            const actor = new CutoutActor({
                scene: input.scene,
                art: input.art,
                color: shop.color,
                guard: shop.kind === 'zapper'
            });
            const bubble = CreatePlane('grumpy-remark', { width: 2.1, height: 0.65 }, input.scene);
            bubble.rotation.x = 0.55;
            const target = CreateGround('zap-warning', { width: 2.5, height: 2.5 }, input.scene);
            target.material = input.art.texture(
                'zap-target',
                '<circle cx="128" cy="128" r="110" fill="#d19f43" fill-opacity=".45" stroke="#803e48" stroke-width="10"/><path stroke="#803e48" stroke-width="10" d="M128 10v70m0 96v70M10 128h70m96 0h70"/>'
            );
            const cleanup = CreatePlane('cleanup-progress', { width: 1.5, height: 0.12 }, input.scene);
            cleanup.rotation.x = 0.55;
            cleanup.material = input.art.paper('cleanup-progress', '#a9c281');
            return { actor, bubble, target, cleanup };
        });
    }

    render(frame: TownPresentation.Frame): void {
        const { town, now, reducedMotion } = frame;
        const time = reducedMotion ? 0 : now;
        town.npcs.forEach((npc, index) => {
            const visual = this.owners[index];
            this.renderOwner(visual, npc, { now, time });
            visual.cleanup.setEnabled(npc.mode === 'cleaning');
            visual.cleanup.position.set(npc.x, 2.3, npc.z + 0.2);
            visual.cleanup.scaling.x = Math.max(0.05, cleanupRemaining(town, npc));
        });
        this.shops.forEach((visual, index) => {
            const shop = town.shops[index];
            visual.display.rotation.x = shop.tipped ? -0.38 : 0;
            visual.display.rotation.z = shop.tipped ? 0.16 : 0;
            visual.stock.setEnabled(!shop.tipped);
            visual.pickup?.setEnabled(!shop.tipped && shop.pickupAt <= now);
            if (visual.pickup) {
                visual.pickup.position.y = 0.85 + Math.sin(time * 3) * 0.12;
            }
        });
        this.renderFruit(frame);
        this.renderPatches(frame);
        this.renderZaps(town);
    }

    private renderOwner(visual: TownOwnerVisual, npc: TownNpc, clock: { now: number; time: number; }): void {
        const { now, time } = clock;
        const dizzy = npc.dizzyUntil > now;
        const mini = npc.miniUntil > now;
        const working = npc.mode === 'cleaning' && !dizzy;
        visual.actor.render({
            x: npc.x,
            z: npc.z,
            time,
            moving: working || npc.mode === 'chasing',
            slipping: false,
            facing: 0,
            angry: npc.mode === 'chasing' || npc.mode === 'warning',
            dizzy,
            mini,
            working,
            puking: npc.sickAt >= 0 && now >= npc.sickAt && now < npc.sickAt + 1
        });
        const remarks = {
            watching: 'NO REFUNDS.',
            chasing: 'GET BACK HERE!',
            warning: 'ZAP INCOMING!',
            cleaning: 'WHO DID THIS?!'
        };
        let text = remarks[npc.mode];
        if (mini) {
            text = 'WHY SO SMALL?!';
        }
        if (dizzy) {
            text = 'URRRP!';
        }
        visual.bubble.position.set(npc.x, mini ? 1.6 : 2.8, npc.z + 0.4);
        visual.bubble.material = this.art.texture(
            `remark-${text}`,
            `<path fill="#eee1bf" stroke="#4d4439" stroke-width="5" d="M5 5H251V211H145L123 253 114 211H5z"/><text transform="translate(0,-315) scale(1,3)" x="128" y="153" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="25" fill="#44382e">${text}</text>`
        );
        visual.target.setEnabled(npc.mode === 'warning');
        visual.target.position.set(npc.aim.x, 0.06, npc.aim.z);
        visual.target.scaling.setAll(1 + Math.sin(time * 12) * 0.06);
    }

    private renderFruit(frame: TownPresentation.Frame): void {
        for (const fruit of frame.town.fruit) {
            let mesh = this.fruit.get(fruit.id);
            if (!mesh) {
                mesh = CreateSphere('spilled-fruit', { diameter: 0.43, segments: 4 }, this.scene);
                mesh.material = this.art.paper(
                    `spilled-${fruit.id % 3}`,
                    ['#c45f38', '#e2b048', '#86994d'][fruit.id % 3]
                );
                this.fruit.set(fruit.id, mesh);
            }
            const age = frame.now - fruit.born;
            const bounce = frame.reducedMotion ? 0 : Math.abs(Math.sin(age * 12)) * Math.max(0, 0.6 - age);
            mesh.position.set(fruit.x, 0.2 + bounce, fruit.z);
            mesh.rotation.z = frame.reducedMotion ? 0 : age * fruit.vx;
        }
        disposeMissing(this.fruit, frame.town.fruit);
    }

    private renderPatches(frame: TownPresentation.Frame): void {
        for (const patch of frame.town.patches) {
            let mesh = this.patches.get(patch.id);
            if (!mesh) {
                mesh = this.createPatch(patch);
                this.patches.set(patch.id, mesh);
            }
            mesh.position.set(patch.x, patch.kind === 'powder' ? 0.9 : 0.04, patch.z);
            mesh.visibility = Math.min(patch.kind === 'powder' ? 0.4 : 1, patch.expires - frame.now);
        }
        disposeMissing(this.patches, frame.town.patches);
    }

    private createPatch(patch: TownPatch): Mesh {
        const mesh = patch.kind === 'powder'
            ? CreatePlane('dizzy-powder', { size: 3.4 }, this.scene)
            : CreateGround('puke-puddle', { width: 2, height: 2 }, this.scene);
        mesh.material = this.art.texture(
            `mess-${patch.kind}`,
            patch.kind === 'powder'
                ? '<path fill="#b195b7" fill-opacity=".8" d="M28 143Q-5 92 48 75Q37 7 100 44Q153-4 175 51Q253 24 226 103Q279 154 219 180Q221 255 151 215Q81 269 62 207Q1 216 28 143z"/><g fill="#eee0b6"><circle cx="94" cy="91" r="8"/><circle cx="156" cy="140" r="6"/><circle cx="72" cy="167" r="7"/></g>'
                : '<path fill="#82934e" stroke="#b0bc60" stroke-width="6" d="M24 113Q17 55 74 81Q106 10 148 58Q237 36 214 108Q281 149 214 190Q181 247 124 212Q38 258 51 189Q-10 164 24 113z"/><circle fill="#c5c976" cx="100" cy="120" r="14"/><circle fill="#c5c976" cx="160" cy="158" r="9"/>'
        );
        if (patch.kind === 'powder') {
            mesh.material.transparencyMode = 2;
        }
        mesh.rotation.x = patch.kind === 'powder' ? 0.55 : 0;
        return mesh;
    }

    private renderZaps(town: TownState): void {
        for (const zap of town.zaps) {
            if (this.zaps.has(zap.id)) {
                continue;
            }
            const dx = zap.target.x - zap.x;
            const dz = zap.target.z - zap.z;
            const mesh = CreateBox('mini-zap', { width: 0.12, height: 0.12, depth: Math.hypot(dx, dz) }, this.scene);
            mesh.position.set((zap.x + zap.target.x) / 2, 0.8, (zap.z + zap.target.z) / 2);
            mesh.rotation.y = Math.atan2(dx, dz);
            mesh.material = this.art.paper('zap-yellow', '#f3e576');
            this.zaps.set(zap.id, mesh);
        }
        disposeMissing(this.zaps, town.zaps);
    }
}

function disposeMissing(meshes: Map<number, Mesh>, alive: readonly { readonly id: number; }[]): void {
    const ids = new Set(alive.map((item) => item.id));
    for (const [id, mesh] of meshes) {
        if (!ids.has(id)) {
            mesh.dispose();
            meshes.delete(id);
        }
    }
}

function cleanupRemaining(town: TownState, npc: TownNpc): number {
    if (npc.shopId === 'apples' && town.fountain.broken) {
        return 1 - town.fountain.repair / 4;
    }
    if (npc.shopId === 'pears' && town.cart.loose) {
        return 1 - town.cart.repair / 3;
    }
    return town.fruit.filter((fruit) => fruit.shopId === npc.shopId).length / 6;
}
