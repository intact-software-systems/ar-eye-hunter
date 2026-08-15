import type {
    GroupRef,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';

/** Exact UTF-16 code-unit order for durable RTC topology identities. */
export function compareRtcTopologyIdentifiers(
    left: string,
    right: string,
): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Collision-safe unordered pair identity using the durable identifier order. */
export function toCanonicalRtcTopologyPairIdentity(
    left: string,
    right: string,
): string {
    const [first, second] =
        compareRtcTopologyIdentifiers(left, right) <= 0
            ? [left, right]
            : [right, left];
    return JSON.stringify([first, second]);
}

export function toCanonicalRtcTopologyGroupIdentity(
    groupRef: GroupRef,
): string {
    return JSON.stringify([
        groupRef.applicationId,
        groupRef.workspaceId === undefined
            ? ['absent']
            : ['present', groupRef.workspaceId],
        groupRef.groupId,
    ]);
}

export function toRtcTopologyPublicationMessageId(workId: string): string {
    if (workId.length === 0) {
        throw new TypeError('RTC topology publication work id is invalid');
    }
    return JSON.stringify(['rtc-topology-publication', workId]);
}

export function toRtcTopologyPublicationId(
    input: Readonly<{
        workId: string;
        sourceGroupStateCausalRevision: GroupStateCausalRevision;
        overlayVersion: number;
    }>,
): string {
    return [
        input.workId,
        input.sourceGroupStateCausalRevision.groupRevision,
        input.sourceGroupStateCausalRevision.presenceRevision,
        input.overlayVersion,
    ].join(':');
}
