import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';

import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { compareRtcTopologyIdentifiers } from './rtc-topology-identifiers.ts';

interface DecodeRtcTopologySnapshotRoutingInput {
    readonly activeSessionIds: JsonWireValue;
    readonly nextHopsBySessionId: JsonWireValue;
    readonly state: 'active' | 'removed';
    readonly degreeLimit: number;
}

interface RtcTopologySnapshotRouting {
    readonly activeSessionIds: readonly string[];
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

export function decodeRtcTopologySnapshotRouting(
    input: DecodeRtcTopologySnapshotRoutingInput
): RtcTopologySnapshotRouting {
    const activeSessionIds = decodeCanonicalIdentifiers(
        input.activeSessionIds,
        'active sessions'
    );
    const activeSessionIdSet = new Set(activeSessionIds);
    const encodedNextHops = requireJsonWireObject(
        input.nextHopsBySessionId,
        'RTC topology snapshot next hops'
    );
    requireRoutingKeys(encodedNextHops, activeSessionIdSet);

    const nextHopsBySessionId: Record<string, readonly string[]> = {};
    for (const sessionId of activeSessionIds) {
        nextHopsBySessionId[sessionId] = decodeCanonicalIdentifiers(
            encodedNextHops[sessionId]!,
            `next hops for ${sessionId}`
        );
    }
    validateRoutingRelationships({
        activeSessionIds: activeSessionIdSet,
        nextHopsBySessionId,
        state: input.state
    });
    validateActiveGraph({
        activeSessionIds: activeSessionIdSet,
        nextHopsBySessionId,
        state: input.state,
        degreeLimit: input.degreeLimit
    });
    return { activeSessionIds, nextHopsBySessionId };
}

function requireRoutingKeys(
    nextHopsBySessionId: JsonWireObject,
    activeSessionIds: ReadonlySet<string>
): void {
    const routeSessionIds = Object.keys(nextHopsBySessionId);
    if (
        routeSessionIds.length !== activeSessionIds.size ||
        routeSessionIds.some((sessionId) => !activeSessionIds.has(sessionId))
    ) {
        throw new TypeError('RTC topology snapshot routing keys differ from active sessions');
    }
}

interface ValidateRoutingRelationshipsInput {
    readonly activeSessionIds: ReadonlySet<string>;
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
    readonly state: 'active' | 'removed';
}

function validateRoutingRelationships(input: ValidateRoutingRelationshipsInput): void {
    for (const [sessionId, peerSessionIds] of Object.entries(input.nextHopsBySessionId)) {
        for (const peerSessionId of peerSessionIds) {
            requireValidPeer(input, sessionId, peerSessionId);
        }
        if (input.state === 'removed' && peerSessionIds.length > 0) {
            throw new TypeError('RTC topology removed snapshot contains active edges');
        }
    }
}

function requireValidPeer(
    input: ValidateRoutingRelationshipsInput,
    sessionId: string,
    peerSessionId: string
): void {
    if (peerSessionId === sessionId || !input.activeSessionIds.has(peerSessionId)) {
        throw new TypeError('RTC topology snapshot next hop identity is invalid');
    }
    if (!input.nextHopsBySessionId[peerSessionId]?.includes(sessionId)) {
        throw new TypeError('RTC topology snapshot next hops are not reciprocal');
    }
}

interface ValidateActiveGraphInput extends ValidateRoutingRelationshipsInput {
    readonly degreeLimit: number;
}

function validateActiveGraph(input: ValidateActiveGraphInput): void {
    if (input.state !== 'active') {
        return;
    }
    const validation = validateGroupTopologyNextHops({
        nextHopsBySessionId: input.nextHopsBySessionId,
        activeSessionIds: input.activeSessionIds,
        maxDegree: input.degreeLimit,
        requireConnected: true
    });
    if (!validation.valid) {
        throw new TypeError(
            `RTC topology snapshot graph is invalid: ${validation.issues.map((issue) => issue.code).join(',')}`
        );
    }
}

function decodeCanonicalIdentifiers(
    value: JsonWireValue,
    label: string
): readonly string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`RTC topology snapshot ${label} are invalid`);
    }
    const identifiers = value.map((entry) => requireNonEmptyString(entry, label));
    for (let index = 1; index < identifiers.length; index += 1) {
        if (compareRtcTopologyIdentifiers(identifiers[index - 1]!, identifiers[index]!) >= 0) {
            throw new TypeError(`RTC topology snapshot ${label} are not canonical`);
        }
    }
    return identifiers;
}

function requireNonEmptyString(
    value: JsonWireValue,
    label: string
): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC topology snapshot ${label} contain an empty identity`);
    }
    return value;
}

function requireJsonWireObject(
    value: JsonWireValue,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
