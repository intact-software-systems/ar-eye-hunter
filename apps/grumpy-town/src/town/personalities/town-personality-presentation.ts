import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { CutoutActor } from '../../cutout-actor.ts';
import { CutoutArt } from '../../cutout-art.ts';
import type { TownPresentation } from '../town-presentation.ts';
import {
    PERSONALITY_ITEMS,
    PERSONALITY_LABELS,
    PERSONALITY_PROPS,
    PERSONALITY_REACTION_ITEMS,
    PERSONALITY_REMARKS
} from './art.ts';
import { computeWasherJet } from './compute-washer-jet.ts';
import {
    TOWN_PERSONALITIES,
    type TownPersonality,
    type TownPersonalityDefinition
} from './state.ts';

interface ResidentVisual {
    readonly actor: CutoutActor;
    readonly prop: Mesh;
    readonly label: Mesh;
    readonly remark: Mesh;
    readonly item: Mesh;
    readonly reactionMaterial: StandardMaterial;
    readonly rivalryMaterial: StandardMaterial;
    readonly extras: readonly CutoutActor[];
    readonly hose: Mesh;
}
export class TownPersonalityPresentation {
    private readonly residents: readonly ResidentVisual[];

    constructor(scene: Scene, art: CutoutArt) {
        this.residents = TOWN_PERSONALITIES.map((resident) => createResidentVisual({ scene, art, resident }));
    }

    render(frame: TownPresentation.Frame): void {
        frame.town.personalities.forEach((resident, index) => {
            const visual = this.residents[index];
            const time = frame.reducedMotion ? 0 : frame.now;
            const active = resident.phase === 'reacting' || resident.phase === 'rivalry' ||
                resident.phase === 'chasing';
            visual.actor.render({
                x: resident.x,
                z: resident.z,
                time,
                moving: active || resident.phase === 'returning',
                slipping: false,
                facing: resident.target.x - resident.x,
                angry: active,
                working: resident.stainedUntil > frame.now || resident.kind === 'cleaner' && !active,
                dizzy: false,
                puking: resident.kind === 'inspector' && frame.town.spectacles.active?.kind === 'vomit' &&
                    frame.town.spectacles.active.phase === 'active',
                mini: false,
                stain: resident.stain
            });
            if (resident.kind === 'watcher' && resident.phase === 'idle') {
                visual.actor.root.position.y = 1.3;
            }
            visual.remark.setEnabled(active);
            visual.remark.position.set(resident.x, 2.6, resident.z);
            visual.prop.rotation.z = active && resident.kind !== 'mayor' ? Math.sin(time * 9) * 0.15 : 0;
            visual.label.setEnabled(!active);
            renderResidentItem(visual, resident, frame);
            renderWasherHose(visual, resident, frame);
            renderQueue(visual, resident, time);
        });
    }
}

function createResidentVisual(
    input: { scene: Scene; art: CutoutArt; resident: TownPersonalityDefinition; }
): ResidentVisual {
    const { scene, art, resident } = input;
    const actor = new CutoutActor({ scene, art, color: resident.color, guard: false });
    const prop = CreatePlane(
        `town-${resident.kind}`,
        { width: Math.max(1.2, resident.prop.width), height: 1.8 },
        scene
    );
    prop.material = art.texture(`personality-prop-${resident.kind}`, PERSONALITY_PROPS[resident.kind]);
    prop.position.set(resident.prop.x, 0.9, resident.prop.z);
    prop.rotation.x = 0.55;
    const label = createSign({ scene, art, text: PERSONALITY_LABELS[resident.kind], width: 2, color: '#dfd3ae' });
    label.position.set(resident.prop.x, 2.05, resident.prop.z);
    const remark = createSign({ scene, art, text: PERSONALITY_REMARKS[resident.kind], width: 2.7, color: '#e2cfa1' });
    const item = CreatePlane(`resident-item-${resident.kind}`, { size: resident.kind === 'cleaner' ? 3 : 0.8 }, scene);
    const rivalryMaterial = art.texture(`resident-item-${resident.kind}`, PERSONALITY_ITEMS[resident.kind]);
    const drawing = PERSONALITY_REACTION_ITEMS[resident.kind];
    const reactionMaterial = drawing ? art.texture(`resident-reaction-${resident.kind}`, drawing) : rivalryMaterial;
    item.material = reactionMaterial;
    item.rotation.x = 0.55;
    const hose = CreateBox('washer-jet', { width: 0.18, height: 0.16, depth: 5.5 }, scene);
    hose.material = art.paper('washer-water', '#b0ced0');
    const extras = resident.kind === 'queue'
        ? ['#a58e72', '#778a92'].map((color) => new CutoutActor({ scene, art, color, guard: false }))
        : [];
    return { actor, prop, label, remark, item, reactionMaterial, rivalryMaterial, extras, hose };
}

