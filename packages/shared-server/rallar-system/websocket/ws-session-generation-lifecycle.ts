import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '../../runtime-state/RuntimeStateRepository.ts';

const SESSION_CLOSE_HIGH_WATER_NAMESPACE = 'ws-session-close-high-water';

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
    readonly entry: RuntimeStateEntry | null;
    readonly state: WsSessionCloseHighWaterState | null;
}

export interface WsSessionGenerationLifecycleComputed {
    readonly outcome: 'none' | 'insert' | 'update';
    readonly key: string;
    readonly expectedRevision: number | null;
    readonly state: WsSessionCloseHighWaterState;
}

export interface WsSessionGenerationLifecycleService {
    read(identity: WsSessionHighWaterIdentity): Promise<WsSessionGenerationLifecycleRead>;
    isGenerationClosed(
        facts: WsSessionGenerationFacts,
        read: WsSessionGenerationLifecycleRead
    ): boolean;
    isObservedAtClosed(
        identity: WsSessionHighWaterIdentity,
        observedAtEpochMs: number,
        read: WsSessionGenerationLifecycleRead
    ): boolean;
    computeClosed(
        facts: WsSessionGenerationCloseFacts,
        read: WsSessionGenerationLifecycleRead
    ): WsSessionGenerationLifecycleComputed;
    computeConnectGuard(
        facts: WsSessionGenerationGuardFacts,
        read: WsSessionGenerationLifecycleRead
    ): WsSessionGenerationLifecycleComputed;
    write(
        transaction: PSqlTransactionSql,
        computed: WsSessionGenerationLifecycleComputed
    ): Promise<void>;
}

