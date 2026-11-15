import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import { CutoutArt } from '../cutout-art.ts';
import { TOWN_OBJECTS, type TownObjectDefinition } from './map.ts';
import type { TownPresentation } from './presentation.ts';

interface StreetObjectVisual {
    readonly body: Mesh;
    readonly sign: Mesh;
}
const OBJECT_DRAWINGS: Readonly<Record<TownObjectDefinition['kind'], string>> = {
    bin: '<path fill="#6e8176" stroke="#353e37" stroke-width="9" d="M44 62h168l-19 180H64z"/><path fill="#495e54" stroke="#353e37" stroke-width="9" d="M25 43h209v36H25zm68-27h72v27H93z"/><path stroke="#a7b1a0" stroke-width="9" d="M87 98l7 113m36-113v113m44-113l-7 113"/><path fill="#ddcf9e" d="M92 134h75v48H92z"/>',
    fish:
        '<path fill="#78604a" stroke="#423e32" stroke-width="8" d="M20 128h216v99H20z"/><path fill="#a0b7ae" stroke="#485c56" stroke-width="7" d="M28 89l32-22q77-68 154 23-77 74-154 7l-32 22z"/><circle cx="179" cy="85" r="10"/><path fill="#d6c3a0" d="M32 157h190v45H32z"/><text x="128" y="189" text-anchor="middle" font-family="sans-serif" font-size="27" font-weight="900" fill="#413e32">OLD FISH</text>',
    toilet:
        '<path fill="#d6d5bf" stroke="#5c685f" stroke-width="8" d="M54 14h152v99H54zM32 107h194q0 84-69 90l18 45H75l20-47Q29 187 32 107z"/><ellipse cx="129" cy="112" rx="78" ry="23" fill="#8b9a84" stroke="#5c685f" stroke-width="6"/><ellipse cx="128" cy="110" rx="48" ry="12" fill="#c9d9c3"/><path stroke="#7d8f83" stroke-width="11" d="M167 51h22"/>',
    hydrant:
        '<path fill="#b86142" stroke="#4e3d32" stroke-width="8" d="M83 68q43-94 87 0v145h26v28H57v-28h26zM38 99h45v54H38zm132 0h47v54h-47z"/><path fill="#d6a16b" stroke="#4e3d32" stroke-width="7" d="M78 68h96v26H78z"/><circle cx="127" cy="140" r="24" fill="#d6a16b" stroke="#4e3d32" stroke-width="7"/>'
};

export class TownObjectPresentation {
    private readonly objects: readonly StreetObjectVisual[];

    constructor(scene: Scene, art: CutoutArt) {
        this.objects = TOWN_OBJECTS.map((object) => createObjectVisual({ scene, art, object }));
    }

    render(frame: TownPresentation.Frame): void {
        frame.town.objects.forEach((object, index) => {
            const visual = this.objects[index];
            const damaged = object.damagedUntil > frame.now;
            const time = frame.reducedMotion ? 0 : frame.now;
            visual.body.rotation.z = damaged ? (object.kind === 'bin' ? 1.2 : Math.sin(time * 6) * 0.08) : 0;
            visual.body.position.y = object.kind === 'bin' && damaged ? 0.55 : object.kind === 'toilet' ? 0.9 : 0.65;
            visual.sign.setEnabled(!damaged);
        });
    }
}

function createObjectVisual(
    input: { scene: Scene; art: CutoutArt; object: TownObjectDefinition; }
): StreetObjectVisual {
    const { scene, art, object } = input;
    const body = CreatePlane(`street-${object.kind}`, {
        width: Math.max(1.2, object.width),
        height: object.kind === 'toilet' ? 2 : 1.5
    }, scene);
    body.position.set(object.x, object.kind === 'toilet' ? 0.9 : 0.65, object.z - object.depth / 2);
    body.rotation.x = 0.55;
    body.material = art.texture(`object-${object.kind}`, OBJECT_DRAWINGS[object.kind]);
    const base = CreateBox('street-object-base', { width: object.width, depth: object.depth, height: 0.15 }, scene);
    base.position.set(object.x, 0.075, object.z);
    base.material = art.paper('object-base', '#7a7865');
    const sign = CreatePlane('object-invitation', { width: 1.6, height: 0.4 }, scene);
    sign.position.set(object.x, object.kind === 'toilet' ? 2.35 : 1.9, object.z);
    sign.rotation.x = 0.55;
    const label = object.kind === 'toilet' ? 'DO NOT FLUSH' : object.kind === 'hydrant' ? 'KEEP DRY' : 'DO NOT TOUCH';
    sign.material = art.texture(
        `object-sign-${object.kind}`,
        `<rect width="256" height="256" fill="#dbc99e"/><text transform="translate(0,-210) scale(1,2.5)" x="128" y="147" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="29" fill="#514731">${label}</text>`
    );
    return { body, sign };
}
