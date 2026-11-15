import type { TownPoint } from '../map.ts';
import type { TownPersonality } from './state.ts';

export function computeWasherJet(resident: TownPersonality, now: number): TownPoint {
    const angle = -Math.PI / 2 + Math.sin((now - resident.startedAt) * 1.2) * 0.8;
    return { x: Math.sin(angle), z: Math.cos(angle) };
}