function createSign(input: { scene: Scene; art: CutoutArt; text: string; width: number; color: string; }): Mesh {
    const sign = CreatePlane('resident-sign', { width: input.width, height: 0.65 }, input.scene);
    sign.rotation.x = 0.55;
    sign.material = input.art.texture(
        `sign-${input.text}`,
        `<path fill="${input.color}" stroke="#575943" stroke-width="5" d="M3 3H253V253H3z"/><text x="128" y="166" text-anchor="middle" font-size="100" textLength="234" lengthAdjust="spacingAndGlyphs" font-family="sans-serif" font-weight="900" fill="#3f483c">${input.text}</text>`
    );
    return sign;
}

function renderResidentItem(visual: ResidentVisual, resident: TownPersonality, frame: TownPresentation.Frame): void {
    const active = resident.phase === 'reacting' || resident.phase === 'rivalry';
    const age = frame.now - resident.startedAt;
    visual.item.material = resident.phase === 'rivalry' ? visual.rivalryMaterial : visual.reactionMaterial;
    const animal = frame.town.creatures.find((creature) => creature.id === resident.rivalCreature);
    visual.item.setEnabled(active && (resident.kind !== 'cleaner' || age >= 2));
    if (animal && resident.phase === 'rivalry' && age > 2) {
        visual.item.position.set(animal.x, animal.kind === 'bird' ? 2 : 0.9, animal.z - 0.1);
        return;
    }
    const flies = resident.kind === 'gardener' || resident.kind === 'watcher' || resident.kind === 'washer';
    const fraction = Math.min(1, age / 1.5);
    const x = flies ? resident.home.x + (resident.target.x - resident.home.x) * fraction : resident.prop.x;
    const z = flies ? resident.home.z + (resident.target.z - resident.home.z) * fraction : resident.prop.z - 0.25;
    visual.item.position.set(x, flies ? 0.5 + Math.sin(fraction * Math.PI) * 2.5 : 1.3, z);
    visual.item.rotation.z = flies && !frame.reducedMotion ? age * 3 : 0;
    if (resident.kind === 'cleaner') {
        visual.item.position.set(resident.x, 1.3, resident.z - 0.5);
    }
}

function renderWasherHose(visual: ResidentVisual, resident: TownPersonality, frame: TownPresentation.Frame): void {
    const spraying = resident.kind === 'washer' && resident.phase === 'reacting' && frame.now - resident.startedAt > 1;
    visual.hose.setEnabled(spraying);
    if (!spraying) {
        return;
    }
    const direction = computeWasherJet(resident, frame.now);
    visual.hose.position.set(resident.x + direction.x * 3, 0.7, resident.z + direction.z * 3);
    visual.hose.rotation.y = Math.atan2(direction.x, direction.z);
}

function renderQueue(visual: ResidentVisual, resident: TownPersonality, time: number): void {
    visual.extras.forEach((actor, index) => {
        const reacting = resident.phase === 'reacting';
        actor.render({
            x: resident.home.x + 1.2 + index,
            z: resident.home.z + (reacting ? Math.sin(time * 2 + index) : index * 0.5),
            time,
            moving: reacting,
            slipping: false,
            facing: -1,
            angry: reacting,
            working: false,
            dizzy: false,
            puking: false,
            mini: false,
            stain: 'clean'
        });
    });
}
