import { types } from 'node:util';

import {
    isValidRuntimeStateExpectedRevision,
    isValidRuntimeStateUpsertExpectedRevision
} from '../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';

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

export interface WsSessionGenerationValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

export type WsSessionGenerationLifecycleComputed =
    & WsSessionGenerationPersistence
    & (
        | { readonly outcome: 'insert'; readonly expectedRevision: null; }
        | { readonly outcome: 'none' | 'update'; readonly expectedRevision: number; }
    );

interface WsSessionGenerationPersistence {
    readonly key: string;
    readonly state: WsSessionCloseHighWaterState;
    readonly value: string;
    readonly expireAtIsoTimestamp: string;
}

interface WsSessionFieldsValidationInput {
    readonly value: Record<string, unknown>;
    readonly keys: readonly string[];
    readonly path: string;
    readonly message: string;
}

export function isWsSessionGenerationClosed(
    facts: WsSessionGenerationFacts,
    read: WsSessionGenerationLifecycleRead
): boolean {
    const issues = [...validateGenerationFacts(facts), ...validateLifecycleRead(facts, read)];
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return read.state?.status === 'closed' && compareGeneration(facts, read.state) <= 0;
}

export function isWsSessionObservedAtClosed(
    identity: WsSessionHighWaterIdentity,
    observedAtEpochMs: number,
    read: WsSessionGenerationLifecycleRead
): boolean {
    const issues = [
        ...validateLifecycleRead(identity, read),
        ...validateEpoch(observedAtEpochMs, 'observedAtEpochMs', 'WebSocket session observation')
    ];
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return read.state?.status === 'closed' &&
        observedAtEpochMs <= read.state.disconnectedAtEpochMs;
}

export function computeWsSessionGenerationClosed(
    facts: WsSessionGenerationCloseFacts,
    read: WsSessionGenerationLifecycleRead
): WsSessionGenerationLifecycleComputed {
    const issues = [...validateCloseFacts(facts), ...validateLifecycleRead(facts, read)];
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    const incoming = toClosedHighWaterState(facts);
    if (!read.state) {
        return toComputed('insert', read, incoming);
    }
    if (read.state.status === 'open') {
        return toComputed('update', read, incoming);
    }
    const selected = computeClosedHighWater(read.state, incoming);
    return isSameHighWaterState(read.state, selected)
        ? toComputed('none', read, read.state)
        : toComputed('update', read, selected);
}

