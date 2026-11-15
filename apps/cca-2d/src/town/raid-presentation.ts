import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutActor } from '../cutout-actor.ts';
import { CutoutArt } from '../cutout-art.ts';
import type { PracticeScene } from '../practice-scene.ts';
import type { TownPoint } from './map.ts';

interface TownRaidActor {
    readonly actor: CutoutActor;
    readonly ring: Mesh;
    readonly ice: Mesh;
    readonly label: Mesh;
}
interface TownRaidPose extends TownPoint {
    readonly frozen: boolean;
    readonly shielded: boolean;
    readonly time: number;
}

export class TownRaidPresentation {
    private readonly companion: TownRaidActor;
    private readonly guards: readonly TownRaidActor[];
    private readonly playerIce: Mesh;
    private readonly alarm: Mesh;
    private readonly district: Mesh;

    constructor(scene: Scene, art: CutoutArt) {
        this.companion = createRaidActor({ scene, art, guard: false });
        this.guards = Array.from({ length: 3 }, () => createRaidActor({ scene, art, guard: true }));
        this.playerIce = createIce(scene, art);
        this.district = CreateGround('raid-boundary', { width: 24, height: 24 }, scene);
        this.district.material = art.texture(
            'raid-boundary',
            '<circle cx="128" cy="128" r="124" fill="none" stroke="#b65a43" stroke-width="3" stroke-dasharray="8 5"/>'
        );
        this.alarm = CreatePlane('calling-authorities', { width: 2.2, height: 0.8 }, scene);
        this.alarm.rotation.x = 0.55;
        this.alarm.material = art.texture(
            'calling-authorities',
            '<path d="M5 25H251V230H5z" fill="#e9ba65" stroke="#783f39" stroke-width="9"/><text x="128" y="120" text-anchor="middle" font-family="sans-serif" font-size="37" font-weight="900" fill="#783f39">CALLING</text><text x="128" y="180" text-anchor="middle" font-family="sans-serif" font-size="33" font-weight="900" fill="#783f39">THE GRUMPS!</text>'
        );
    }

    render(frame: PracticeScene.Frame): void {
        const { state, reducedMotion } = frame;
        const { town, elapsed } = state;
        const time = reducedMotion ? 0 : elapsed;
        renderRaidActor(this.companion, {
            ...town.companion,
            time,
            frozen: town.companion.frozenUntil > elapsed,
            shielded: town.companion.shieldUntil > elapsed
        });
        this.companion.ring.setEnabled(town.companion.frozenUntil > elapsed || town.companion.shieldUntil > elapsed);
        this.companion.ring.position.set(town.companion.x, 0.07, town.companion.z);
        this.companion.ring.scaling.setAll(1 + town.rescueProgress * 0.4);
        this.playerIce.setEnabled(state.frozenUntil > elapsed);
        this.playerIce.position.set(state.x, 1, state.z - 0.3);
        this.alarm.setEnabled(town.raid.phase === 'alarm');
        this.district.setEnabled(town.raid.phase === 'alarm' || town.raid.phase === 'active');
        this.district.position.set(town.raid.origin.x, 0.03, town.raid.origin.z);
        const caller = town.npcs.find((npc) => npc.shopId === town.raid.callerId);
        if (caller) {
            this.alarm.position.set(caller.x, 3.6, caller.z);
        }
        this.guards.forEach((visual, index) => {
            const guard = town.raid.guards[index];
            visual.actor.root.setEnabled(Boolean(guard));
            visual.label.setEnabled(Boolean(guard));
            visual.ring.setEnabled(guard?.mode === 'warning');
            if (!guard) {
                return;
            }
            renderRaidActor(visual, { ...guard, time, frozen: false, shielded: false });
            visual.ring.position.set(guard.aim.x, 0.075, guard.aim.z);
        });
    }
}

function createRaidActor(input: { scene: Scene; art: CutoutArt; guard: boolean; }): TownRaidActor {
    const { scene, art, guard } = input;
    const actor = new CutoutActor({ scene, art, color: guard ? '#5b627e' : '#bd744d', guard });
    const ring = CreateGround('raid-target', { width: 2.4, height: 2.4 }, scene);
    ring.material = art.texture(
        `raid-ring-${guard}`,
        `<circle cx="128" cy="128" r="108" fill="none" stroke="${
            guard ? '#b64f46' : '#68bfc6'
        }" stroke-width="16" stroke-dasharray="35 12"/><circle cx="128" cy="128" r="15" fill="${
            guard ? '#b64f46' : '#68bfc6'
        }"/>`
    );
    const ice = createIce(scene, art);
    const label = CreatePlane('raid-label', { width: 1.5, height: 0.42 }, scene);
    label.rotation.x = 0.55;
    label.material = art.texture(
        `raid-label-${guard}`,
        `<rect width="256" height="256" fill="${
            guard ? '#535775' : '#9b5a3d'
        }"/><text transform="translate(0,-230) scale(1,2.6)" x="128" y="148" text-anchor="middle" font-family="sans-serif" font-size="38" font-weight="900" fill="#f7e4be">${
            guard ? 'GRUMP' : 'BOT PAL'
        }</text>`
    );
    return { actor, ring, ice, label };
}

function createIce(scene: Scene, art: CutoutArt): Mesh {
    const ice = CreatePlane('frozen-in-ice', { width: 1.9, height: 2.3 }, scene);
    ice.rotation.x = 0.55;
    ice.material = art.texture(
        'ice-prison',
        '<path d="M22 245L9 55 52 8 220 19 247 237z" fill="#91d2df" fill-opacity=".45" stroke="#c4edf0" stroke-width="10"/><path d="M47 48l52 13-15 60 45 32m48-113l-23 52 35 41-12 68M32 207l44-13" fill="none" stroke="#e3f5eb" stroke-width="7"/>'
    );
    ice.material.transparencyMode = 2;
    ice.setEnabled(false);
    return ice;
}

function renderRaidActor(visual: TownRaidActor, pose: TownRaidPose): void {
    visual.actor.render({
        x: pose.x,
        z: pose.z,
        time: pose.frozen ? 0 : pose.time,
        moving: !pose.frozen,
        slipping: false,
        facing: 0,
        angry: false,
        dizzy: false,
        puking: false,
        mini: false,
        working: false
    });
    visual.ice.setEnabled(pose.frozen);
    visual.ice.position.set(pose.x, 1, pose.z - 0.3);
    visual.label.position.set(pose.x, 2.6, pose.z);
    visual.label.visibility = pose.shielded ? 0.6 : 1;
}
