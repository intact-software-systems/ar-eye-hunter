import type { OverlayInfo, PeerId } from '../api/api-config.ts';
import type { GroupRef } from '../api/group-types.ts';
import {
    isOverlayForGroupRef,
    toScopedOverlayId,
} from '@shared/api/api-type-utils.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';

export type OverlayCacheReader = ReadableKeyedValues<string, OverlayInfo>;

export function readOverlayForGroup(
    overlayCache: OverlayCacheReader | undefined,
    groupRef: GroupRef,
): OverlayInfo | undefined {
    if (!overlayCache) {
        return undefined;
    }

    const scopedOverlayId = toScopedOverlayId(groupRef);
    const scoped = overlayCache.read(scopedOverlayId) ??
        overlayCache.peek(scopedOverlayId);
    if (scoped) {
        return scoped.state === 'removed' ? undefined : scoped;
    }

    const legacy = overlayCache.read(groupRef.groupId) ??
        overlayCache.peek(groupRef.groupId);
    return legacy && legacy.state !== 'removed' &&
            isOverlayForGroupRef(legacy, groupRef)
        ? legacy
        : undefined;
}

export function readAuthoritativeOverlayForGroup(
    overlayCache: OverlayCacheReader | undefined,
    groupRef: GroupRef,
): OverlayInfo | undefined {
    const overlay = readOverlayForGroup(overlayCache, groupRef);
    return overlay?.degreeLimit !== undefined ? overlay : undefined;
}

export function computeOverlayRttReportingDegreeLimit(
    overlayCache: OverlayCacheReader | undefined,
    groupRefs: readonly GroupRef[],
): number | undefined {
    const limits = groupRefs
        .map((groupRef) => readOverlayForGroup(overlayCache, groupRef)?.degreeLimit)
        .filter((value): value is number => value !== undefined);
    return limits.length > 0 ? Math.min(...limits) : undefined;
}

export function computeServerDesiredPeerIds(
    overlayCache: OverlayCacheReader | undefined,
    groupRefs: readonly GroupRef[],
    localSessionId: string,
): ReadonlySet<PeerId> {
    const serverDesiredPeerIds = new Set<PeerId>();

    for (const groupRef of groupRefs) {
        const overlay = readOverlayForGroup(overlayCache, groupRef);
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
