import { requireEpoch, requireExactKeys, requireString } from '../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../protocol/json-wire-identity.ts';

export type WsSessionHighWaterScope =
    | Readonly<{
        kind: 'client';
        applicationId: string;
        workspaceId: string;
        principalId: string;
        clientInstanceId: string;
    }>
    | Readonly<{
        kind: 'group';
        applicationId: string;
        workspaceId: string;
        principalId: string;
    }>;

export interface WsSessionHighWaterIdentity {
    readonly scope: WsSessionHighWaterScope;
    readonly sessionId: string;
}

export interface WsSessionGenerationFacts extends WsSessionHighWaterIdentity {
    readonly generationId: string;
    readonly generationStartedAtEpochMs: number;
}

export interface WsSessionGenerationCloseFacts extends WsSessionGenerationFacts {
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
    readonly expireAtEpochMs: number;
}

export interface WsSessionGenerationGuardFacts extends WsSessionGenerationFacts {
    readonly expireAtEpochMs: number;
}

type WsSessionOpenGuardState = Readonly<
    WsSessionGenerationGuardFacts & {
        version: 3;
        status: 'open';
    }
>;

type WsSessionClosedHighWaterState = Readonly<
    WsSessionGenerationCloseFacts & {
        version: 3;
        status: 'closed';
    }
>;

export type WsSessionCloseHighWaterState =
    | WsSessionOpenGuardState
    | WsSessionClosedHighWaterState;

export interface WsSessionGenerationLifecycleRead {
    readonly identity: WsSessionHighWaterIdentity;
    readonly key: string;
    readonly revision: number | null;
    readonly persistedExpireAtEpochMs: number | null;
    readonly state: WsSessionCloseHighWaterState | null;
}

type WsSessionGenerationLifecycleComputedValue = Readonly<{
    readonly key: string;
    readonly state: WsSessionCloseHighWaterState;
    readonly value: string;
    readonly expireAtIsoTimestamp: string;
}>;

export type WsSessionGenerationLifecycleComputed =
    & WsSessionGenerationLifecycleComputedValue
    & (
        | Readonly<{ outcome: 'none'; expectedRevision: number | null; }>
        | Readonly<{ outcome: 'insert'; expectedRevision: null; }>
        | Readonly<{ outcome: 'update'; expectedRevision: number; }>
    );

export function isWsSessionGenerationClosed(
    facts: WsSessionGenerationFacts,
    read: WsSessionGenerationLifecycleRead
): boolean {
    requireGenerationFacts(facts);
    requireLifecycleRead(facts, read);
    return read.state?.status === 'closed' && compareGeneration(facts, read.state) <= 0;
}

export function isWsSessionObservedAtClosed(
    identity: WsSessionHighWaterIdentity,
    observedAtEpochMs: number,
    read: WsSessionGenerationLifecycleRead
): boolean {
    requireLifecycleRead(identity, read);
    requireEpoch(observedAtEpochMs, 'WebSocket session observation');
    return read.state?.status === 'closed' &&
        observedAtEpochMs <= read.state.disconnectedAtEpochMs;
}

export function computeWsSessionGenerationClosed(
    facts: WsSessionGenerationCloseFacts,
    read: WsSessionGenerationLifecycleRead
): WsSessionGenerationLifecycleComputed {
    requireCloseFacts(facts);
    requireLifecycleRead(facts, read);
    const incoming = toClosedHighWaterState(facts);
    if (!read.state) {
        return toComputed('insert', read, incoming);
    }
    if (read.state.status === 'open') {
        return toComputed('update', read, incoming);
    }
    const selected = selectClosedHighWater(read.state, incoming);
    return sameHighWaterState(read.state, selected)
        ? toComputed('none', read, read.state)
        : toComputed('update', read, selected);
}

export function computeWsSessionConnectGuard(
    facts: WsSessionGenerationGuardFacts,
    read: WsSessionGenerationLifecycleRead
): WsSessionGenerationLifecycleComputed {
    requireGuardFacts(facts);
    requireLifecycleRead(facts, read);
    if (!read.state) {
        return toComputed('insert', read, toOpenGuardState(facts));
    }
    const expireAtEpochMs = Math.max(read.state.expireAtEpochMs, facts.expireAtEpochMs);
    const state = read.state.status === 'closed'
        ? { ...read.state, expireAtEpochMs }
        : toOpenGuardState(
            compareGeneration(facts, read.state) >= 0
                ? { ...facts, expireAtEpochMs }
                : { ...read.state, expireAtEpochMs }
        );
    return toComputed('update', read, state);
}

export function validateWsSessionGenerationClosed(
    facts: WsSessionGenerationCloseFacts,
    read: WsSessionGenerationLifecycleRead,
    computed: WsSessionGenerationLifecycleComputed
): void {
    validateWsSessionGenerationLifecycleComputed(
        computeWsSessionGenerationClosed(facts, read),
        computed
    );
}

