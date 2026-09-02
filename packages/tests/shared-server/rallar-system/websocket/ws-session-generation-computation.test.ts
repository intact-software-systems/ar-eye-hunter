import { describe, expect, it } from 'vitest';

import {
    computeWsSessionConnectGuard,
    computeWsSessionGenerationClosed,
    decodeWsSessionCloseHighWaterState,
    validateWsSessionConnectGuard,
    validateWsSessionGenerationClosed,
    type WsSessionGenerationCloseFacts,
    type WsSessionGenerationGuardFacts,
    type WsSessionGenerationLifecycleRead,
    type WsSessionGenerationValidationIssue
} from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import { createWsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

const GUARD: WsSessionGenerationGuardFacts = {
    scope: { kind: 'group', applicationId: 'app', workspaceId: 'workspace', principalId: 'owner' },
    sessionId: 'session',
    generationId: 'generation',
    generationStartedAtEpochMs: 1_000,
    expireAtEpochMs: 10_000
};
const CLOSED: WsSessionGenerationCloseFacts = {
    ...GUARD,
    disconnectedAtEpochMs: 2_000,
    reason: 'socket-closed'
};
const EMPTY: WsSessionGenerationLifecycleRead = {
    identity: { scope: GUARD.scope, sessionId: GUARD.sessionId },
    key: 'group:app:workspace:owner:session',
    revision: null,
    persistedExpireAtEpochMs: null,
    state: null
};
const OPEN_READ: WsSessionGenerationLifecycleRead = {
    ...EMPTY,
    revision: 0,
    persistedExpireAtEpochMs: 10_000,
    state: { version: 3, status: 'open', ...GUARD }
};

describe('WebSocket session generation storage revision validation', () => {
    it.each([-0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'collects invalid read and computed revisions (%s) for connect and close',
        (revision) => {
            const read = Object.freeze({ ...OPEN_READ, revision });
            const guard = Object.freeze({ ...computeWsSessionConnectGuard(GUARD, OPEN_READ), outcome: 'update' as const, expectedRevision: revision });
            const closed = Object.freeze({ ...computeWsSessionGenerationClosed(CLOSED, OPEN_READ), outcome: 'update' as const, expectedRevision: revision });

            for (
                const issues of [
                    validateWsSessionConnectGuard(GUARD, read, guard),
                    validateWsSessionGenerationClosed(CLOSED, read, closed)
                ]
            ) {
                expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
                    'read.revision',
                    'computed.expectedRevision'
                ]));
                expect(issues.every((issue) => issue.cause instanceof TypeError)).toBe(true);
            }
            expect(() => computeWsSessionConnectGuard(GUARD, read)).toThrow(TypeError);
            expect(() => computeWsSessionGenerationClosed(CLOSED, read)).toThrow(TypeError);
        }
    );

    it('rejects an exact connect update whose revision cannot be incremented', () => {
        const read = Object.freeze({ ...OPEN_READ, revision: Number.MAX_SAFE_INTEGER });
        const computed = Object.freeze(computeWsSessionConnectGuard(GUARD, read));

        expect(computed).toMatchObject({ outcome: 'update', expectedRevision: Number.MAX_SAFE_INTEGER });
        expect(validateWsSessionConnectGuard(GUARD, read, computed)).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'computed.expectedRevision', cause: expect.any(TypeError) })
        ]));
        expect(read.revision).toBe(Number.MAX_SAFE_INTEGER);
        expect(computed.expectedRevision).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('rejects an exact close update whose revision cannot be incremented', () => {
        const read = Object.freeze({ ...OPEN_READ, revision: Number.MAX_SAFE_INTEGER });
        const computed = Object.freeze(computeWsSessionGenerationClosed(CLOSED, read));

        expect(computed).toMatchObject({ outcome: 'update', expectedRevision: Number.MAX_SAFE_INTEGER });
        expect(validateWsSessionGenerationClosed(CLOSED, read, computed)).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'computed.expectedRevision', cause: expect.any(TypeError) })
        ]));
        expect(read.revision).toBe(Number.MAX_SAFE_INTEGER);
        expect(computed.expectedRevision).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('accepts an exact close no-op at the maximum revision without replacing its read or candidate', () => {
        const state = Object.freeze({ version: 3, status: 'closed', ...CLOSED } as const);
        const read = Object.freeze({ ...OPEN_READ, state, revision: Number.MAX_SAFE_INTEGER });
        const computed = Object.freeze(computeWsSessionGenerationClosed(CLOSED, read));

        expect(computed).toMatchObject({ outcome: 'none', expectedRevision: Number.MAX_SAFE_INTEGER });
        expect(validateWsSessionGenerationClosed(CLOSED, read, computed)).toEqual([]);
        expect(computed.state).toBe(state);
        expect(read.state).toBe(state);
    });

    it.each([0, Number.MAX_SAFE_INTEGER - 1])('accepts connect and close updates at valid revision %s', (revision) => {
        const read = Object.freeze({ ...OPEN_READ, revision });
        const guard = computeWsSessionConnectGuard(GUARD, read);
        const closed = computeWsSessionGenerationClosed(CLOSED, read);

        expect(guard).toMatchObject({ outcome: 'update', expectedRevision: revision });
        expect(closed).toMatchObject({ outcome: 'update', expectedRevision: revision });
        expect(validateWsSessionConnectGuard(GUARD, read, guard)).toEqual([]);
        expect(validateWsSessionGenerationClosed(CLOSED, read, closed)).toEqual([]);
    });

    it('collects an unsafe update revision alongside independently invalid facts', () => {
        const computed = {
            ...computeWsSessionConnectGuard(GUARD, OPEN_READ),
            outcome: 'update' as const,
            expectedRevision: Number.MAX_SAFE_INTEGER
        };

        const issues = validateWsSessionConnectGuard({ ...GUARD, generationId: '' }, OPEN_READ, computed);

        expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
            'facts.generationId',
            'computed.expectedRevision'
        ]));
    });
});

