import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutActor } from '../../cutout-actor.ts';
import { CutoutArt } from '../../cutout-art.ts';
import { TOWN_FIRE_BAY, TOWN_FIRE_DOOR } from '../layout/map.ts';
import { hasTownSight } from '../navigation.ts';
import { PERSONALITY_ITEMS } from '../personalities/art.ts';
import type { TownPresentation } from '../presentation.ts';
import {
    BARBECUE_DRAWING,
    BOMB_DRAWING,
    CAKE_DRAWING,
    FIRE_DRAWING,
    TRUCK_DRAWING,
    UMBRELLA_DRAWING
} from './art.ts';
import {
    TOWN_BARBECUE,
    TOWN_BOMB_PICKUP,
    TOWN_UMBRELLA
} from './state.ts';
import { computeTownVomitJets } from './vomit.ts';

interface FirefighterVisual {
    readonly actor: CutoutActor;
    readonly hose: Mesh;
    readonly helmet: Mesh;
    readonly target: Mesh;
}
export class TownSpectaclePresentation {
    private readonly flames: Mesh;
    private readonly bomb: Mesh;
    private readonly pickup: Mesh;
    private readonly warning: Mesh;
    private readonly truck: Mesh;
    private readonly umbrella: Mesh;
    private readonly crew: readonly FirefighterVisual[];
    private readonly streams: readonly Mesh[];
    private readonly waiter: CutoutActor;
    private readonly cake: Mesh;
    private readonly bucket: Mesh;

    constructor(scene: Scene, art: CutoutArt) {
        this.flames = createBarbecueFire(scene, art);
        this.bomb = createCutout({ scene, art, name: 'poop-bomb', drawing: BOMB_DRAWING, width: 1.3, height: 1.3 });
        this.pickup = createCutout({ scene, art, name: 'poop-bomb', drawing: BOMB_DRAWING, width: 1.1, height: 1.1 });
        this.warning = CreateGround('bomb-radius', { width: 12, height: 12 }, scene);
        this.warning.material = art.texture(
            'bomb-radius',
            '<circle cx="128" cy="128" r="119" fill="#876044" fill-opacity=".1" stroke="#78583c" stroke-width="5" stroke-dasharray="10 5"/>'
        );
        this.truck = createCutout({
            scene,
            art,
            name: 'grumpy-fire-truck',
            drawing: TRUCK_DRAWING,
            width: 3.8,
            height: 2.3
        });
        this.umbrella = createCutout({
            scene,
            art,
            name: 'cafe-umbrella',
            drawing: UMBRELLA_DRAWING,
            width: 2.2,
            height: 2.2
        });
        this.umbrella.position.set(TOWN_UMBRELLA.x, 1.1, TOWN_UMBRELLA.z);
        this.crew = [0, 1].map(() => createFirefighter(scene, art));
        this.streams = [0, 1].map(() => {
            const stream = CreateBox('spectacular-vomit', { width: 0.5, height: 0.3, depth: 1 }, scene);
            stream.material = art.paper('spectacular-vomit', '#98a65a');
            return stream;
        });
        this.waiter = new CutoutActor({ scene, art, color: '#ded0ae', guard: false });
        this.cake = createCutout({ scene, art, name: 'precious-cake', drawing: CAKE_DRAWING, width: 0.8, height: 0.8 });
        this.bucket = createCutout({
            scene,
            art,
            name: 'tiny-bucket',
            drawing: PERSONALITY_ITEMS.inspector,
            width: 0.3,
            height: 0.35
        });
        createSpectacleSigns(scene, art);
    }

