import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { OverlayInfo, PeerId } from '../api/api-config.ts';
import type { GroupRef } from '../api/group-types.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';

export function readPlannedOverlayForGroup(
    plannedOverlayCache: ReadableKeyedValues<string, OverlayInfo> | undefined,
    groupRef: GroupRef
): OverlayInfo | undefined {
    return readOverlayForGroup(plannedOverlayCache, groupRef);
}

export function readAcceptedOverlayForGroup(
    acceptedOverlayCache: ReadableKeyedValues<string, OverlayInfo> | undefined,
    groupRef: GroupRef
): OverlayInfo | undefined {
    return readOverlayForGroup(acceptedOverlayCache, groupRef);
}

export function computeOverlayRttReportingDegreeLimit(
    plannedOverlayCache: ReadableKeyedValues<string, OverlayInfo> | undefined,
    groupRefs: readonly GroupRef[]
): number | undefined {
    const limits = groupRefs
        .map((groupRef) => readPlannedOverlayForGroup(plannedOverlayCache, groupRef)?.degreeLimit)
        .filter((value): value is number => value !== undefined);
    return limits.length > 0 ? Math.min(...limits) : undefined;
}

export function computeServerDesiredPeerIds(
    acceptedOverlayCache: ReadableKeyedValues<string, OverlayInfo> | undefined,
    groupRefs: readonly GroupRef[],
    localSessionId: string
): ReadonlySet<PeerId> {
    const serverDesiredPeerIds = new Set<PeerId>();

    for (const groupRef of groupRefs) {
        const overlay = readAcceptedOverlayForGroup(acceptedOverlayCache, groupRef);
        if (overlay?.provenance !== 'server') {
            continue;
        }

        for (const peerId of overlay.nextHopSessionIds) {
            if (peerId !== localSessionId) {
                serverDesiredPeerIds.add(peerId);
            }
        }
    }

    return serverDesiredPeerIds;
}

function readOverlayForGroup(
    overlayCache: ReadableKeyedValues<string, OverlayInfo> | undefined,
    groupRef: GroupRef
): OverlayInfo | undefined {
    if (!overlayCache) {
        return undefined;
    }

    const scopedOverlayId = toScopedOverlayId(groupRef);
    const overlay = overlayCache.read(scopedOverlayId) ??
        overlayCache.peek(scopedOverlayId);
    return overlay?.state === 'removed' ? undefined : overlay;
}
