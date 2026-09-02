import { describe, expect, it } from 'vitest';

import { createTimedClientStateService, timeClientStateInboxPhase } from '@shared-server/rallar-system/client-state/client-state-service-timing.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';

import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';
import { createHandlerHarness } from './client-mutation-transaction-boundary-fixture.ts';
import { createClientStateServiceStub } from './client-state-service-stub.ts';

describe('client-state mutation timing', () => {
    it('keeps the descriptor and read timing while public compute and validate remain free of sink effects', async () => {
        const command = await principalCommand();
        const read = emptyRead(command);
        const events: RallarTimingEvent[] = [];
        const timing = (event: RallarTimingEvent) => {
            events.push(event);
        };
        const service = createTimedClientStateService({
            service: createClientStateServiceStub({
                read: async () => read,
                compute: (command, read) => computeClientMutation({ command, read }),
                validate: (command, read, computed) => validateClientMutation({ command, read, computed }),
                write: async (_transaction, computed) => computed.receipt
            }),
            serviceId: 'original-client-service',
            timing
        });

        expect(service.mutationTiming).toEqual({ sink: timing, serviceId: 'original-client-service' });
        expect(await service.read(command)).toBe(read);
        const computed = service.compute(command, read);
        service.validate(command, read, computed);
        if (computed.outcome !== 'write') {
            throw new TypeError('Expected the principal mutation to require a write');
        }
        await service.write(undefined as never, computed);
        expect(events.map((event) => event.operation)).toEqual(['mutation.read']);
        expect(events[0]).toMatchObject({
            serviceId: 'original-client-service',
            requestId: command.requestId,
            ...command.aggregateRef,
            status: 'ok'
        });
    });

    it('records phase success and rejection at the shell with the existing command identities', async () => {
        const command = await principalCommand();
        const events: RallarTimingEvent[] = [];
        const timing = {
            serviceId: 'original-client-service',
            sink: (event: RallarTimingEvent) => {
                events.push(event);
            }
        };
        const failure = new TypeError('Rejected exact candidate');
        const result = timeClientStateInboxPhase({ timing, command, operation: 'mutation.compute' }, () => 42);
        expect(result).toBe(42);
        expect(() =>
            timeClientStateInboxPhase(
                { timing, command, operation: 'mutation.validate' },
                () => {
                    throw failure;
                }
            )
        ).toThrow(failure);
        expect(events.map((event) => [event.operation, event.status])).toEqual([
            ['mutation.compute', 'ok'],
            ['mutation.validate', 'error']
        ]);
        for (const event of events) {
            expect(event).toMatchObject({
                component: 'client-state-service',
                serviceId: 'original-client-service',
                requestId: command.requestId,
                ...command.aggregateRef,
                details: { attempt: 1, mutationOperation: 'upsertPrincipal' }
            });
            expect(event.durationMs).toBeGreaterThanOrEqual(0);
        }
        expect(events[1].error?.message).toBe(failure.message);
    });

    it('emits both pure phase families on the production handler before transaction entry', async () => {
        const harness = await createHandlerHarness();
        await harness.handler.processCommand(
            harness.context,
            toUpsertClientPrincipalMutationInput({
                scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
                principalId: 'alice',
                request: { username: 'alice', requestId: 'client-transaction-result' },
                defaultCommandId: 'client-transaction-result'
            })
        );
        expect(harness.actions).toEqual([
            'read',
            'completion-clock',
            'mutation.compute',
            'mutation.validate',
            'transaction',
            'write',
            'commit',
            'mutation.write',
            'observe'
        ]);
    });

    it('records a failed commit only after the transaction has exited', async () => {
        const harness = await createHandlerHarness({ failTransaction: true });

        await expect(harness.handler.processCommand(
            harness.context,
            toUpsertClientPrincipalMutationInput({
                scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
                principalId: 'alice',
                request: { username: 'alice', requestId: 'client-transaction-failure' },
                defaultCommandId: 'client-transaction-failure'
            })
        )).rejects.toThrow('injected transaction failure');

        expect(harness.actions).toEqual([
            'read',
            'completion-clock',
            'mutation.compute',
            'mutation.validate',
            'transaction',
            'mutation.write'
        ]);
    });

    it('preserves the existing timing representation and rethrow for non-Error failures', async () => {
        const command = await principalCommand();
        const events: RallarTimingEvent[] = [];
        const timing = {
            serviceId: 'original-client-service',
            sink: (event: RallarTimingEvent) => {
                events.push(event);
            }
        };
        for (const failure of ['opaque failure', undefined]) {
            let rethrown = false;
            try {
                timeClientStateInboxPhase({ timing, command, operation: 'mutation.validate' }, () => {
                    throw failure;
                });
            }
            catch (caught) {
                rethrown = true;
                expect(caught).toBe(failure);
            }
            expect(rethrown).toBe(true);
        }
        expect(events.map((event) => event.status)).toEqual(['error', 'error']);
        expect(events[0].error).toEqual({ name: undefined, message: 'opaque failure' });
        expect(events[1].error).toBeUndefined();
    });
});