    render(frame: TownPresentation.Frame): void {
        const event = frame.town.spectacles.active;
        const time = frame.reducedMotion ? 0 : frame.now;
        const fire = event?.kind === 'fire';
        this.flames.setEnabled(fire && event.phase !== 'cleanup');
        this.flames.scaling.setAll(0.9 + Math.sin(time * 12) * 0.1);
        this.truck.setEnabled(fire);
        const arrival = fire ? Math.min(1, (frame.now - event.startedAt) / 4) : 0;
        this.truck.position.set(
            TOWN_FIRE_DOOR.x + (TOWN_FIRE_BAY.x - TOWN_FIRE_DOOR.x) * arrival,
            1.15,
            TOWN_FIRE_DOOR.z + (TOWN_FIRE_BAY.z - TOWN_FIRE_DOOR.z) * arrival
        );
        this.crew.forEach((visual, index) => renderFirefighter(visual, index, frame));
        const armed = event?.kind === 'poop' && event.phase === 'warning';
        this.bomb.setEnabled(armed);
        this.warning.setEnabled(armed);
        if (armed) {
            this.bomb.position.set(event.origin.x, 0.65, event.origin.z);
            this.bomb.rotation.z = Math.sin(time * 16) * 0.13;
            this.warning.position.set(event.origin.x, 0.07, event.origin.z);
        }
        this.pickup.setEnabled(
            frame.town.spectacles.bombReadyAt <= frame.now && event?.kind !== 'poop' &&
                !frame.town.spectacles.queue.some((item) => item.kind === 'poop')
        );
        this.pickup.position.set(TOWN_BOMB_PICKUP.x, 0.8 + Math.sin(time * 3) * 0.1, TOWN_BOMB_PICKUP.z);
        this.umbrella.rotation.z = frame.town.spectacles.umbrellaUntil > frame.now ? 0.75 : 0;
        this.renderDinner(frame);
    }

    private renderDinner(frame: TownPresentation.Frame): void {
        const event = frame.town.spectacles.active;
        const dinner = event?.kind === 'vomit';
        const cleaning = dinner && event.phase === 'cleanup';
        const jets = computeTownVomitJets(frame.town, frame.now);
        this.streams.forEach((stream, index) => {
            const jet = jets[index];
            stream.setEnabled(Boolean(jet));
            if (!jet) {
                return;
            }
            let length = 0;
            for (let distance = 0.5; distance <= jet.length; distance += 0.5) {
                const target = {
                    x: jet.source.x + jet.direction.x * distance,
                    z: jet.source.z + jet.direction.z * distance
                };
                if (!hasTownSight(frame.town, jet.source, target)) {
                    break;
                }
                length = distance;
            }
            stream.position.set(
                jet.source.x + jet.direction.x * length / 2,
                1,
                jet.source.z + jet.direction.z * length / 2
            );
            stream.rotation.y = Math.atan2(jet.direction.x, jet.direction.z);
            stream.scaling.z = length;
        });
        const x = dinner ? -14 + Math.sin(frame.reducedMotion ? 0 : frame.now * 3) * 0.3 : -14;
        this.waiter.render({
            x,
            z: -3.5,
            time: frame.reducedMotion ? 0 : frame.now,
            moving: Boolean(dinner),
            slipping: false,
            facing: 1,
            angry: Boolean(dinner),
            working: cleaning,
            dizzy: false,
            puking: false,
            mini: false,
            stain: 'clean'
        });
        this.cake.position.set(x + 0.4, dinner ? 2.5 : 1, -3.6);
        this.bucket.setEnabled(cleaning);
        this.bucket.position.set(-12.7, 0.18, -3.7);
    }
}

function createCutout(
    input: { scene: Scene; art: CutoutArt; name: string; drawing: string; width: number; height: number; }
): Mesh {
    const mesh = CreatePlane(input.name, { width: input.width, height: input.height }, input.scene);
    mesh.material = input.art.texture(input.name, input.drawing);
    mesh.rotation.x = 0.55;
    return mesh;
}

