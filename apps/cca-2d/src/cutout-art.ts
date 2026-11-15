import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

export class CutoutArt {
    private readonly scene: Scene;
    private readonly materials = new Map<string, StandardMaterial>();

    constructor(scene: Scene) {
        this.scene = scene;
    }

    paper(name: string, color: string): StandardMaterial {
        return this.texture(name, `<path fill="${color}" d="M0 0H256V256H0z"/>`, false);
    }

    texture(name: string, drawing: string, transparent = true): StandardMaterial {
        const existing = this.materials.get(name);
        if (existing) {
            return existing;
        }
        const material = new StandardMaterial(name, this.scene);
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><filter id="paper"><feTurbulence type="fractalNoise" baseFrequency=".52" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".12"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/><feComposite in2="SourceAlpha" operator="in"/></filter></defs><g filter="url(#paper)">${drawing}</g></svg>`;
        const texture = new Texture(`data:image/svg+xml;base64,${btoa(svg)}`, this.scene, false, true);
        texture.hasAlpha = transparent;
        material.diffuseTexture = texture;
        material.useAlphaFromDiffuseTexture = transparent;
        material.disableLighting = true;
        material.emissiveColor = Color3.White();
        material.backFaceCulling = false;
        material.transparencyMode = transparent ? 1 : 0;
        this.materials.set(name, material);
        return material;
    }

    head(guard: boolean, expression: 'grumpy' | 'surprised' | 'angry' | 'dizzy'): StandardMaterial {
        const startled = expression === 'surprised' || expression === 'dizzy';
        const hair = guard
            ? '<path fill="#283a48" d="M28 66L31 37 180 20 232 54 221 80 82 85z"/><path fill="#dcad4f" d="M117 36l10 7 13-3-3 14 4 11-15-1-11-9z"/>'
            : '<path fill="#292724" d="M26 95L8 71 40 67 18 40 63 45 55 12 90 34 117 6 137 25 169 13 166 35 210 25 201 46 242 62 212 77 234 103 207 95 194 69 165 82 142 56 111 79 84 60 58 99 42 130z"/>';
        const brows = startled
            ? '<path d="M67 105l37-17M151 89l38 17" stroke="#2d2926" stroke-width="9"/>'
            : '<path d="M63 106l41 10M150 115l40-17" stroke="#2d2926" stroke-width="9"/>';
        const mouth = expression === 'angry'
            ? '<path d="M99 210q32-38 64-3" stroke="#332a29" stroke-width="8" fill="none"/>'
            : startled
            ? '<ellipse cx="132" cy="191" rx="25" ry="23" fill="#332a29"/><path d="M114 202q18-12 35 0" stroke="#c97875" stroke-width="9"/>'
            : '<path d="M113 194q27-15 47-4" stroke="#332a29" stroke-width="5" fill="none"/>';
        const mustache = guard
            ? '<path fill="#604532" d="M128 165q-39-27-57 28l48-8 13-10 13 12 45 6q-25-51-62-28"/>'
            : '';
        return this.texture(
            `head-${guard}-${expression}`,
            `<path fill="#d8a77b" d="M39 85L19 114 27 177 45 184 57 221 127 244 204 211 219 177 236 169 238 127 217 115 207 70 144 40 76 48z"/><path fill="${
                expression === 'dizzy' ? '#b6c47d' : '#efc49a'
            }" d="M51 79L70 53 164 47 210 87 211 165 193 207 131 229 64 209 43 151z"/>${hair}<ellipse fill="#f5f0dc" cx="96" cy="137" rx="32" ry="35"/><ellipse fill="#f5f0dc" cx="161" cy="136" rx="32" ry="35"/><circle cx="110" cy="140" r="5"/><circle cx="148" cy="138" r="5"/>${brows}${mouth}${mustache}`
        );
    }

    torso(color: string, guard: boolean): StandardMaterial {
        const details = guard
            ? '<path d="M126 20v205M28 165h200" stroke="#463d32" stroke-width="12"/><path fill="#dfaf51" d="M167 63l9 7 12-3-2 14-10 8-11-7z"/>'
            : '<path d="M65 29L125 70 190 27M126 70v115M76 173h98" stroke="#173f42" stroke-width="6" fill="none"/><path d="M108 60l-5 50M142 61l7 48" stroke="#d2c9a7" stroke-width="5"/>';
        return this.texture(
            `torso-${color}-${guard}`,
            `<path fill="${color}" d="M53 8L189 13 235 65 218 233 35 238 18 72z"/>${details}`
        );
    }

    limb(color: string, leg: boolean): StandardMaterial {
        return this.texture(
            `limb-${color}-${leg}`,
            leg
                ? `<path fill="${color}" d="M54 10L181 15 169 186 66 203z"/><path fill="#27292a" d="M63 172L179 174 229 208 225 243 46 238z"/><path stroke="#c8c0a8" stroke-width="9" d="M50 234l170 3"/>`
                : `<path fill="${color}" d="M49 6L176 14 185 170 75 189 40 132z"/><path fill="#edc095" d="M76 168L178 153 210 169 193 181 231 193 210 207 221 226 188 228 164 247 109 230 85 202z"/>`
        );
    }
}
