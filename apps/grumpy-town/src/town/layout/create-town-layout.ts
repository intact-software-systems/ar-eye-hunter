import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Scene } from '@babylonjs/core/scene';

import { CutoutArt } from '../../cutout-art.ts';
import {
    TOWN_BUILDINGS,
    TOWN_FURNITURE,
    type TownBuilding,
    type TownFurniture
} from './map.ts';

export function createTownLayout(scene: Scene, art: CutoutArt): void {
    for (const building of TOWN_BUILDINGS) {
        createTownBuilding({ scene, art, building });
    }
    for (const furniture of TOWN_FURNITURE) {
        createTownFurniture({ scene, art, furniture });
    }
}

function createTownBuilding(input: { scene: Scene; art: CutoutArt; building: TownBuilding; }): void {
    const { scene, art, building } = input;
    const { x, z, width, height, depth } = building;
    const body = CreateBox(building.id, { width, height, depth }, scene);
    body.position.set(x, height / 2, z);
    body.material = art.paper(`wall-${building.color}`, building.color);
    const facade = CreatePlane(`${building.id}-facade`, { width: width - 0.08, height }, scene);
    facade.position.set(x, height / 2, z - depth / 2 - 0.025);
    facade.material = art.texture(`facade-${building.id}`, drawTownFacade(building));
    const roof = CreateBox(`${building.id}-roof`, { width: width + 0.5, height: 0.22, depth: depth + 0.55 }, scene);
    roof.position.set(x, height + 0.12, z);
    roof.rotation.x = building.kind === 'booth' ? -0.14 : 0.07;
    roof.material = art.paper(`roof-${building.roof}`, building.roof);
    if (building.kind === 'house' || building.kind === 'shop') {
        const gable = CreatePlane(`${building.id}-gable`, { width: width + 0.4, height: 1.2 }, scene);
        gable.position.set(x, height + 0.58, z - depth / 2 - 0.05);
        gable.material = art.texture(
            `gable-${building.roof}`,
            `<path d="M0 250L109 7 256 250z" fill="${building.roof}" stroke="#48453f" stroke-width="9"/><path stroke="#b3a18a" stroke-width="3" d="M49 160h151M24 210h208"/>`
        );
        const chimney = CreateBox('crooked-chimney', { width: 0.55, height: 0.9, depth: 0.65 }, scene);
        chimney.position.set(x + width * 0.28, height + 0.65, z + depth * 0.2);
        chimney.rotation.z = 0.06;
        chimney.material = art.paper('chimney-brick', '#92725c');
    }
    if (building.kind === 'shop' || building.kind === 'booth') {
        const awning = CreatePlane(`${building.id}-awning`, { width: width + 0.2, height: 0.55 }, scene);
        awning.position.set(x, height * 0.6, z - depth / 2 - 0.3);
        awning.rotation.x = 0.35;
        awning.material = art.texture(
            `awning-${building.color}`,
            `<path fill="#e1d0a6" d="M0 0h256v256H0z"/><path fill="${building.roof}" d="M0 0h43v256H0zm86 0h43v256H86zm86 0h43v256h-43z"/>`
        );
    }
}

function drawTownFacade(building: TownBuilding): string {
    const sign = building.sign.replaceAll('&', '&amp;');
    const windows =
        '<g fill="#3e5755" stroke="#d4c8aa" stroke-width="7"><path d="M25 25h55v65H25zm149 0h55v65h-55z"/></g><path stroke="#c5baa1" stroke-width="4" d="M52 25v65m149-65v65M25 57h55m94 0h55"/>';
    const lower = building.kind === 'fire-station'
        ? '<path fill="#3d4945" stroke="#d5bda1" stroke-width="8" d="M37 109h182v147H37z"/><path stroke="#849088" stroke-width="5" d="M44 117h168m-168 16h168m-168 16h168"/><path fill="#d1b24e" d="M19 185h15v63H19zm203 0h15v63h-15z"/>'
        : building.kind === 'house'
        ? '<path fill="#65594e" stroke="#d4c8aa" stroke-width="7" d="M103 156h52v100h-52z"/><g fill="#3e5755" stroke="#c5b99d" stroke-width="6"><path d="M21 161h56v53H21zm159 0h56v53h-56z"/></g><path fill="#a37064" d="M20 161h18v53H20zm41 0h17v53H61zm118 0h18v53h-18zm40 0h18v53h-18z"/><path stroke="#5a594d" stroke-width="8" d="M9 222h76m-70-25v40m65-40v40"/>'
        : '<path fill="#496562" stroke="#ddd0ad" stroke-width="6" d="M19 159h132v79H19zm151-8h67v105h-67z"/><path fill="#d7b66c" d="M31 211h24v23H31zm37-9h27v32H68zm40 6h27v26h-27z"/><path stroke="#e8dab8" stroke-width="3" d="M29 168l39 32m-17-32l40 32m88-39l38 29"/>';
    const ornament = building.id === 'clockmaker'
        ? '<circle cx="128" cy="51" r="32" fill="#e3d7b5" stroke="#5b5144" stroke-width="5"/><path stroke="#4d4b42" stroke-width="6" d="M128 28v25l21 9"/>'
        : building.kind === 'house'
        ? '<path stroke="#55564b" stroke-width="3" d="M79 61q44 34 96 0"/><path fill="#d6bba5" d="M94 73l16 4-4 25-19-5zm39 6l18-4 7 24-21 4z"/>'
        : '<path fill="#d2c5a7" d="M111 22h34v53h-34z"/><path fill="#5b6255" d="M120 30h16v11h-16zm0 20h16v16h-16z"/>';
    return `${windows}${lower}${ornament}<path fill="#e0cda4" stroke="#655b4b" stroke-width="4" d="M7 98h242v43H7z"/><text x="128" y="125" text-anchor="middle" font-family="sans-serif" font-size="${
        sign.length > 17 ? 14 : 17
    }" font-weight="900" fill="#45483b">${sign}</text>`;
}

