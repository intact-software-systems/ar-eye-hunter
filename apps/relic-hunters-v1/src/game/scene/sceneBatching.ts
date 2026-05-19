export const MIN_ROOM_STATIC_BATCH_SIZE = 2;

export type RoomStaticBatchCandidate = Readonly<{
    materialKey?: string;
    visibility?: number;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type RoomStaticBatchPlanSummary = Readonly<{
    batchCount: number;
    batchedMeshCount: number;
    unbatchedMeshCount: number;
}>;

const DYNAMIC_METADATA_KEYS = [
    'clueHotspotId',
    'primeAction',
    'resolvedOnly',
    'playerId',
    'relicId',
] as const;

export function roomStaticBatchKey(candidate: RoomStaticBatchCandidate): string | undefined {
    if (!candidate.materialKey) {
        return undefined;
    }

    if (candidate.visibility !== undefined && Math.abs(candidate.visibility - 1) > 0.001) {
        return undefined;
    }

    for (const key of DYNAMIC_METADATA_KEYS) {
        if (candidate.metadata?.[key] !== undefined) {
            return undefined;
        }
    }

    return candidate.materialKey;
}

export function summarizeRoomStaticBatchPlan(
    candidates: readonly RoomStaticBatchCandidate[],
): RoomStaticBatchPlanSummary {
    const groups = new Map<string, number>();
    let unbatchedMeshCount = 0;

    for (const candidate of candidates) {
        const key = roomStaticBatchKey(candidate);
        if (!key) {
            unbatchedMeshCount += 1;
            continue;
        }
        groups.set(key, (groups.get(key) ?? 0) + 1);
    }

    let batchCount = 0;
    let batchedMeshCount = 0;
    for (const count of groups.values()) {
        if (count < MIN_ROOM_STATIC_BATCH_SIZE) {
            unbatchedMeshCount += count;
            continue;
        }
        batchCount += 1;
        batchedMeshCount += count;
    }

    return {
        batchCount,
        batchedMeshCount,
        unbatchedMeshCount,
    };
}