export function validateWsSessionConnectGuard(
    facts: WsSessionGenerationGuardFacts,
    read: WsSessionGenerationLifecycleRead,
    computed: WsSessionGenerationLifecycleComputed
): void {
    validateWsSessionGenerationLifecycleComputed(
        computeWsSessionConnectGuard(facts, read),
        computed
    );
}

export function decodeWsSessionCloseHighWaterState(
    value: JsonWireValue,
    identity: WsSessionHighWaterIdentity
): WsSessionCloseHighWaterState {
    const state = requireJsonWireObject(value, 'WebSocket session close high-water state');
    if (state.version !== 3 || (state.status !== 'open' && state.status !== 'closed')) {
        throw invalidHighWaterState();
    }
    requireExactKeys(
        state,
        state.status === 'closed'
            ? [
                'version',
                'status',
                'scope',
                'sessionId',
                'generationId',
                'generationStartedAtEpochMs',
                'disconnectedAtEpochMs',
                'reason',
                'expireAtEpochMs'
            ]
            : [
                'version',
                'status',
                'scope',
                'sessionId',
                'generationId',
                'generationStartedAtEpochMs',
                'expireAtEpochMs'
            ],
        'WebSocket session close high-water state'
    );
    const scope = decodeWsSessionHighWaterScope(state.scope);
    requireString(state.sessionId, 'WebSocket session id');
    const decodedIdentity: WsSessionHighWaterIdentity = {
        scope,
        sessionId: state.sessionId
    };
    if (!sameIdentity(decodedIdentity, identity)) {
        throw invalidHighWaterState();
    }
    requireString(state.generationId, 'WebSocket generation id');
    const generationStartedAtEpochMs = decodeEpoch(
        state.generationStartedAtEpochMs,
        'WebSocket generation start'
    );
    const expireAtEpochMs = decodeEpoch(
        state.expireAtEpochMs,
        'WebSocket session high-water expiry'
    );
    const generation: WsSessionGenerationFacts = {
        ...decodedIdentity,
        generationId: state.generationId,
        generationStartedAtEpochMs
    };

    if (state.status === 'closed') {
        const disconnectedAtEpochMs = decodeEpoch(
            state.disconnectedAtEpochMs,
            'WebSocket disconnect'
        );
        requireString(state.reason, 'WebSocket disconnect reason');
        const decoded: WsSessionClosedHighWaterState = {
            version: 3,
            status: 'closed',
            ...generation,
            disconnectedAtEpochMs,
            reason: state.reason,
            expireAtEpochMs
        };
        requireCloseFacts(decoded);
        return decoded;
    }

    const decoded: WsSessionOpenGuardState = {
        version: 3,
        status: 'open',
        ...generation,
        expireAtEpochMs
    };
    requireGuardFacts(decoded);
    return decoded;
}

export function toWsSessionLifecycleKey(identity: WsSessionHighWaterIdentity): string {
    requireIdentity(identity);
    const scope = identity.scope;
    const values = scope.kind === 'client'
        ? [
            scope.kind,
            scope.applicationId,
            scope.workspaceId,
            scope.principalId,
            scope.clientInstanceId,
            identity.sessionId
        ]
        : [scope.kind, scope.applicationId, scope.workspaceId, scope.principalId, identity.sessionId];
    return values.map(encodeURIComponent).join(':');
}

function decodeWsSessionHighWaterScope(value: JsonWireValue): WsSessionHighWaterScope {
    const scope = requireJsonWireObject(value, 'WebSocket session high-water scope');
    if (scope.kind !== 'client' && scope.kind !== 'group') {
        throw invalidHighWaterState();
    }
    requireExactKeys(
        scope,
        scope.kind === 'client'
            ? ['kind', 'applicationId', 'workspaceId', 'principalId', 'clientInstanceId']
            : ['kind', 'applicationId', 'workspaceId', 'principalId'],
        'WebSocket session high-water scope'
    );
    requireString(scope.applicationId, 'WebSocket session application id');
    requireString(scope.workspaceId, 'WebSocket session workspace id');
    requireString(scope.principalId, 'WebSocket session principal id');
    if (scope.kind === 'client') {
        requireString(scope.clientInstanceId, 'WebSocket session client instance id');
        return {
            kind: 'client',
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            clientInstanceId: scope.clientInstanceId
        };
    }
    return {
        kind: 'group',
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId
    };
}

function selectClosedHighWater(
    current: WsSessionClosedHighWaterState,
    incoming: WsSessionClosedHighWaterState
): WsSessionClosedHighWaterState {
    const winner = compareClose(incoming, current) > 0 ? incoming : current;
    const expireAtEpochMs = Math.max(current.expireAtEpochMs, incoming.expireAtEpochMs);
    return expireAtEpochMs === winner.expireAtEpochMs ? winner : { ...winner, expireAtEpochMs };
}

function compareClose(
    left: WsSessionGenerationCloseFacts,
    right: WsSessionGenerationCloseFacts
): number {
    return compareGeneration(left, right) ||
        left.disconnectedAtEpochMs - right.disconnectedAtEpochMs;
}