const FURNITURE_DRAWINGS: Readonly<Record<TownFurniture['kind'], string>> = {
    bench:
        '<path stroke="#4b5045" stroke-width="14" d="M40 124v110m176-110v110"/><path fill="#a88157" stroke="#5a4b3a" stroke-width="7" d="M19 63h218v34H19zm0 43h218v33H19zm-8 46h234v35H11z"/>',
    mailbox:
        '<path fill="#a85e49" stroke="#584536" stroke-width="7" d="M61 89q0-76 67-76t67 76v151H61z"/><path fill="#393f38" d="M83 76h90v24H83z"/><path fill="#e2d2a9" d="M85 132h86v57H85z"/><path fill="none" stroke="#655e4d" stroke-width="5" d="M87 134l40 30 41-30"/>',
    'bus-stop':
        '<path stroke="#60695e" stroke-width="10" d="M20 50v195m216-195v195"/><path fill="#a3b5ad" fill-opacity=".55" d="M30 58h195v151H30z"/><path fill="#d1bea0" stroke="#5c6558" stroke-width="6" d="M9 16h239v45H9z"/><text x="128" y="48" text-anchor="middle" font-size="23" font-family="sans-serif" font-weight="900" fill="#454c40">BUS DELAYED</text><path fill="#8a7251" d="M52 180h150v20H52z"/>',
    bikes:
        '<g fill="none" stroke="#4a5149" stroke-width="9"><circle cx="58" cy="176" r="45"/><circle cx="201" cy="176" r="45"/></g><path fill="none" stroke="#9a684e" stroke-width="11" d="M58 176l46-76 46 76H58l66-58 27 58 40-105 19 105"/><path stroke="#4a5149" stroke-width="9" d="M82 92h44m58-23h37"/>',
    planter:
        '<path fill="#aa7857" stroke="#62513c" stroke-width="8" d="M42 158h175l-25 86H66z"/><path fill="#617c4f" d="M63 164Q6 70 92 122Q56 15 129 95Q199 22 177 125Q251 58 209 163z"/><g fill="#c78b7a"><circle cx="89" cy="100" r="22"/><circle cx="169" cy="91" r="21"/></g><g fill="#d3b75e"><circle cx="89" cy="100" r="9"/><circle cx="169" cy="91" r="8"/></g>',
    table:
        '<path stroke="#514b3c" stroke-width="12" d="M86 126l-21 117m110-117l21 117"/><ellipse cx="128" cy="119" rx="113" ry="44" fill="#a28b64" stroke="#554d3d" stroke-width="8"/><path fill="#e8d8b2" stroke="#655d4d" stroke-width="5" d="M101 79h39v42h-39z"/><path fill="none" stroke="#e8d8b2" stroke-width="8" d="M143 86q29 0 2 28"/>',
    notice:
        '<path stroke="#6b5740" stroke-width="14" d="M38 160v90m181-90v90"/><path fill="#b4a181" stroke="#64533d" stroke-width="10" d="M9 18h239v174H9z"/><g fill="#e5d6af"><path d="M25 35h94v59H25zm112 6h92v100h-92zM32 110h81v65H32z"/></g><path stroke="#775744" stroke-width="6" d="M41 57h59m-57 19h48m108-12h42m-44 22h43m-44 22h40"/>',
    lamp:
        '<path stroke="#4d5952" stroke-width="13" d="M128 72v184"/><path fill="#ddcc95" stroke="#4d5952" stroke-width="8" d="M77 30h101l-17 69H94z"/><path fill="#4d5952" d="M68 31L126 2l62 29z"/>'
};

function createTownFurniture(input: { scene: Scene; art: CutoutArt; furniture: TownFurniture; }): void {
    const { scene, art, furniture } = input;
    const height = furniture.kind === 'lamp'
        ? 3.5
        : furniture.kind === 'bus-stop'
        ? 2.7
        : furniture.kind === 'notice'
        ? 2
        : 1.4;
    const width = furniture.kind === 'lamp' ? 1.1 : Math.max(1.1, furniture.width);
    const mesh = CreatePlane(furniture.id, { width, height }, scene);
    mesh.rotation.x = 0.55;
    mesh.position.set(furniture.x, height / 2, furniture.z);
    mesh.material = art.texture(`furniture-${furniture.kind}`, FURNITURE_DRAWINGS[furniture.kind]);
}