function createFirefighter(scene: Scene, art: CutoutArt): FirefighterVisual {
    const actor = new CutoutActor({ scene, art, color: '#776b48', guard: false });
    const hose = CreateBox('fire-hose', { width: 0.2, height: 0.18, depth: 1 }, scene);
    hose.material = art.paper('fire-hose-water', '#b6d3d0');
    const helmet = createCutout({
        scene,
        art,
        name: 'fire-helmet',
        width: 1.25,
        height: 0.7,
        drawing:
            '<path fill="#c5ac55" stroke="#5f6048" stroke-width="9" d="M20 192L62 153Q60 35 128 35Q196 35 194 153L236 192z"/><path fill="#9b6b44" d="M114 42H143V156H114z"/>'
    });
    const target = CreateGround('fire-hose-warning', { width: 3, height: 3 }, scene);
    target.material = art.texture(
        'fire-hose-warning',
        '<circle cx="128" cy="128" r="110" fill="none" stroke="#c5aa58" stroke-width="12" stroke-dasharray="20 12"/><text x="128" y="184" text-anchor="middle" font-size="160" fill="#c5aa58">!</text>'
    );
    return { actor, hose, helmet, target };
}

function renderFirefighter(visual: FirefighterVisual, index: number, frame: TownPresentation.Frame): void {
    const firefighter = frame.town.spectacles.firefighters[index];
    const visible = Boolean(firefighter) && frame.town.spectacles.active?.phase !== 'warning';
    visual.actor.root.setEnabled(visible);
    visual.helmet.setEnabled(visible);
    visual.hose.setEnabled(visible && firefighter.phase === 'spraying');
    visual.target.setEnabled(visible && firefighter.phase === 'aiming');
    if (!visible) {
        return;
    }
    visual.target.position.set(firefighter.aim.x, 0.08, firefighter.aim.z);
    visual.actor.render({
        x: firefighter.x,
        z: firefighter.z,
        time: frame.reducedMotion ? 0 : frame.now,
        moving: firefighter.phase !== 'spraying',
        slipping: false,
        facing: firefighter.aim.x - firefighter.x,
        angry: true,
        working: false,
        dizzy: false,
        puking: false,
        mini: false,
        stain: firefighter.stain
    });
    visual.helmet.position.set(firefighter.x, 2.05, firefighter.z + 0.95);
    const dx = firefighter.aim.x - firefighter.x;
    const dz = firefighter.aim.z - firefighter.z;
    visual.hose.position.set((firefighter.x + firefighter.aim.x) / 2, 0.8, (firefighter.z + firefighter.aim.z) / 2);
    visual.hose.rotation.y = Math.atan2(dx, dz);
    visual.hose.scaling.z = Math.hypot(dx, dz);
}

function createSpectacleSigns(scene: Scene, art: CutoutArt): void {
    for (
        const sign of [{ ...TOWN_BARBECUE, text: 'DO NOT KICK' }, { ...TOWN_BOMB_PICKUP, text: 'THE BIG STINK' }, {
            ...TOWN_UMBRELLA,
            text: 'DASH TO TILT'
        }]
    ) {
        const mesh = createCutout({
            scene,
            art,
            name: `sign-${sign.text}`,
            width: 2.2,
            height: 0.65,
            drawing:
                `<path fill="#ded1ab" stroke="#5a5e48" stroke-width="5" d="M3 3H253V253H3z"/><text x="128" y="166" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="100" textLength="234" lengthAdjust="spacingAndGlyphs" fill="#424a3b">${sign.text}</text>`
        });
        mesh.position.set(sign.x, 2.2, sign.z);
    }
}

function createBarbecueFire(scene: Scene, art: CutoutArt): Mesh {
    const barbecue = createCutout({
        scene,
        art,
        name: 'barbecue',
        drawing: BARBECUE_DRAWING,
        width: 1.4,
        height: 1.4
    });
    barbecue.position.set(TOWN_BARBECUE.x, 0.7, TOWN_BARBECUE.z);
    const flames = createCutout({
        scene,
        art,
        name: 'barbecue-fire',
        drawing: FIRE_DRAWING,
        width: 1.8,
        height: 2.2
    });
    flames.position.set(TOWN_BARBECUE.x, 1.8, TOWN_BARBECUE.z - 0.1);
    return flames;
}
