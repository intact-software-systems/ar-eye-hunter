import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
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

export function toRtcRttMeasurementStorageKey(
    left: string,
    right: string,
): string {
    const [from, to] =
        compareRtcTopologyIdentifiers(left, right) <= 0
            ? [left, right]
            : [right, left];
    return `from=${encodeURIComponent(from)}:to=${encodeURIComponent(to)}`;
}

export function toRtcRttEndpointAdmissionStorageKey(
    endpointId: string,
): string {
    return `endpoint=${encodeURIComponent(endpointId)}`;
}

export function toRtcRttMutationReceiptId(
    rtt: Pick<RttMeasurementInfo, 'sessionIdFrom' | 'sessionIdTo' | 'version'>,
): string {
    return `pair=${encodeURIComponent(
        toCanonicalRtcTopologyPairIdentity(rtt.sessionIdFrom, rtt.sessionIdTo),
    )}:version=${rtt.version}`;
}

export function toRtcRttRecomputeOutboxId(
    receiptId: string,
    groupRef: GroupRef,
    commandHash: string,
): string {
    return `${receiptId}:commandHash=${encodeURIComponent(commandHash)}:group=${encodeURIComponent(
        toCanonicalRtcTopologyGroupIdentity(groupRef),
    )}`;
}

export type RtcRttRecomputeOutboxIdentity = Readonly<{
    receiptId: string;
    version: number;
}>;

export function readRtcRttRecomputeOutboxIdentity(
    resourceId: string,
    groupRef: GroupRef,
): RtcRttRecomputeOutboxIdentity | null {
    const match =
        /^(pair=[^:]+:version=([1-9][0-9]*)):commandHash=([^:]+):group=(.+)$/u.exec(
            resourceId,
        );
    if (!match) return null;
    const [, receiptId, versionText, encodedCommandHash, encodedGroupIdentity] =
        match;
    if (
        !receiptId ||
        !versionText ||
        !encodedCommandHash ||
        !encodedGroupIdentity
    )
        return null;
    try {
        const commandHash = decodeURIComponent(encodedCommandHash);
        const groupIdentity = decodeURIComponent(encodedGroupIdentity);
        const version = Number(versionText);
        const pairMatch = /^pair=([^:]+):version=([1-9][0-9]*)$/u.exec(
            receiptId,
        );
        const pair: unknown = pairMatch
            ? JSON.parse(decodeURIComponent(pairMatch[1]!))
            : null;
        if (
            !/^sha256:[0-9a-f]{64}$/u.test(commandHash) ||
            groupIdentity !== toCanonicalRtcTopologyGroupIdentity(groupRef) ||
            !Number.isSafeInteger(version) ||
            !isRtcTopologyEndpointPair(pair) ||
            receiptId !==
                toRtcRttMutationReceiptId({
                    sessionIdFrom: pair[0],
                    sessionIdTo: pair[1],
                    version,
                })
        ) {
            return null;
        }
        return { receiptId, version };
    } catch {
        return null;
    }
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

function isRtcTopologyEndpointPair(
    value: unknown,
): value is readonly [string, string] {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every(
            (endpoint) => typeof endpoint === 'string' && endpoint.length > 0,
        )
    );
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
