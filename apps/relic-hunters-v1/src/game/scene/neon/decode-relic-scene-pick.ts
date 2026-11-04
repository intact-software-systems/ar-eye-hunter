export type RelicScenePick =
    | { readonly kind: 'pickup'; readonly relicId: string; }
    | { readonly kind: 'search'; }
    | { readonly kind: 'room'; readonly roomId: string; };

/** Babylon mesh metadata is untyped; only a checked interaction target crosses into scene input. */
export function decodeRelicScenePick(metadata: unknown): RelicScenePick | null {
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }
    if ('relicId' in metadata && typeof metadata.relicId === 'string') {
        return { kind: 'pickup', relicId: metadata.relicId };
    }
    if ('primeAction' in metadata && metadata.primeAction === 'search') {
        return { kind: 'search' };
    }
    if ('roomId' in metadata && typeof metadata.roomId === 'string') {
        return { kind: 'room', roomId: metadata.roomId };
    }
    return null;
}