function compareGeneration(
    left: Pick<WsSessionGenerationFacts, 'generationStartedAtEpochMs' | 'generationId'>,
    right: Pick<WsSessionGenerationFacts, 'generationStartedAtEpochMs' | 'generationId'>
): number {
    return left.generationStartedAtEpochMs - right.generationStartedAtEpochMs ||
        left.generationId.localeCompare(right.generationId);
}

function toComputed(
    outcome: WsSessionGenerationLifecycleComputed['outcome'],
    read: WsSessionGenerationLifecycleRead,
    state: WsSessionCloseHighWaterState
): WsSessionGenerationLifecycleComputed {
    const value = {
        key: read.key,
        state,
        value: JSON.stringify(state),
        expireAtIsoTimestamp: new Date(state.expireAtEpochMs).toISOString()
    };
    if (outcome === 'insert') {
        return { ...value, outcome, expectedRevision: null };
    }
    if (outcome === 'update') {
        if (read.revision === null) {
            throw new TypeError('WebSocket session close high-water update revision is missing');
        }
        return { ...value, outcome, expectedRevision: read.revision };
    }
    return { ...value, outcome, expectedRevision: read.revision };
}

function validateWsSessionGenerationLifecycleComputed(
    expected: WsSessionGenerationLifecycleComputed,
    computed: WsSessionGenerationLifecycleComputed
): void {
    if (
        expected.outcome !== computed.outcome ||
        expected.key !== computed.key ||
        expected.expectedRevision !== computed.expectedRevision ||
        expected.value !== computed.value ||
        expected.expireAtIsoTimestamp !== computed.expireAtIsoTimestamp ||
        JSON.stringify(expected.state) !== JSON.stringify(computed.state)
    ) {
        throw new TypeError('WebSocket session lifecycle computed result differs');
    }
}

function toClosedHighWaterState(
    facts: WsSessionGenerationCloseFacts
): WsSessionClosedHighWaterState {
    return { version: 3, status: 'closed', ...facts };
}

function toOpenGuardState(
    facts: WsSessionGenerationGuardFacts
): WsSessionOpenGuardState {
    return { version: 3, status: 'open', ...facts };
}

function requireLifecycleRead(
    identity: WsSessionHighWaterIdentity,
    read: WsSessionGenerationLifecycleRead
): void {
    requireIdentity(identity);
    if (
        read.key !== toWsSessionLifecycleKey(identity) ||
        !sameIdentity(read.identity, identity) ||
        (read.revision === null) !== (read.state === null) ||
        (read.persistedExpireAtEpochMs === null) !== (read.state === null)
    ) {
        throw new TypeError('WebSocket session close high-water read is invalid');
    }
}

function requireGenerationFacts(facts: WsSessionGenerationFacts): void {
    requireIdentity(facts);
    requireString(facts.generationId, 'WebSocket generation id');
    requireEpoch(facts.generationStartedAtEpochMs, 'WebSocket generation start');
}

function requireGuardFacts(facts: WsSessionGenerationGuardFacts): void {
    requireGenerationFacts(facts);
    requireEpoch(facts.expireAtEpochMs, 'WebSocket session guard expiry');
    if (facts.expireAtEpochMs < facts.generationStartedAtEpochMs) {
        throw new TypeError('WebSocket session guard facts are invalid');
    }
}

function requireCloseFacts(facts: WsSessionGenerationCloseFacts): void {
    requireGenerationFacts(facts);
    requireEpoch(facts.disconnectedAtEpochMs, 'WebSocket disconnect');
    requireEpoch(facts.expireAtEpochMs, 'WebSocket close high-water expiry');
    requireString(facts.reason, 'WebSocket disconnect reason');
    if (
        facts.disconnectedAtEpochMs < facts.generationStartedAtEpochMs ||
        facts.expireAtEpochMs < facts.disconnectedAtEpochMs
    ) {
        throw new TypeError('WebSocket session close facts are invalid');
    }
}

function requireIdentity(identity: WsSessionHighWaterIdentity): void {
    requireString(identity.sessionId, 'WebSocket session id');
    requireString(identity.scope.applicationId, 'WebSocket session application id');
    requireString(identity.scope.workspaceId, 'WebSocket session workspace id');
    requireString(identity.scope.principalId, 'WebSocket session principal id');
    if (identity.scope.kind === 'client') {
        requireString(identity.scope.clientInstanceId, 'WebSocket session client instance id');
    }
}

function sameIdentity(
    left: WsSessionHighWaterIdentity,
    right: WsSessionHighWaterIdentity
): boolean {
    return toWsSessionLifecycleKey(left) === toWsSessionLifecycleKey(right);
}

function sameHighWaterState(
    left: WsSessionCloseHighWaterState,
    right: WsSessionCloseHighWaterState
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function invalidHighWaterState(): TypeError {
    return new TypeError('WebSocket session close high-water state is invalid');
}

function decodeEpoch(value: JsonWireValue, label: string): number {
    requireEpoch(value, label);
    return value as number;
}

function requireJsonWireObject(value: JsonWireValue, label: string): JsonWireObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value as JsonWireObject;
}
