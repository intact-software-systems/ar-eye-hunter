import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import {
    toCanonicalRtcTopologyGroupIdentity,
    toCanonicalRtcTopologyPairIdentity,
} from '../../rtc-topology-identifiers.ts';

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