export function createWsSessionGenerationLifecycleService(
    repository: RuntimeStateOptimisticTransactionalRepositoryLike
): WsSessionGenerationLifecycleService {
    return {
        read: async (identity) => {
            validateIdentity(identity);
            const key = toLifecycleKey(identity);
            const entry = await repository.findEntry(SESSION_CLOSE_HIGH_WATER_NAMESPACE, key);
            return {
                identity,
                key,
                entry: entry ?? null,
                state: entry ? readHighWaterState(entry.value, identity) : null
            };
        },
        isGenerationClosed: (facts, read) => {
            validateGenerationFacts(facts);
            validateRead(facts, read);
            return read.state?.status === 'closed' && compareGeneration(facts, read.state) <= 0;
        },
        isObservedAtClosed: (identity, observedAtEpochMs, read) => {
            validateRead(identity, read);
            validateTimestamp(observedAtEpochMs, 'WebSocket session observation');
            return read.state?.status === 'closed' &&
                observedAtEpochMs <= read.state.disconnectedAtEpochMs;
        },
        computeClosed: (facts, read) => {
            validateCloseFacts(facts);
            validateRead(facts, read);
            const incoming = toHighWaterState(facts);
            if (!read.state) {
                return toComputed('insert', read, incoming);
            }
            if (read.state.status === 'open') {
                return toComputed('update', read, incoming);
            }
            const selected = selectHighWater(read.state, incoming);
            return sameHighWaterState(read.state, selected)
                ? toComputed('none', read, read.state)
                : toComputed('update', read, selected);
        },
        computeConnectGuard: (facts, read) => {
            validateGuardFacts(facts);
            validateRead(facts, read);
            if (!read.state) {
                return toComputed('insert', read, toOpenState(facts));
            }
            const expireAtEpochMs = Math.max(read.state.expireAtEpochMs, facts.expireAtEpochMs);
            const state = read.state.status === 'closed'
                ? { ...read.state, expireAtEpochMs }
                : toOpenState(
                    compareGeneration(facts, read.state) >= 0
                        ? { ...facts, expireAtEpochMs }
                        : { ...read.state, expireAtEpochMs }
                );
            return toComputed('update', read, state);
        },
        write: async (transaction, computed) => {
            if (computed.outcome === 'none') {
                return;
            }
            const target = new PSqlRuntimeStateRepository(transaction);
            const value = JSON.stringify(computed.state);
            const result = computed.outcome === 'insert'
                ? await target.insertIfAbsent(
                    SESSION_CLOSE_HIGH_WATER_NAMESPACE,
                    computed.key,
                    value,
                    computed.state.expireAtEpochMs
                )
                : await target.upsertIfRevision(
                    SESSION_CLOSE_HIGH_WATER_NAMESPACE,
                    computed.key,
                    value,
                    computed.state.expireAtEpochMs,
                    requireExpectedRevision(computed)
                );
            if (result.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        }
    };
}

function selectHighWater(
    current: WsSessionClosedHighWaterState,
    incoming: WsSessionClosedHighWaterState
): WsSessionClosedHighWaterState {
    const order = compareClose(incoming, current);
    const winner = order > 0 ? incoming : current;
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
    return {
        outcome,
        key: read.key,
        expectedRevision: read.entry?.revision ?? null,
        state
    };
}

function toHighWaterState(
    facts: WsSessionGenerationCloseFacts
): WsSessionClosedHighWaterState {
    return { version: 3, status: 'closed', ...facts };
}

function toOpenState(
    facts: WsSessionGenerationGuardFacts
): WsSessionOpenGuardState {
    return { version: 3, status: 'open', ...facts };
}

function readHighWaterState(
    value: string,
    identity: WsSessionHighWaterIdentity
): WsSessionCloseHighWaterState {
    const decoded = JSON.parse(value) as
        | WsSessionCloseHighWaterState
        | Readonly<WsSessionGenerationCloseFacts & { version: 2; }>;
    if (decoded.version === 2) {
        validateCloseFacts(decoded);
        if (!sameIdentity(decoded, identity)) {
            throw new TypeError('WebSocket session close high-water state is invalid');
        }
        return { ...decoded, version: 3, status: 'closed' };
    }
    const state = decoded;
    if (state.version !== 3 || !sameIdentity(state, identity)) {
        throw new TypeError('WebSocket session close high-water state is invalid');
    }
    if (state.status === 'closed') {
        validateCloseFacts(state);
    }
    else if (state.status === 'open') {
        validateGuardFacts(state);
    }
    else {
        throw new TypeError('WebSocket session close high-water state is invalid');
    }
    return state;
}

function validateRead(
    identity: WsSessionHighWaterIdentity,
    read: WsSessionGenerationLifecycleRead
): void {
    validateIdentity(identity);
    if (
        read.key !== toLifecycleKey(identity) ||
        !sameIdentity(read.identity, identity) ||
        (read.entry === null) !== (read.state === null)
    ) {
        throw new TypeError('WebSocket session close high-water read is invalid');
    }
}

function validateGenerationFacts(facts: WsSessionGenerationFacts): void {
    validateIdentity(facts);
    if (!facts.generationId) {
        throw new TypeError('WebSocket generation id is required');
    }
    validateTimestamp(facts.generationStartedAtEpochMs, 'WebSocket generation start');
}

function validateGuardFacts(facts: WsSessionGenerationGuardFacts): void {
    validateGenerationFacts(facts);
    validateTimestamp(facts.expireAtEpochMs, 'WebSocket session guard expiry');
    if (facts.expireAtEpochMs < facts.generationStartedAtEpochMs) {
        throw new TypeError('WebSocket session guard facts are invalid');
    }
}

function validateCloseFacts(facts: WsSessionGenerationCloseFacts): void {
    validateGenerationFacts(facts);
    validateTimestamp(facts.disconnectedAtEpochMs, 'WebSocket disconnect');
    validateTimestamp(facts.expireAtEpochMs, 'WebSocket close high-water expiry');
    if (
        facts.disconnectedAtEpochMs < facts.generationStartedAtEpochMs ||
        facts.expireAtEpochMs < facts.disconnectedAtEpochMs ||
        !facts.reason
    ) {
        throw new TypeError('WebSocket session close facts are invalid');
    }
}

function validateIdentity(identity: WsSessionHighWaterIdentity): void {
    const scope = identity.scope;
    if (
        !identity.sessionId || !scope.applicationId || !scope.workspaceId ||
        !scope.principalId || (scope.kind === 'client' && !scope.clientInstanceId)
    ) {
        throw new TypeError('WebSocket session high-water identity is invalid');
    }
}

function validateTimestamp(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
}

function sameIdentity(
    left: WsSessionHighWaterIdentity,
    right: WsSessionHighWaterIdentity
): boolean {
    return toLifecycleKey(left) === toLifecycleKey(right);
}

function toLifecycleKey(identity: WsSessionHighWaterIdentity): string {
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

function requireExpectedRevision(computed: WsSessionGenerationLifecycleComputed): number {
    if (computed.expectedRevision === null) {
        throw new TypeError('WebSocket session close high-water update revision is missing');
    }
    return computed.expectedRevision;
}

function sameHighWaterState(
    left: WsSessionCloseHighWaterState,
    right: WsSessionCloseHighWaterState
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
