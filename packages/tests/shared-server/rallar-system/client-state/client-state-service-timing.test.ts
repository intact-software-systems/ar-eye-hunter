import { describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createTimedClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';

import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { ClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE } from './client-state-service-test-fixtures.ts';
import { createClientStateTestDriver as createClientStateService } from './client-state-test-runtime.ts';

describe('client-state service timing', () => {
    it('preserves timed phase identities, results, rejections, and argument identities', async () => {
        const fixture = createTimedClientStateServiceFixture();
        const timed = createTimedClientStateService({
            service: fixture.service,
            serviceId: 'client-timing-service',
            timing: (event) => {
                fixture.events.push(event);
                fixture.calls.push(`event:${event.operation}:${event.status}`);
            }
        });

        await expect(timed.read(TIMED_COMMAND)).resolves.toBe(fixture.readResult);
        expect(timed.compute(TIMED_COMMAND, fixture.readResult as never)).toBe(fixture.computedResult);
        expect(() => timed.validate(TIMED_COMMAND, fixture.readResult as never, fixture.computedResult as never)).not.toThrow();
        await expect(timed.write(TIMED_TRANSACTION, TIMED_COMPUTED)).rejects.toBe(fixture.writeFailure);

        expect(fixture.calls).toEqual([
            'read',
            'event:mutation.read:ok',
            'compute',
            'event:mutation.compute:ok',
            'validate',
            'event:mutation.validate:ok',
            'write',
            'event:mutation.write:error'
        ]);
        expect(fixture.events.map((event) => [event.operation, event.serviceId, event.status])).toEqual([
            ['mutation.read', 'client-timing-service', 'ok'],
            ['mutation.compute', 'client-timing-service', 'ok'],
            ['mutation.validate', 'client-timing-service', 'ok'],
            ['mutation.write', 'client-timing-service', 'error']
        ]);
        expect(fixture.events.at(-1)?.error?.message).toBe(fixture.writeFailure.message);
    });
});

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;
const TIMED_COMMAND = {
    operation: 'upsertPrincipal',
    aggregateRef: { ...SCOPE, principalId: 'alice' },
    commandId: 'timed-command',
    requestId: 'timed-request',
    authority: {
        kind: 'issued-session',
        version: 1,
        principalId: 'alice',
        sessionId: 'alice-session',
        sessionIssuedAtEpochMs: 1,
        sessionExpiresAtEpochMs: 2,
        applicationId: SCOPE.applicationId,
        workspaceId: SCOPE.workspaceId,
        operation: 'upsertPrincipal'
    },
    facts: {
        nowEpochMs: 1,
        serviceId: 'client-timing-service',
        eventId: 'event-timed',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        expireAtEpochMs: 2
    },
    input: {}
} as never as ClientMutationCommand;
const TIMED_COMPUTED = {
    receipt: {
        aggregateRef: TIMED_COMMAND.aggregateRef,
        requestId: TIMED_COMMAND.requestId
    }
} as never as Parameters<ClientStateService['write']>[1];
const TIMED_TRANSACTION = {} as PSqlSql;

interface TimedClientStateServiceFixture {
    readonly calls: string[];
    readonly computedResult: object;
    readonly events: RallarTimingEvent[];
    readonly readResult: object;
    readonly service: ClientStateService;
    readonly writeFailure: Error;
}

function createTimedClientStateServiceFixture(): TimedClientStateServiceFixture {
    const calls: string[] = [];
    const events: RallarTimingEvent[] = [];
    const readResult = { read: 'exact-read-result' };
    const computedResult = { computed: 'exact-computed-result' };
    const writeFailure = new Error('write failure must propagate');
    const service: ClientStateService = {
        sessionGenerationLifecycle: {} as never,
        listSnapshots: async () => [],
        readSnapshot: async () => undefined,
        readPresenceSnapshot: async () => undefined,
        listEvents: async () => [],
        listRecentEvents: async () => [],
        listEventPage: async () => ({ events: [], hasMore: false }),
        read: async (command) => {
            calls.push('read');
            expect(command).toBe(TIMED_COMMAND);
            return readResult as never;
        },
        compute: (command, read) => {
            calls.push('compute');
            expect(command).toBe(TIMED_COMMAND);
            expect(read).toBe(readResult);
            return computedResult as never;
        },
        validate: (command, read, computed) => {
            calls.push('validate');
            expect(command).toBe(TIMED_COMMAND);
            expect(read).toBe(readResult);
            expect(computed).toBe(computedResult);
        },
        write: async (transaction, computed) => {
            calls.push('write');
            expect(transaction).toBe(TIMED_TRANSACTION);
            expect(computed).toBe(TIMED_COMPUTED);
            throw writeFailure;
        },
        listExpiredSessionCandidates: async () => [],
        findSessionBySessionId: async () => undefined,
        readIssuedAuthSession: async () => undefined,
        observeSnapshot: async (snapshot) => snapshot
    };
    return { calls, computedResult, events, readResult, service, writeFailure };
}

describe('client mutation service timing', () => {
    it('records timing for client state service methods when a timing sink is supplied', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            serviceId: 'client-service',
            timing: (event) => timingEvents.push(event)
        });

        await service.upsertPrincipal(CLIENT_MUTATION_SERVICE_SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'upsert-alice-timed'
        });

        expect(timingEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    component: 'client-state-service',
                    operation: 'mutation.write',
                    status: 'ok',
                    serviceId: 'client-service',
                    requestId: 'upsert-alice-timed',
                    applicationId: CLIENT_MUTATION_SERVICE_SCOPE.applicationId,
                    workspaceId: CLIENT_MUTATION_SERVICE_SCOPE.workspaceId,
                    principalId: 'alice'
                })
            ])
        );
        expect(typeof timingEvents[0]?.durationMs).toBe('number');
    });
});