export function computeWsSessionConnectGuard(
    facts: WsSessionGenerationGuardFacts,
    read: WsSessionGenerationLifecycleRead
): WsSessionGenerationLifecycleComputed {
    const issues = [...validateGuardFacts(facts), ...validateLifecycleRead(facts, read)];
    if (issues.length > 0) {
        throw issues[0].cause;
    }
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

export function validateWsSessionConnectGuard(
    facts: WsSessionGenerationGuardFacts,
    read: WsSessionGenerationLifecycleRead,
    computed: WsSessionGenerationLifecycleComputed
): readonly WsSessionGenerationValidationIssue[] {
    const issues = [...validateGuardFacts(facts), ...validateLifecycleRead(facts, read)];
    return issues.length > 0
        ? [...issues, ...validateComputedShape(computed)]
        : [
            ...validateExpectedValue(computed, computeWsSessionConnectGuard(facts, read), 'computed'),
            ...validateComputedShape(computed)
        ];
}

export function validateWsSessionGenerationClosed(
    facts: WsSessionGenerationCloseFacts,
    read: WsSessionGenerationLifecycleRead,
    computed: WsSessionGenerationLifecycleComputed
): readonly WsSessionGenerationValidationIssue[] {
    const issues = [...validateCloseFacts(facts), ...validateLifecycleRead(facts, read)];
    return issues.length > 0
        ? [...issues, ...validateComputedShape(computed)]
        : [
            ...validateExpectedValue(computed, computeWsSessionGenerationClosed(facts, read), 'computed'),
            ...validateComputedShape(computed)
        ];
}

export function decodeWsSessionCloseHighWaterState(
    value: JsonWireValue,
    identity: WsSessionHighWaterIdentity
): WsSessionCloseHighWaterState {
    const issues = [
        ...validateHighWaterState(value, 'state'),
        ...validateIdentity(identity, 'identity')
    ];
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    const state = value as WsSessionCloseHighWaterState;
    if (!isSameIdentity(state, identity)) {
        throw new TypeError('WebSocket session close high-water state is invalid');
    }
    const scope: WsSessionHighWaterScope = state.scope.kind === 'client'
        ? {
            kind: 'client',
            applicationId: state.scope.applicationId,
            workspaceId: state.scope.workspaceId,
            principalId: state.scope.principalId,
            clientInstanceId: state.scope.clientInstanceId
        }
        : {
            kind: 'group',
            applicationId: state.scope.applicationId,
            workspaceId: state.scope.workspaceId,
            principalId: state.scope.principalId
        };
    const generation = {
        scope,
        sessionId: state.sessionId,
        generationId: state.generationId,
        generationStartedAtEpochMs: state.generationStartedAtEpochMs
    };
    return state.status === 'closed'
        ? {
            version: 3,
            status: 'closed',
            ...generation,
            disconnectedAtEpochMs: state.disconnectedAtEpochMs,
            reason: state.reason,
            expireAtEpochMs: state.expireAtEpochMs
        }
        : { version: 3, status: 'open', ...generation, expireAtEpochMs: state.expireAtEpochMs };
}

export function toWsSessionLifecycleKey(identity: WsSessionHighWaterIdentity): string {
    const issues = validateIdentity(identity, 'identity');
    if (issues.length > 0) {
        throw issues[0].cause;
    }
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

function computeClosedHighWater(
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
    const persistence = computePersistence(read.key, state);
    if (outcome === 'insert') {
        return { ...persistence, outcome, expectedRevision: null };
    }
    if (read.revision === null) {
        throw new TypeError('WebSocket session close high-water update revision is missing');
    }
    return { ...persistence, outcome, expectedRevision: read.revision };
}

function toClosedHighWaterState(
    facts: WsSessionGenerationCloseFacts
): WsSessionClosedHighWaterState {
    return {
        version: 3,
        status: 'closed',
        scope: facts.scope,
        sessionId: facts.sessionId,
        generationId: facts.generationId,
        generationStartedAtEpochMs: facts.generationStartedAtEpochMs,
        disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
        reason: facts.reason,
        expireAtEpochMs: facts.expireAtEpochMs
    };
}

function toOpenGuardState(
    facts: WsSessionGenerationGuardFacts
): WsSessionOpenGuardState {
    return {
        version: 3,
        status: 'open',
        scope: facts.scope,
        sessionId: facts.sessionId,
        generationId: facts.generationId,
        generationStartedAtEpochMs: facts.generationStartedAtEpochMs,
        expireAtEpochMs: facts.expireAtEpochMs
    };
}

function computePersistence(key: string, state: WsSessionCloseHighWaterState): WsSessionGenerationPersistence {
    return {
        key,
        state,
        value: JSON.stringify(state),
        expireAtIsoTimestamp: new Date(state.expireAtEpochMs).toISOString()
    };
}

function validateLifecycleRead(
    identity: WsSessionHighWaterIdentity,
    read: WsSessionGenerationLifecycleRead
): readonly WsSessionGenerationValidationIssue[] {
    const identityIssues = validateIdentity(identity, 'facts');
    if (!isDataRecord(read)) {
        return [...identityIssues, toValidationIssue('read', 'WebSocket session close high-water read is invalid')];
    }
    const issues = [...identityIssues, ...validateIdentity(read.identity, 'read.identity')];
    if (identityIssues.length === 0) {
        if (isDataRecord(read.identity)) {
            issues.push(...validateExpectedValue(read.identity.scope, identity.scope, 'read.identity.scope'));
            issues.push(
                ...validateExpectedValue(read.identity.sessionId, identity.sessionId, 'read.identity.sessionId')
            );
        }
        if (read.key !== toWsSessionLifecycleKey(identity)) {
            issues.push(toValidationIssue('read.key', 'WebSocket session close high-water read is invalid'));
        }
    }
    if ((read.revision === null) !== (read.state === null)) {
        issues.push(toValidationIssue('read.revision', 'WebSocket session close high-water read is invalid'));
    }
    if (read.revision !== null && !isValidRuntimeStateExpectedRevision(read.revision)) {
        issues.push(toValidationIssue('read.revision', 'WebSocket session storage read.revision is invalid'));
    }
    if (read.state !== null) {
        issues.push(...validateHighWaterState(read.state, 'read.state'));
        if (isDataRecord(read.state) && identityIssues.length === 0) {
            issues.push(...validateExpectedValue(read.state.scope, identity.scope, 'read.state.scope'));
            issues.push(...validateExpectedValue(read.state.sessionId, identity.sessionId, 'read.state.sessionId'));
        }
    }
    if (
        (read.state === null || isDataRecord(read.state)) &&
        read.persistedExpireAtEpochMs !== (read.state?.expireAtEpochMs ?? null)
    ) {
        issues.push(
            toValidationIssue(
                'read.persistedExpireAtEpochMs',
                'WebSocket session close high-water row expiry is invalid'
            )
        );
    }
    return issues;
}

function validateGenerationFacts(facts: unknown, path = 'facts'): readonly WsSessionGenerationValidationIssue[] {
    const issues = [...validateIdentity(facts, path)];
    if (isDataRecord(facts)) {
        issues.push(...validateString(facts.generationId, `${path}.generationId`, 'WebSocket generation id'));
        issues.push(
            ...validateEpoch(
                facts.generationStartedAtEpochMs,
                `${path}.generationStartedAtEpochMs`,
                'WebSocket generation start'
            )
        );
    }
    return issues;
}

function validateGuardFacts(facts: unknown, path = 'facts'): readonly WsSessionGenerationValidationIssue[] {
    const issues = [...validateGenerationFacts(facts, path)];
    if (!isDataRecord(facts)) {
        return issues;
    }
    issues.push(...validateExpiry(facts.expireAtEpochMs, `${path}.expireAtEpochMs`, 'WebSocket session guard expiry'));
    if (
        typeof facts.expireAtEpochMs === 'number' && typeof facts.generationStartedAtEpochMs === 'number' &&
        facts.expireAtEpochMs < facts.generationStartedAtEpochMs
    ) {
        issues.push(toValidationIssue(`${path}.expireAtEpochMs`, 'WebSocket session guard facts are invalid'));
    }
    return issues;
}

function validateCloseFacts(facts: unknown, path = 'facts'): readonly WsSessionGenerationValidationIssue[] {
    const issues = [...validateGenerationFacts(facts, path)];
    if (!isDataRecord(facts)) {
        return issues;
    }
    issues.push(...validateEpoch(facts.disconnectedAtEpochMs, `${path}.disconnectedAtEpochMs`, 'WebSocket disconnect'));
    issues.push(
        ...validateExpiry(facts.expireAtEpochMs, `${path}.expireAtEpochMs`, 'WebSocket close high-water expiry')
    );
    issues.push(...validateString(facts.reason, `${path}.reason`, 'WebSocket disconnect reason'));
    if (
        typeof facts.disconnectedAtEpochMs === 'number' && typeof facts.generationStartedAtEpochMs === 'number' &&
        facts.disconnectedAtEpochMs < facts.generationStartedAtEpochMs
    ) {
        issues.push(toValidationIssue(`${path}.disconnectedAtEpochMs`, 'WebSocket session close facts are invalid'));
    }
    if (
        typeof facts.expireAtEpochMs === 'number' && typeof facts.disconnectedAtEpochMs === 'number' &&
        facts.expireAtEpochMs < facts.disconnectedAtEpochMs
    ) {
        issues.push(toValidationIssue(`${path}.expireAtEpochMs`, 'WebSocket session close facts are invalid'));
    }
    return issues;
}

function validateIdentity(identity: unknown, path: string): readonly WsSessionGenerationValidationIssue[] {
    if (!isDataRecord(identity)) {
        return [toValidationIssue(path, 'WebSocket session identity must be an exact object')];
    }
    return [
        ...validateKeyString(identity.sessionId, `${path}.sessionId`, 'WebSocket session id'),
        ...validateScope(identity.scope, `${path}.scope`)
    ];
}

function validateScope(scope: unknown, path: string): readonly WsSessionGenerationValidationIssue[] {
    if (!isDataRecord(scope)) {
        return [toValidationIssue(path, 'WebSocket session high-water scope must be an exact object')];
    }
    const issues = [
        ...validateKeyString(scope.applicationId, `${path}.applicationId`, 'WebSocket session application id'),
        ...validateKeyString(scope.workspaceId, `${path}.workspaceId`, 'WebSocket session workspace id'),
        ...validateKeyString(scope.principalId, `${path}.principalId`, 'WebSocket session principal id')
    ];
    if (scope.kind !== 'client' && scope.kind !== 'group') {
        issues.push(toValidationIssue(`${path}.kind`, 'WebSocket session close high-water state is invalid'));
    }
    if (scope.kind === 'client') {
        issues.push(
            ...validateKeyString(
                scope.clientInstanceId,
                `${path}.clientInstanceId`,
                'WebSocket session client instance id'
            )
        );
    }
    const keys = scope.kind === 'client'
        ? ['kind', 'applicationId', 'workspaceId', 'principalId', 'clientInstanceId']
        : ['kind', 'applicationId', 'workspaceId', 'principalId'];
    issues.push(
        ...validateKeys({ value: scope, keys, path, message: 'WebSocket session high-water scope fields are invalid' })
    );
    return issues;
}

function validateHighWaterState(state: unknown, path: string): readonly WsSessionGenerationValidationIssue[] {
    if (!isDataRecord(state)) {
        return [toValidationIssue(path, 'WebSocket session close high-water state must be an exact object')];
    }
    const issues: WsSessionGenerationValidationIssue[] = [];
    if (state.version !== 3 || (state.status !== 'open' && state.status !== 'closed')) {
        issues.push(toValidationIssue(path, 'WebSocket session close high-water state is invalid'));
    }
    const keys = [
        'version',
        'status',
        'scope',
        'sessionId',
        'generationId',
        'generationStartedAtEpochMs',
        'expireAtEpochMs'
    ];
    if (state.status === 'closed') {
        keys.push('disconnectedAtEpochMs', 'reason');
    }
    issues.push(
        ...validateKeys({
            value: state,
            keys,
            path,
            message: 'WebSocket session close high-water state fields are invalid'
        })
    );
    issues.push(...(state.status === 'closed' ? validateCloseFacts(state, path) : validateGuardFacts(state, path)));
    return issues;
}

function validateComputedShape(computed: unknown): readonly WsSessionGenerationValidationIssue[] {
    if (!isDataRecord(computed)) {
        return [toValidationIssue('computed', 'WebSocket lifecycle computed result must be an exact object')];
    }
    const stateIssues = validateHighWaterState(computed.state, 'computed.state');
    const issues = [
        ...validateKeys({
            value: computed,
            keys: ['outcome', 'key', 'expectedRevision', 'state', 'value', 'expireAtIsoTimestamp'],
            path: 'computed',
            message: 'WebSocket lifecycle computed fields are invalid'
        }),
        ...stateIssues,
        ...validateString(computed.key, 'computed.key', 'WebSocket lifecycle key'),
        ...validateString(computed.value, 'computed.value', 'WebSocket lifecycle computed value'),
        ...validateString(
            computed.expireAtIsoTimestamp,
            'computed.expireAtIsoTimestamp',
            'WebSocket lifecycle computed expireAtIsoTimestamp'
        )
    ];
    if (computed.outcome !== 'insert' && computed.outcome !== 'update' && computed.outcome !== 'none') {
        issues.push(toValidationIssue('computed.outcome', 'WebSocket lifecycle computed outcome is invalid'));
    }
    if (computed.outcome === 'insert') {
        issues.push(...validateExpectedValue(computed.expectedRevision, null, 'computed.expectedRevision'));
    }
    else if (
        computed.outcome === 'update'
            ? !isValidRuntimeStateUpsertExpectedRevision(computed.expectedRevision)
            : !isValidRuntimeStateExpectedRevision(computed.expectedRevision)
    ) {
        issues.push(
            toValidationIssue(
                'computed.expectedRevision',
                'WebSocket lifecycle computed.expectedRevision is invalid for its outcome'
            )
        );
    }
    if (stateIssues.length === 0 && typeof computed.key === 'string') {
        const state = computed.state as WsSessionCloseHighWaterState;
        const persistence = computePersistence(computed.key, state);
        issues.push(...validateExpectedValue(computed.value, persistence.value, 'computed.value'));
        issues.push(
            ...validateExpectedValue(
                computed.expireAtIsoTimestamp,
                persistence.expireAtIsoTimestamp,
                'computed.expireAtIsoTimestamp'
            )
        );
    }
    return issues;
}

function validateExpectedValue(
    actual: unknown,
    expected: unknown,
    path: string
): readonly WsSessionGenerationValidationIssue[] {
    if (!isDataRecord(expected)) {
        return Object.is(actual, expected)
            ? []
            : [toValidationIssue(path, `WebSocket lifecycle ${path} differs from canonical computation`)];
    }
    if (!isDataRecord(actual)) {
        return [toValidationIssue(path, `WebSocket lifecycle ${path} differs from canonical computation`)];
    }
    const issues = [
        ...validateKeys({
            value: actual,
            keys: Object.keys(expected),
            path,
            message: `WebSocket lifecycle ${path} fields differ from canonical computation`
        })
    ];
    for (const key of Object.keys(expected)) {
        if (Object.hasOwn(actual, key)) {
            issues.push(...validateExpectedValue(actual[key], expected[key], `${path}.${key}`));
        }
    }
    return issues;
}

function validateKeys(
    { value, keys, path, message }: WsSessionFieldsValidationInput
): readonly WsSessionGenerationValidationIssue[] {
    return [
        ...keys.filter((key) => !Object.hasOwn(value, key)),
        ...Object.keys(value).filter((key) => !keys.includes(key))
    ].map((key) => toValidationIssue(`${path}.${key}`, message));
}

function validateString(value: unknown, path: string, label: string): readonly WsSessionGenerationValidationIssue[] {
    return typeof value === 'string' && value.length > 0
        ? []
        : [toValidationIssue(path, `${label} must be a non-empty string`)];
}

function validateKeyString(value: unknown, path: string, label: string): readonly WsSessionGenerationValidationIssue[] {
    const issues = validateString(value, path, label);
    if (issues.length > 0 || typeof value !== 'string') {
        return issues;
    }
    for (const character of value) {
        const code = character.codePointAt(0);
        if (code !== undefined && code >= 0xD800 && code <= 0xDFFF) {
            const cause = new URIError('URI malformed');
            return [{ path, message: cause.message, cause }];
        }
    }
    return [];
}

function validateEpoch(value: unknown, path: string, label: string): readonly WsSessionGenerationValidationIssue[] {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? []
        : [toValidationIssue(path, `${label} must be a non-negative safe integer`)];
}

function validateExpiry(value: unknown, path: string, label: string): readonly WsSessionGenerationValidationIssue[] {
    const issues = validateEpoch(value, path, label);
    if (issues.length === 0 && typeof value === 'number' && value > 8_640_000_000_000_000) {
        const cause = new RangeError('Invalid time value');
        return [{ path, message: cause.message, cause }];
    }
    return issues;
}

function toValidationIssue(path: string, message: string): WsSessionGenerationValidationIssue {
    return { path, message, cause: new TypeError(message) };
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
    if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return false;
    }
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            typeof key !== 'string' || key === 'toJSON' || !descriptor?.enumerable ||
            !Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function'
        ) {
            return false;
        }
    }
    return true;
}

function isSameIdentity(
    left: WsSessionHighWaterIdentity,
    right: WsSessionHighWaterIdentity
): boolean {
    return toWsSessionLifecycleKey(left) === toWsSessionLifecycleKey(right);
}

function isSameHighWaterState(
    left: WsSessionCloseHighWaterState,
    right: WsSessionCloseHighWaterState
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
