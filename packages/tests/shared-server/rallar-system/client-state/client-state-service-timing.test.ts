import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createTimedClientStateService,
    timeClientStateMutationCommit
} from '@shared-server/rallar-system/client-state/client-state-service-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';

import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type { ClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';

import { createClientMutationTransactionBoundaryFixture } from './create-client-mutation-transaction-boundary-fixture.ts';

describe('client-state service timing', () => {
    it('times reads without adding clock or sink effects to compute, validate, or write', async () => {
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
        expect(timed.compute).toBe(fixture.service.compute);
        expect(timed.validate).toBe(fixture.service.validate);
        expect(timed.write).toBe(fixture.service.write);
        expect(timed.compute(TIMED_COMMAND, fixture.readResult as never)).toBe(fixture.computedResult);
        expect(() => timed.validate(TIMED_COMMAND, fixture.readResult as never, fixture.computedResult as never)).not.toThrow();
        await expect(timed.write(TIMED_TRANSACTION, TIMED_COMPUTED)).rejects.toBe(fixture.writeFailure);

        expect(fixture.calls).toEqual([
            'read',
            'event:mutation.read:ok',
            'compute',
            'validate',
            'write'
        ]);
        expect(fixture.events.map((event) => [event.operation, event.serviceId, event.status])).toEqual([
            ['mutation.read', 'client-timing-service', 'ok']
        ]);
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
        readExpiredSessionPage: async () => ({ candidates: [], nextAfterKey: null }),
        findSessionBySessionId: async () => undefined,
        readIssuedAuthSession: async () => undefined,
        observeSnapshot: async (snapshot) => snapshot
    };
    return { calls, computedResult, events, readResult, service, writeFailure };
}

describe('client mutation service timing', () => {
    it('records compute and validate before transaction entry and write after commit', async () => {
        const fixture = await createClientMutationTransactionBoundaryFixture({
            recordMutationTiming: true
        });

        await fixture.handler.processCommand(
            fixture.context,
            toUpsertClientPrincipalMutationInput({
                scope: SCOPE,
                principalId: 'alice',
                request: { username: 'alice', requestId: 'upsert-alice-timed' },
                defaultCommandId: 'upsert-alice-timed'
            })
        );

        expect(fixture.actions).toEqual([
            'completion',
            'mutation.compute',
            'mutation.validate',
            'write',
            'commit',
            'mutation.write',
            'observe'
        ]);
    });

    it('records a failed write only after the transaction action has exited', async () => {
        const actions: string[] = [];
        const failure = new Error('transaction failed');

        await expect(timeClientStateMutationCommit(
            {
                timing: {
                    serviceId: 'client-timing-service',
                    sink: (event) => actions.push(`event:${event.operation}:${event.status}`)
                },
                writes: [TIMED_COMPUTED]
            },
            async () => {
                actions.push('transaction');
                try {
                    throw failure;
                }
                finally {
                    actions.push('transaction-exited');
                }
            }
        )).rejects.toBe(failure);

        expect(actions).toEqual([
            'transaction',
            'transaction-exited',
            'event:mutation.write:error'
        ]);
    });
});
