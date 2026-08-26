import { describe, expect, it } from 'vitest';

import type { ClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { computeClientInstanceMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-instance-mutation.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { computeClientPrincipalMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-principal-mutation.ts';

import {
    emptyRead,
    instanceCommand,
    instanceFrom,
    principalCommand,
    principalFrom,
    readAfterWrite,
    requireWrite
} from './client-mutation-compute-test-fixtures.ts';
import {
    AggregateBarrierRepository,
    CLIENT_MUTATION_BASE_EPOCH_MS as BASE_EPOCH_MS,
    createService,
    outboxFor,
    snapshot
} from './client-mutation-concurrency-test-runtime.ts';
import { CLIENT_MUTATION_TEST_SCOPE as SCOPE } from './client-mutation-validation-test-fixtures.ts';

type PrincipalCommand = Extract<ClientMutationCommand, { operation: 'upsertPrincipal'; }>;
type InstanceCommand = Extract<ClientMutationCommand, { operation: 'upsertInstance'; }>;

function requirePrincipalCommand(command: ClientMutationCommand): PrincipalCommand {
    if (command.operation !== 'upsertPrincipal') {
        throw new Error(`Expected an upsertPrincipal command, received ${command.operation}`);
    }
    return command;
}

function requireInstanceCommand(command: ClientMutationCommand): InstanceCommand {
    if (command.operation !== 'upsertInstance') {
        throw new Error(`Expected an upsertInstance command, received ${command.operation}`);
    }
    return command;
}

describe('client principal and instance mutation compute', () => {
    it('creates the exact principal candidate through its named family owner', async () => {
        const command = requirePrincipalCommand(await principalCommand());
        const read = emptyRead(command);

        const direct = computeClientPrincipalMutation({ command, read });
        const routed = computeClientMutation({ command, read });

        expect(routed).toEqual(direct);
        expect(requireWrite(routed)).toMatchObject({
            principal: {
                operation: 'insert',
                value: {
                    username: 'alice',
                    displayName: 'Alice',
                    roles: ['member'],
                    metadata: { theme: 'dark' },
                    snapshotVersion: 1,
                    profileVersion: 1,
                    presenceVersion: 1
                }
            },
            event: { eventType: 'principal-created' },
            snapshot: { stateRevision: 1, instances: [], activeSessions: [] }
        });
    });

    it('preserves semantic principal no-op and instance registration decisions', async () => {
        const firstCommand = await principalCommand('principal-seed');
        const first = requireWrite(
            computeClientMutation({
                command: firstCommand,
                read: emptyRead(firstCommand)
            })
        );
        const sameCommand = requirePrincipalCommand(await principalCommand('principal-same'));
        const sameRead = readAfterWrite(sameCommand, first);

        expect(computeClientPrincipalMutation({ command: sameCommand, read: sameRead })).toMatchObject({
            outcome: 'no-op',
            persistIdempotency: true,
            event: null
        });

        const nextCommand = requireInstanceCommand(await instanceCommand());
        const nextRead = readAfterWrite(nextCommand, first);
        const direct = computeClientInstanceMutation({ command: nextCommand, read: nextRead });
        expect(computeClientMutation({ command: nextCommand, read: nextRead })).toEqual(direct);
        expect(instanceFrom(requireWrite(direct))).toMatchObject({
            clientInstanceId: 'browser',
            platform: 'web',
            deviceLabel: 'Laptop',
            capabilities: ['rtc']
        });
    });

    it('emits canonical principal property order from a valid noncanonical aggregate ref', async () => {
        const canonical = requirePrincipalCommand(await principalCommand('principal-property-order'));
        const command = {
            ...canonical,
            aggregateRef: {
                workspaceId: canonical.aggregateRef.workspaceId,
                applicationId: canonical.aggregateRef.applicationId,
                principalId: canonical.aggregateRef.principalId
            }
        } as typeof canonical;

        const principal = principalFrom(
            requireWrite(
                computeClientPrincipalMutation({
                    command,
                    read: emptyRead(command)
                })
            )
        );

        expect(Object.keys(principal)).toEqual([
            'applicationId',
            'workspaceId',
            'principalId',
            'username',
            'displayName',
            'avatarUrl',
            'authProvider',
            'externalSubjectId',
            'roles',
            'metadata',
            'snapshotVersion',
            'profileVersion',
            'presenceVersion',
            'created',
            'updated',
            'lastSeenAtEpochMs',
            'status',
            'disabled',
            'deleted'
        ]);
        expect(JSON.stringify(principal)).toMatch(
            /^\{"applicationId":"app-1","workspaceId":"workspace-1","principalId":"alice",/
        );
    });
});

describe('client principal and instance persistence convergence', () => {
    it('binds instance and session aggregate audit stamps to the command request id', async () => {
        const runtime = new AggregateBarrierRepository();
        await createService(runtime, BASE_EPOCH_MS).upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            requestId: 'audit-seed'
        });
        await createService(runtime, BASE_EPOCH_MS + 1).upsertInstance(SCOPE, 'alice', 'browser', {
            platform: 'web',
            requestId: 'audit-instance'
        });
        expect((await snapshot(runtime, 'alice')).principal.updated.requestId).toBe('audit-instance');

        await createService(runtime, BASE_EPOCH_MS + 2).connectSession(
            SCOPE,
            'alice',
            'browser',
            'session-a',
            {
                generationId: 'audit-generation',
                connectedAtEpochMs: BASE_EPOCH_MS + 2,
                requestId: 'audit-session'
            }
        );
        expect((await snapshot(runtime, 'alice')).principal.updated.requestId).toBe('audit-session');
    });

    it('keeps principal profile and instance registration across an aggregate CAS race', async () => {
        const runtime = new AggregateBarrierRepository();
        const seed = createService(runtime, 1_000);
        await seed.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Before',
            requestId: 'seed-principal'
        });
        const before = await snapshot(runtime, 'alice');
        runtime.armPrincipalReadBarrier(2);

        const [profile, instance] = await Promise.all([
            createService(runtime, 2_000).upsertPrincipal(SCOPE, 'alice', {
                username: 'alice',
                displayName: 'After',
                metadata: { theme: 'dark' },
                requestId: 'profile-race'
            }),
            createService(runtime, 2_001).upsertInstance(SCOPE, 'alice', 'browser', {
                platform: 'web',
                deviceLabel: 'Laptop',
                requestId: 'instance-race'
            })
        ]);

        expect(profile.result?.event?.eventType).toBe('principal-updated');
        expect(instance.result?.event?.eventType).toBe('instance-registered');
        const after = await snapshot(runtime, 'alice');
        expect(after.principal).toMatchObject({
            displayName: 'After',
            metadata: { theme: 'dark' }
        });
        expect(after.instances).toEqual([
            expect.objectContaining({ clientInstanceId: 'browser', deviceLabel: 'Laptop' })
        ]);
        expect(after.stateRevision).toBe(before.stateRevision + 2);
        expect(await outboxFor(runtime, ['profile-race', 'instance-race'])).toHaveLength(4);
    });
});