describe('WebSocket session generation exact computed validation', () => {
    it.each(['connect', 'close'] as const)('rejects forged persistence strings for %s without throwing or changing the candidate', (operation) => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = operation === 'connect'
            ? lifecycle.computeConnectGuard(GUARD, EMPTY)
            : lifecycle.computeClosed(CLOSED, EMPTY);
        const forged = { ...computed, value: '{}', expireAtIsoTimestamp: '1970-01-01T00:00:00.001Z' };
        const before = JSON.stringify(forged);
        let issues: readonly WsSessionGenerationValidationIssue[] = [];

        expect(() => {
            issues = operation === 'connect'
                ? lifecycle.validateConnectGuard(GUARD, EMPTY, forged)
                : lifecycle.validateClosed(CLOSED, EMPTY, forged);
        }).not.toThrow();

        expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['computed.value', 'computed.expireAtIsoTimestamp']));
        expect(issues.every((issue) => issue.cause instanceof TypeError && issue.message === issue.cause.message)).toBe(true);
        expect(issues.every((issue) => issue.message.includes(issue.path))).toBe(true);
        expect(JSON.stringify(forged)).toBe(before);
    });

    it('collects all six independently forged candidate fields', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = lifecycle.computeConnectGuard(GUARD, EMPTY);
        const forged = {
            ...computed,
            outcome: 'update' as const,
            expectedRevision: 7,
            key: 'wrong-key',
            state: { ...computed.state, sessionId: 'other-session' },
            value: '{}',
            expireAtIsoTimestamp: 'not-an-iso-timestamp'
        };

        const paths = lifecycle.validateConnectGuard(GUARD, EMPTY, forged).map((issue) => issue.path);

        expect(paths).toEqual(expect.arrayContaining([
            'computed.outcome',
            'computed.expectedRevision',
            'computed.key',
            'computed.state.sessionId',
            'computed.value',
            'computed.expireAtIsoTimestamp'
        ]));
    });

    it('collects invalid facts and read fields without entering failing recomputation', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = lifecycle.computeClosed(CLOSED, EMPTY);
        const facts = { ...CLOSED, generationId: '', disconnectedAtEpochMs: -1, reason: '' };
        const read = { ...EMPTY, key: 'wrong-key', revision: 3 };

        const issues = lifecycle.validateClosed(facts, read, computed);

        expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
            'facts.generationId',
            'facts.disconnectedAtEpochMs',
            'facts.reason',
            'read.key',
            'read.revision'
        ]));
    });

    it('reports an unrepresentable expiry instead of throwing from ISO conversion', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = lifecycle.computeConnectGuard(GUARD, EMPTY);

        const issues = lifecycle.validateConnectGuard({ ...GUARD, expireAtEpochMs: Number.MAX_SAFE_INTEGER }, EMPTY, computed);

        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'facts.expireAtEpochMs' })]));
    });

    it('accepts an actual lifecycle read made with the original generation facts', async () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const read = await lifecycle.read(GUARD);
        const computed = lifecycle.computeConnectGuard(GUARD, EMPTY);

        expect(lifecycle.validateConnectGuard(GUARD, read, computed)).toEqual([]);
    });

    it('collects malformed candidate strings even when facts prevent canonical recomputation', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = lifecycle.computeConnectGuard(GUARD, EMPTY);
        const candidate = { ...computed, value: '{}', expireAtIsoTimestamp: 'invalid' };

        const issues = lifecycle.validateConnectGuard({ ...GUARD, generationId: '' }, EMPTY, candidate);

        expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
            'facts.generationId',
            'computed.value',
            'computed.expireAtIsoTimestamp'
        ]));
    });

    it('rejects a fabricated no-op and stale revision even when persistence fields are unchanged', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const initial = lifecycle.computeClosed(CLOSED, EMPTY);
        const read = { ...EMPTY, state: initial.state, revision: 4, persistedExpireAtEpochMs: 10_000 };
        const facts = { ...CLOSED, expireAtEpochMs: 11_000 };
        const computed = lifecycle.computeClosed(facts, read);
        const forged = { ...computed, outcome: 'none' as const, expectedRevision: 3 };

        expect(lifecycle.validateClosed(facts, read, forged).map((issue) => issue.path)).toEqual([
            'computed.outcome',
            'computed.expectedRevision'
        ]);
    });

    it('rejects a non-data scope without executing its inherited serializer', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = lifecycle.computeConnectGuard(GUARD, EMPTY);
        const scope = { ...GUARD.scope };
        Object.setPrototypeOf(scope, {
            toJSON() {
                throw new Error('Validation executed caller behavior');
            }
        });
        let issues: readonly WsSessionGenerationValidationIssue[] = [];

        expect(() => {
            issues = lifecycle.validateConnectGuard({ ...GUARD, scope }, EMPTY, computed);
        }).not.toThrow();
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'facts.scope' })]));
    });

    it.each(['connect', 'close'] as const)('rejects a throwing computed accessor for %s without invoking it', (operation) => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = operation === 'connect'
            ? lifecycle.computeConnectGuard(GUARD, EMPTY)
            : lifecycle.computeClosed(CLOSED, EMPTY);
        const forged = { ...computed };
        let calls = 0;
        const getter = () => {
            calls += 1;
            throw new Error('Computed accessor executed');
        };
        Object.defineProperty(forged, 'value', { get: getter, enumerable: true });
        let issues: readonly WsSessionGenerationValidationIssue[] = [];

        expect(() => {
            issues = operation === 'connect'
                ? lifecycle.validateConnectGuard(GUARD, EMPTY, forged)
                : lifecycle.validateClosed(CLOSED, EMPTY, forged);
        }).not.toThrow();

        expect(calls).toBe(0);
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'computed', cause: expect.any(TypeError) })]));
        expect(Object.getOwnPropertyDescriptor(forged, 'value')?.get).toBe(getter);
        expect(forged.state).toBe(computed.state);
    });

    it.each(['facts', 'read', 'computed'] as const)('rejects a %s proxy without invoking caller behavior', (target) => {
        const original = {
            facts: CLOSED,
            read: OPEN_READ,
            computed: computeWsSessionGenerationClosed(CLOSED, OPEN_READ)
        };
        let calls = 0;
        const candidate = {
            ...original,
            [target]: new Proxy(original[target], {
                get(value, key, receiver) {
                    calls += 1;
                    return Reflect.get(value, key, receiver);
                },
                ownKeys(value) {
                    calls += 1;
                    return Reflect.ownKeys(value);
                }
            })
        };

        const issues = validateWsSessionGenerationClosed(candidate.facts, candidate.read, candidate.computed);

        expect({ rejected: issues.length > 0, calls }).toEqual({ rejected: true, calls: 0 });
    });

    it.each(['connect', 'close'] as const)('rejects a hidden scope serializer before computing %s persistence', (operation) => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const scope = { ...GUARD.scope };
        let calls = 0;
        Object.defineProperty(scope, 'toJSON', {
            value: () => {
                calls += 1;
                return { ...GUARD.scope, applicationId: 'other-app' };
            }
        });

        expect(() =>
            operation === 'connect'
                ? lifecycle.computeConnectGuard({ ...GUARD, scope }, EMPTY)
                : lifecycle.computeClosed({ ...CLOSED, scope }, EMPTY)
        ).toThrow(TypeError);

        expect(calls).toBe(0);
        expect(scope.applicationId).toBe('app');
    });

    it.each(['connect', 'close'] as const)('rejects a hidden serializer agreeing with forged %s persistence without invoking it', (operation) => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = operation === 'connect'
            ? lifecycle.computeConnectGuard(GUARD, EMPTY)
            : lifecycle.computeClosed(CLOSED, EMPTY);
        const scope = { ...GUARD.scope };
        let calls = 0;
        Object.defineProperty(scope, 'toJSON', {
            value: () => {
                calls += 1;
                return { ...GUARD.scope, applicationId: 'other-app' };
            }
        });
        const forged = {
            ...computed,
            state: { ...computed.state, scope },
            value: computed.value.replace('"applicationId":"app"', '"applicationId":"other-app"')
        };
        const issues = operation === 'connect'
            ? lifecycle.validateConnectGuard({ ...GUARD, scope }, EMPTY, forged)
            : lifecycle.validateClosed({ ...CLOSED, scope }, EMPTY, forged);

        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'facts.scope', cause: expect.any(TypeError) })]));
        expect(calls).toBe(0);
        expect(forged.state.scope).toBe(scope);
        expect(forged.key).toBe('group:app:workspace:owner:session');
    });

    it.each(
        [
            { target: 'facts', key: 'generationId' },
            { target: 'scope', key: 'applicationId' },
            { target: 'identity', key: 'scope' },
            { target: 'state', key: 'expireAtEpochMs' },
            { target: 'computedState', key: 'scope' },
            { target: 'computed', key: 'unexpected' }
        ] as const
    )('does not traverse $target property $key', ({ target, key }) => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const facts = structuredClone(CLOSED);
        const initial = lifecycle.computeClosed(CLOSED, EMPTY);
        const read = structuredClone({ ...EMPTY, state: initial.state, revision: 4, persistedExpireAtEpochMs: 10_000 });
        const computed = structuredClone(lifecycle.computeClosed(facts, read));
        const records = { facts, scope: facts.scope, identity: read.identity, state: read.state, computedState: computed.state, computed };
        let calls = 0;
        Object.defineProperty(records[target], key, {
            enumerable: true,
            get: () => {
                calls += 1;
                throw new Error('Nested accessor executed');
            }
        });
        let issues: readonly WsSessionGenerationValidationIssue[] = [];

        expect(() => {
            issues = lifecycle.validateClosed(facts, read, computed);
        }).not.toThrow();

        expect(issues.length).toBeGreaterThan(0);
        expect(issues.every((issue) => issue.cause instanceof TypeError)).toBe(true);
        expect(calls).toBe(0);
        if (target === 'facts' || target === 'scope' || target === 'identity' || target === 'state') {
            expect(() => lifecycle.computeClosed(facts, read)).toThrow(TypeError);
            expect(calls).toBe(0);
        }
    });

    it('rejects a non-enumerable identity field instead of silently omitting it from persistence', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const scope = { ...GUARD.scope };
        Object.defineProperty(scope, 'applicationId', { enumerable: false });

        const read = { ...EMPTY, identity: { ...EMPTY.identity, scope } };

        expect(() => lifecycle.computeConnectGuard({ ...GUARD, scope }, read)).toThrow(TypeError);
    });

    it('rejects hidden symbol properties on the exact computed result', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const computed = lifecycle.computeConnectGuard(GUARD, EMPTY);
        Object.defineProperty(computed, Symbol('hidden'), { value: 'not-wire-data' });

        expect(lifecycle.validateConnectGuard(GUARD, EMPTY, computed).length).toBeGreaterThan(0);
    });

    it('preserves frozen and null-prototype data inputs and their existing wire representation', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const scope = { ...GUARD.scope };
        Object.setPrototypeOf(scope, null);
        Object.freeze(scope);
        const facts = Object.freeze({ ...GUARD, scope });
        const read = Object.freeze({ ...EMPTY, identity: facts });
        const computed = lifecycle.computeConnectGuard(facts, read);
        Object.freeze(computed.state);
        Object.freeze(computed);

        expect(lifecycle.validateConnectGuard(facts, read, computed)).toEqual([]);
        expect(computed.state.scope).toBe(scope);
        expect(read.identity).toBe(facts);
        expect(computed.value).toBe(
            '{"version":3,"status":"open","scope":{"kind":"group","applicationId":"app","workspaceId":"workspace","principalId":"owner"},"sessionId":"session","generationId":"generation","generationStartedAtEpochMs":1000,"expireAtEpochMs":10000}'
        );
    });

    it('preserves scoped decoder rejection and the first malformed-data cause', () => {
        const state = { version: 3, status: 'open', ...GUARD } as const;

        expect(() => decodeWsSessionCloseHighWaterState({ ...state, sessionId: 'other-session' }, EMPTY.identity))
            .toThrow(new TypeError('WebSocket session close high-water state is invalid'));
        expect(() => decodeWsSessionCloseHighWaterState({ ...state, version: 2, generationId: '' }, EMPTY.identity))
            .toThrow(new TypeError('WebSocket session close high-water state is invalid'));
        expect(() =>
            decodeWsSessionCloseHighWaterState({
                ...state,
                scope: { ...GUARD.scope, applicationId: '\uD800' },
                expireAtEpochMs: Number.MAX_SAFE_INTEGER
            }, EMPTY.identity)
        ).toThrow(new URIError('URI malformed'));
    });

    it('accepts copied exact insert, update and no-op results for client and group scopes', () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        for (const scope of [GUARD.scope, { ...GUARD.scope, kind: 'client' as const, clientInstanceId: 'instance' }]) {
            const facts = { ...GUARD, scope };
            const empty = {
                ...EMPTY,
                identity: { scope, sessionId: GUARD.sessionId },
                key: scope.kind === 'client' ? 'client:app:workspace:owner:instance:session' : EMPTY.key
            };
            const inserted = lifecycle.computeConnectGuard(facts, empty);
            expect(inserted).toMatchObject({ outcome: 'insert', expectedRevision: null, expireAtIsoTimestamp: '1970-01-01T00:00:10.000Z' });
            expect(lifecycle.validateConnectGuard(facts, empty, structuredClone(inserted))).toEqual([]);
            const openRead = { ...empty, state: inserted.state, revision: 0, persistedExpireAtEpochMs: 10_000 };
            const updated = lifecycle.computeConnectGuard(facts, openRead);
            expect(updated).toMatchObject({ outcome: 'update', expectedRevision: 0 });
            expect(lifecycle.validateConnectGuard(facts, openRead, structuredClone(updated))).toEqual([]);
            const closeFacts = { ...CLOSED, scope };
            const closed = lifecycle.computeClosed(closeFacts, openRead);
            expect(lifecycle.validateClosed(closeFacts, openRead, structuredClone(closed))).toEqual([]);
            const closedRead = { ...openRead, state: closed.state, revision: 1 };
            const noOp = lifecycle.computeClosed(closeFacts, closedRead);
            expect(noOp).toMatchObject({ outcome: 'none', expectedRevision: 1 });
            expect(lifecycle.validateClosed(closeFacts, closedRead, structuredClone(noOp))).toEqual([]);
        }
    });
});
