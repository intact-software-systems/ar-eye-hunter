import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import { CutoutArt } from '../../cutout-art.ts';
import { MESS_DRAWINGS } from '../mess-drawings.ts';
import type { TownPresentation } from '../town-presentation.ts';
import { CREATURE_DRAWINGS } from './creature-drawings.ts';
import { createTownCreatures, type TownCreature } from './rules.ts';

interface CreatureVisual {
    readonly body: Mesh;
    readonly shadow: Mesh;
    readonly target: Mesh;
    readonly attack: Mesh;
}

export class TownCreaturePresentation {
    private readonly creatures: readonly CreatureVisual[];

    constructor(scene: Scene, art: CutoutArt) {
        this.creatures = createTownCreatures().map((creature) => createCreatureVisual({ scene, art, creature }));
    }

    render(frame: TownPresentation.Frame): void {
        frame.town.creatures.forEach((creature, index) => {
            const visual = this.creatures[index];
            const time = frame.reducedMotion ? 0 : frame.now;
            const warning = creature.mode === 'warning';
            const height = creature.kind === 'bird' ? 1.7 : 0.65;
            visual.body.position.set(creature.x, height + Math.abs(Math.sin(time * 7 + index)) * 0.09, creature.z);
            visual.body.rotation.z = warning ? Math.sin(time * 15) * 0.12 : Math.sin(time * 6) * 0.04;
            visual.body.scaling.x = creature.aim.x < creature.x ? -1 : 1;
            visual.shadow.position.set(creature.x, 0.03, creature.z);
            visual.target.setEnabled(warning);
            visual.target.position.set(creature.aim.x, 0.09, creature.aim.z);
            visual.target.scaling.setAll(0.8 + Math.max(0, creature.until - frame.now) * 0.2);
            renderCreatureAttack(visual, creature, frame.now);
        });
    }
}

function createCreatureVisual(input: { scene: Scene; art: CutoutArt; creature: TownCreature; }): CreatureVisual {
    const { scene, art, creature } = input;
    const body = CreatePlane(`grumpy-${creature.kind}`, { size: creature.kind === 'bird' ? 1.1 : 1.35 }, scene);
    body.rotation.x = 0.55;
    body.material = art.texture(`creature-${creature.kind}`, CREATURE_DRAWINGS[creature.kind]);
    const shadow = CreateGround('creature-shadow', { width: 1, height: 0.65 }, scene);
    shadow.material = art.texture(
        'creature-shadow',
        '<ellipse cx="128" cy="128" rx="120" ry="100" fill="#4c4b3a" fill-opacity=".35"/>'
    );
    shadow.material.transparencyMode = 2;
    const target = CreateGround('creature-warning', { width: 2.5, height: 2.5 }, scene);
    const color = creature.kind === 'bird' ? '#78533d' : creature.kind === 'dog' ? '#bba133' : '#72834a';
    target.material = art.texture(
        `creature-warning-${creature.kind}`,
        `<circle cx="128" cy="128" r="109" fill="none" stroke="${color}" stroke-width="12" stroke-dasharray="25 12"/><text x="128" y="179" text-anchor="middle" font-size="150" font-weight="900" fill="${color}">!</text>`
    );
    const attack = creature.kind === 'bird'
        ? CreatePlane('falling-poop', { size: 0.6 }, scene)
        : CreateBox('creature-spray', { width: 0.12, height: 0.12, depth: 1 }, scene);
    attack.material = creature.kind === 'bird'
        ? art.texture('bird-poop', MESS_DRAWINGS.poop)
        : art.paper(`spray-${creature.kind}`, color);
    return { body, shadow, target, attack };
}

function renderCreatureAttack(visual: CreatureVisual, creature: TownCreature, now: number): void {
    const falling = creature.mode === 'warning' && creature.until - now < 0.4;
    const spraying = creature.mode === 'recovering' && creature.until - now > 2.6;
    visual.attack.setEnabled(creature.kind === 'bird' ? falling : spraying);
    if (creature.kind === 'bird') {
        visual.attack.rotation.x = 0.55;
        visual.attack.position.set(creature.aim.x, Math.max(0.2, (creature.until - now) * 6), creature.aim.z);
        return;
    }
    const dx = creature.aim.x - creature.x;
    const dz = creature.aim.z - creature.z;
    visual.attack.position.set((creature.x + creature.aim.x) / 2, 0.45, (creature.z + creature.aim.z) / 2);
    visual.attack.rotation.y = Math.atan2(dx, dz);
    visual.attack.scaling.z = Math.hypot(dx, dz);
}
