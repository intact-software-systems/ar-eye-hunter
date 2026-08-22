import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Scene } from '@babylonjs/core/scene.js';

export type CastleSurfaceTextures = Readonly<{
    stoneNormal: DynamicTexture;
    woodNormal: DynamicTexture;
    metalNormal: DynamicTexture;
}>;

export function createCastleSurfaceTextures(scene: Scene): CastleSurfaceTextures {
    return {
        stoneNormal: buildNormalMap(scene, 'castle-stone-normal', 128, stoneHeightFn, 9),
        woodNormal: buildNormalMap(scene, 'castle-wood-normal', 64, woodHeightFn, 6),
        metalNormal: buildNormalMap(scene, 'castle-metal-normal', 64, metalHeightFn, 4)
    };
}

// Stamps a bump texture onto a PBR material with independent UV tiling.
// Clones the source texture so each material has its own scale settings.
export function applyNormalMap(
    mat: PBRMaterial,
    src: DynamicTexture,
    uScale: number,
    vScale: number,
    level = 1.0
): void {
    const tex = src.clone() as DynamicTexture;
    tex.uScale = uScale;
    tex.vScale = vScale;
    mat.bumpTexture = tex;
    mat.bumpTexture.level = level;
}

export function applyClearCoat(
    mat: PBRMaterial,
    intensity: number,
    roughness: number
): void {
    mat.clearCoat.isEnabled = true;
    mat.clearCoat.intensity = intensity;
    mat.clearCoat.roughness = roughness;
    mat.clearCoat.indexOfRefraction = 1.5;
}

export function applySheen(
    mat: PBRMaterial,
    intensity: number,
    roughness: number
): void {
    mat.sheen.isEnabled = true;
    mat.sheen.intensity = intensity;
    mat.sheen.roughness = roughness;
}

// ─── Normal-map builder ────────────────────────────────────────────────────

function buildNormalMap(
    scene: Scene,
    name: string,
    size: number,
    heightFn: (u: number, v: number) => number,
    bumpScale: number
): DynamicTexture {
    const tex = new DynamicTexture(name, { width: size, height: size }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;

    // Pre-compute full height field
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            h[y * size + x] = heightFn(x / size, y / size);
        }
    }

    // Finite-difference gradient → tangent-space normal → encode as RGB
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const xm = (x - 1 + size) % size;
            const xp = (x + 1) % size;
            const ym = (y - 1 + size) % size;
            const yp = (y + 1) % size;
            const dx = (h[y * size + xp] - h[y * size + xm]) * bumpScale;
            const dy = (h[yp * size + x] - h[ym * size + x]) * bumpScale;
            const nx = -dx;
            const ny = -dy;
            const nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const i = (y * size + x) * 4;
            data[i + 0] = Math.round((nx / len * 0.5 + 0.5) * 255);
            data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
            data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
            data[i + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);
    tex.update();
    return tex;
}

// ─── Height field functions ────────────────────────────────────────────────

function pseudoNoise(x: number, y: number): number {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
}

function smoothNoise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return pseudoNoise(ix, iy) * (1 - ux) * (1 - uy) +
        pseudoNoise(ix + 1, iy) * ux * (1 - uy) +
        pseudoNoise(ix, iy + 1) * (1 - ux) * uy +
        pseudoNoise(ix + 1, iy + 1) * ux * uy;
}

// Stacked brick courses with mortar joints and per-stone dome curvature
function stoneHeightFn(u: number, v: number): number {
    const row = Math.floor(v * 7);
    const rowOff = (row % 2) * 0.5;
    const col = Math.floor((u + rowOff) * 5);
    const lu = (u + rowOff) * 5 - col;
    const lv = v * 7 - row;
    const mu = Math.min(lu, 1 - lu) * 8;
    const mv = Math.min(lv, 1 - lv) * 8;
    const mortar = Math.min(1, Math.min(mu, mv));
    const dome = Math.min(lu, 1 - lu) * Math.min(lv, 1 - lv) * 4;
    const seed = Math.abs(Math.sin(col * 37.3 + row * 119.7)) * 0.35;
    const grain = (smoothNoise(u * 28, v * 28) * 0.6 + smoothNoise(u * 56, v * 56) * 0.4) * 0.18;
    return mortar * (0.55 + seed) * Math.min(1, dome) + grain;
}

// Annual rings with subtle knot-swell and fine grain along the fibre
function woodHeightFn(u: number, v: number): number {
    const ring = Math.sin(v * 48 + Math.sin(u * 5) * 1.8) * 0.5 + 0.5;
    const fine = smoothNoise(u * 18, v * 72) * 0.18;
    const knot = Math.max(0, 0.4 - Math.abs(Math.sin(u * 3.1 + 1.4)) * 1.2) * 0.25;
    return ring * 0.62 + fine + knot;
}

// Fine horizontal machining scratches — makes iron look forged, not plastic
function metalHeightFn(u: number, v: number): number {
    const s1 = Math.abs(Math.sin(v * 180 + Math.sin(u * 0.7) * 2.5)) * 0.5;
    const s2 = Math.abs(Math.sin(v * 380 + u * 1.8)) * 0.35;
    const grain = smoothNoise(u * 36, v * 36) * 0.15;
    return s1 * 0.55 + s2 * 0.3 + grain;
}
