import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toDisconnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toHeartbeatClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-heartbeat-client-session-mutation-input.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { readClientMutation } from '@shared-server/rallar-system/client-state/mutation/read-client-mutation.ts';
import { assertClientMutationRead } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation-read.ts';
import { assertClientMutationInvariants } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { clientStatePrincipalStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-principal-storage-key.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { groupStateScopeStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    computePrincipalStateSyncAudience,
    toPrincipalAudienceSessions
} from '@shared-server/rallar-system/state-sync/state-sync-principal-audience.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import {
    createTestClientStateRepository,
    createTestGroupStateRepository
} from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import type { AuditStamp, Group, GroupMember } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { createTestGroup } from '../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { principalCommand, TEST_SCOPE } from './client-mutation-compute-test-fixtures.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from './test-disconnected-session-retention.ts';

const AUDIENCE_EPOCH_MS = 2_000_000_000_000;
const HEARTBEAT_EPOCH_MS = 2;

class RecordingReadRepository extends FakeRuntimeStateRepository {
    readonly batchSelectors: RuntimeStateReadBatchSelector[] = [];

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.batchSelectors.push(...selectors);
        return await super.readRuntimeStateBatch(selectors);
    }
}

class CoMemberRowCountingRepository extends FakeRuntimeStateRepository {
    readonly coMemberRowsPerBatch: number[] = [];
    afterCoMemberSessionRead?: () => Promise<void>;

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selections = await super.readRuntimeStateBatch(selectors);
        const coMemberRows = selections
            .filter((_selection, index) => isCoMemberClientSelector(selectors[index]))
            .reduce((rows, selection) => rows + selection.entries.length, 0);
        if (coMemberRows > 0) {
            this.coMemberRowsPerBatch.push(coMemberRows);
        }
        const afterCoMemberSessionRead = this.afterCoMemberSessionRead;
        if (
            afterCoMemberSessionRead &&
            selectors.some((selector) => selector.namespace === 'client-state:sessions' && isCoMemberClientSelector(selector))
        ) {
            this.afterCoMemberSessionRead = undefined;
            await afterCoMemberSessionRead();
        }
        return selections;
    }
}

class AudienceReadRepository extends FakeRuntimeStateRepository {
    afterActorMemberRead?: () => Promise<void>;

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const groupScopePrefix = `${groupStateScopeStorageKey(TEST_SCOPE)}:`;
        const clientScopePrefix = 'app=app-1:ws=workspace-1:';
        for (const selector of selectors) {
            if (
                'keyPrefix' in selector && selector.kind !== 'prefix-suffix' &&
                (
                    (selector.namespace.startsWith('group-state:') &&
                        selector.keyPrefix === groupScopePrefix) ||
                    (selector.namespace.startsWith('client-state:') &&
                        selector.namespace !== 'client-state:principals' &&
                        selector.keyPrefix === clientScopePrefix)
                )
            ) {
                throw new Error(`Audience read requested every child in ${selector.namespace}`);
            }
        }
        const selections = await super.readRuntimeStateBatch(selectors);
        if (
            this.afterActorMemberRead &&
            selectors.some((selector) => selector.kind === 'prefix-suffix')
        ) {
            const afterActorMemberRead = this.afterActorMemberRead;
            this.afterActorMemberRead = undefined;
            await afterActorMemberRead();
        }
        return selections;
    }
}

describe('client mutation principal audience read', () => {
    it('reads only selected group and principal children while retaining all authorized sessions', async () => {
        const runtime = new AudienceReadRepository();
        const groups = createTestGroupStateRepository(runtime);
        const clients = createTestClientStateRepository(runtime);
        await seedGroup({
            repository: groups,
            groupId: 'room-one',
            ownerPrincipalId: 'alice',
            activePrincipalIds: ['bob'],
            leftPrincipalIds: ['carol']
        });
        await seedGroup({
            repository: groups,
            groupId: 'room-two',
            ownerPrincipalId: 'alice',
            activePrincipalIds: ['dave'],
            leftPrincipalIds: []
        });
        await seedGroup({
            repository: groups,
            groupId: 'unrelated',
            ownerPrincipalId: 'mallory',
            activePrincipalIds: ['erin'],
            leftPrincipalIds: []
        });
        for (const principalId of ['alice', 'bob', 'carol', 'dave', 'erin', 'mallory']) {
            await seedClient(clients, principalId);
        }

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('audience-read'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        if (!read.snapshot) {
            throw new Error('Expected Alice principal snapshot');
        }

        expect(read.audienceGroupSnapshots.map((snapshot) => snapshot.group.groupId)).toEqual([
            'room-one',
            'room-two'
        ]);
        expect(read.audienceCoMemberSessions.map((sessions) => sessions.principalRef.principalId))
            .toEqual([
                'bob',
                'dave'
            ]);
        expect(computePrincipalStateSyncAudience({
            principalRef: read.snapshot.principal,
            ownSessions: toPrincipalAudienceSessions(read.snapshot.principal, read.snapshot.activeSessions),
            groupSnapshots: read.audienceGroupSnapshots,
            coMemberSessions: read.audienceCoMemberSessions,
            nowEpochMs: AUDIENCE_EPOCH_MS
        })).toEqual(['alice-session', 'bob-session', 'dave-session']);
    });

    it('reads co-member principals and live sessions without the instances they accumulated', async () => {
        const runtime = new CoMemberRowCountingRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime, ['bob', 'carol', 'dave']);
        for (const principalId of ['bob', 'carol', 'dave']) {
            for (let index = 0; index < 20; index += 1) {
                await clients.insertInstance(instance(principalId, `${principalId}-stale-instance-${index}`));
            }
        }
        runtime.coMemberRowsPerBatch.length = 0;

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('stale-instance-audience'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        if (!read.snapshot) {
            throw new Error('Expected Alice principal snapshot');
        }

        expect(computePrincipalStateSyncAudience({
            principalRef: read.snapshot.principal,
            ownSessions: toPrincipalAudienceSessions(read.snapshot.principal, read.snapshot.activeSessions),
            groupSnapshots: read.audienceGroupSnapshots,
            coMemberSessions: read.audienceCoMemberSessions,
            nowEpochMs: AUDIENCE_EPOCH_MS
        })).toEqual(['alice-session', 'bob-session', 'carol-session', 'dave-session']);
        // Three co-member principals and their three active sessions, from one statement and with no reread guard.
        expect(runtime.coMemberRowsPerBatch).toEqual([6]);
    });

    it('reads only a co-member\'s connected sessions, never the disconnected ones it retains', async () => {
        const runtime = new CoMemberRowCountingRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime, ['bob']);
        for (let index = 0; index < 40; index += 1) {
            await clients.insertSession({
                ...session({ principalId: 'bob', sessionId: `bob-closed-session-${index}`, expiresAtEpochMs: 4_000_000_000_000 }),
                status: 'disconnected',
                disconnectedAtEpochMs: 2,
                disconnectReason: 'closed'
            });
        }
        runtime.coMemberRowsPerBatch.length = 0;

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('retained-disconnected-sessions'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });

        expect(read.audienceCoMemberSessions.map((sessions) => sessions.activeSessions.map(({ sessionId }) => sessionId)))
            .toEqual([['bob-session']]);
        // Bob's principal and his one connected session, from one statement.
        expect(runtime.coMemberRowsPerBatch).toEqual([2]);
    });

    it('takes a co-member principal and its sessions from one statement and leaves a later write to its own fan-out', async () => {
        const runtime = new CoMemberRowCountingRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime, ['bob']);
        runtime.afterCoMemberSessionRead = async () => {
            const bobRef = { ...TEST_SCOPE, principalId: 'bob' };
            const bob = await clients.findPrincipalEntry(bobRef);
            if (!bob) {
                throw new Error('Expected Bob principal before the concurrent connect');
            }
            await clients.insertSession(
                session({ principalId: 'bob', sessionId: 'bob-late-session', expiresAtEpochMs: 4_000_000_000_000 })
            );
            await clients.updatePrincipal(
                { ...bob.value, presenceVersion: bob.value.presenceVersion + 1 },
                bob.entry.revision
            );
        };

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('moved-co-member'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });

        expect(read.audienceCoMemberSessions.map((sessions) => sessions.activeSessions.map(({ sessionId }) => sessionId)))
            .toEqual([['bob-session']]);
        expect(runtime.coMemberRowsPerBatch).toEqual([2]);
    });

    it('reconsiders a group whose roster changes after the actor-member batch', async () => {
        const runtime = new AudienceReadRepository();
        const groups = createTestGroupStateRepository(runtime);
        const clients = createTestClientStateRepository(runtime);
        await seedGroup({
            repository: groups,
            groupId: 'joined-room',
            ownerPrincipalId: 'mallory',
            activePrincipalIds: ['bob'],
            leftPrincipalIds: []
        });
        for (const principalId of ['alice', 'bob', 'mallory']) {
            await seedClient(clients, principalId);
        }
        runtime.afterActorMemberRead = async () => {
            const previous = await groups.findGroup({ ...TEST_SCOPE, groupId: 'joined-room' });
            if (!previous) {
                throw new Error('Expected group before concurrent membership write');
            }
            await groups.putMember(
                member({
                    groupId: 'joined-room',
                    principalId: 'alice',
                    role: 'member',
                    status: 'active'
                })
            );
            await groups.putGroup({
                ...previous,
                activeMemberCount: 3,
                snapshotVersion: previous.snapshotVersion + 1,
                rosterVersion: previous.rosterVersion + 1
            });
        };

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('concurrent-membership'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        if (!read.snapshot) {
            throw new Error('Expected Alice principal snapshot');
        }
        expect(read.audienceGroupSnapshots.map((snapshot) => snapshot.group.groupId)).toEqual([
            'joined-room'
        ]);
        expect(computePrincipalStateSyncAudience({
            principalRef: read.snapshot.principal,
            ownSessions: toPrincipalAudienceSessions(read.snapshot.principal, read.snapshot.activeSessions),
            groupSnapshots: read.audienceGroupSnapshots,
            coMemberSessions: read.audienceCoMemberSessions,
            nowEpochMs: AUDIENCE_EPOCH_MS
        })).toEqual(['alice-session', 'bob-session', 'mallory-session']);
    });

    it('keeps only live sessions of active co-members in the requested scope', async () => {
        const runtime = new AudienceReadRepository();
        const groups = createTestGroupStateRepository(runtime);
        const clients = createTestClientStateRepository(runtime);
        await seedGroup({
            repository: groups,
            groupId: 'room-one',
            ownerPrincipalId: 'alice',
            activePrincipalIds: ['bob'],
            leftPrincipalIds: ['carol']
        });
        for (const principalId of ['alice', 'bob', 'carol']) {
            await seedClient(clients, principalId);
        }
        await seedClient(
            clients,
            'bob',
            { ...TEST_SCOPE, workspaceId: 'workspace-2' },
            'bob-other-scope-session'
        );
        await clients.insertSession(
            session({
                principalId: 'bob',
                sessionId: 'bob-expired-session',
                expiresAtEpochMs: AUDIENCE_EPOCH_MS
            })
        );
        await clients.insertSession({
            ...session({
                principalId: 'bob',
                sessionId: 'bob-replaced-session',
                expiresAtEpochMs: 4_000_000_000_000
            }),
            status: 'disconnected',
            disconnectedAtEpochMs: 2,
            disconnectReason: 'replaced'
        });

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('audience-sessions'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        if (!read.snapshot) {
            throw new Error('Expected Alice principal snapshot');
        }

        expect(computePrincipalStateSyncAudience({
            principalRef: read.snapshot.principal,
            ownSessions: toPrincipalAudienceSessions(read.snapshot.principal, read.snapshot.activeSessions),
            groupSnapshots: read.audienceGroupSnapshots,
            coMemberSessions: read.audienceCoMemberSessions,
            nowEpochMs: AUDIENCE_EPOCH_MS
        })).toEqual(['alice-session', 'bob-session']);
    });

    it('issues no audience reads for a heartbeat whose generation the session no longer carries', async () => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime);
        runtime.batchSelectors.length = 0;

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: heartbeatCommandFor('superseded-generation'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });

        expect(read.session?.value.generationId).toBe('alice-session-generation');
        expect(audienceSelectors(runtime.batchSelectors)).toEqual([]);
        expect(read.audienceGroupSnapshots).toEqual([]);
        expect(read.audienceCoMemberSessions).toEqual([]);
    });

    it('renews a heartbeat to the principal\'s own sessions without reading three co-members', async () => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime, ['bob', 'carol', 'dave']);
        runtime.batchSelectors.length = 0;
        const command = heartbeatCommandFor('alice-session-generation');

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command,
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        const computed = computeClientMutation({ command, read });

        expect(audienceSelectors(runtime.batchSelectors)).toEqual([]);
        expect(read.audienceGroupSnapshots).toEqual([]);
        expect(read.audienceCoMemberSessions).toEqual([]);
        expect(computed).toMatchObject({ outcome: 'write', principalAudienceSessionIds: ['alice-session'] });
        expect(() => assertClientMutationInvariants({ command, read, computed })).not.toThrow();
    });

    it('fans a session disconnect to every co-member session', async () => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime, ['bob', 'carol', 'dave']);
        const command = disconnectCommandFor('alice-session-generation');

        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command,
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        const computed = computeClientMutation({ command, read });

        expect(computed).toMatchObject({
            outcome: 'write',
            principalAudienceSessionIds: ['bob-session', 'carol-session', 'dave-session']
        });
        expect(() => assertClientMutationInvariants({ command, read, computed })).not.toThrow();
    });

    it('rejects a heartbeat write addressed to a co-member session', async () => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime, ['bob']);
        const command = heartbeatCommandFor('alice-session-generation');
        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command,
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        const computed = computeClientMutation({ command, read });
        if (computed.outcome !== 'write') {
            throw new Error('Expected a renewing heartbeat write');
        }

        expect(() =>
            assertClientMutationInvariants({
                command,
                read,
                computed: { ...computed, principalAudienceSessionIds: ['alice-session', 'bob-session'] }
            })
        ).toThrow('Client session heartbeat audience is not the principal\'s own sessions');
    });

    it.each([
        ['a stale-generation heartbeat', 'superseded-generation'],
        ['a renewing heartbeat', 'alice-session-generation']
    ])('rejects %s read that carries the co-member audience', async (_label, generationId) => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime);
        const coMemberRead = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('audience-carrying-read'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        expect(coMemberRead.audienceCoMemberSessions).toHaveLength(1);
        const command = heartbeatCommandFor(generationId);
        const session = await clients.readSessionEntry({
            ...TEST_SCOPE,
            principalId: 'alice',
            clientInstanceId: 'alice-instance',
            sessionId: 'alice-session'
        });

        expect(() => assertClientMutationRead(command, { ...coMemberRead, session: session.value ?? null })).toThrow(
            'Client mutation audience read is out of scope'
        );
    });

    it.each([
        [
            'a co-member outside the principal scope',
            { ...TEST_SCOPE, workspaceId: 'workspace-2', principalId: 'bob' },
            'bob',
            'is wrongly scoped'
        ],
        ['a session of another principal', { ...TEST_SCOPE, principalId: 'bob' }, 'carol', 'carries another principal\'s session']
    ])('rejects an audience read carrying %s', async (_label, principalRef, sessionPrincipalId, message) => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime);
        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('forged-audience'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        const forged = {
            principalRef,
            activeSessions: [
                session({ principalId: sessionPrincipalId, sessionId: 'forged-session', expiresAtEpochMs: 4_000_000_000_000 })
            ]
        };

        expect(() => assertClientMutationRead(principalCommand('forged-audience'), { ...read, audienceCoMemberSessions: [forged] })).toThrow(message);
    });

    it('rejects an audience read carrying a group snapshot outside the principal scope', async () => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime);
        const command = principalCommand('forged-group-audience');
        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command,
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        const [snapshot] = read.audienceGroupSnapshots;
        if (!snapshot) {
            throw new Error('Expected an audience group snapshot');
        }
        const forged = { ...snapshot, group: { ...snapshot.group, workspaceId: 'workspace-2' } };

        const assertForged = () => assertClientMutationRead(command, { ...read, audienceGroupSnapshots: [forged] });

        expect(assertForged).toThrow(ClientMutationRejectedError);
        expect(assertForged).toThrow('outside the requested scope');
    });

    it('rejects a heartbeat write computed outside the principal audience read scope', async () => {
        const runtime = new RecordingReadRepository();
        const { groups, clients } = await seedHeartbeatAudience(runtime);
        const command = heartbeatCommandFor('alice-session-generation');
        const read = await readClientMutation({
            repository: clients,
            groupRepository: groups,
            command,
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        });
        const computed = computeClientMutation({ command, read });
        expect(computed.outcome).toBe('write');
        const session = read.session;
        if (!session) {
            throw new Error('Expected Alice session read');
        }

        expect(() =>
            assertClientMutationInvariants({
                command,
                read: {
                    ...read,
                    session: { ...session, value: { ...session.value, generationId: 'superseded-generation' } },
                    audienceGroupSnapshots: [],
                    audienceCoMemberSessions: []
                },
                computed
            })
        ).toThrow('Client mutation write requires the principal audience read');
    });

    it('rejects a selected actor member stored in the wrong canonical slot', async () => {
        const runtime = new AudienceReadRepository();
        const groups = createTestGroupStateRepository(runtime);
        const clients = createTestClientStateRepository(runtime);
        await seedGroup({
            repository: groups,
            groupId: 'corrupt-room',
            ownerPrincipalId: 'alice',
            activePrincipalIds: ['bob'],
            leftPrincipalIds: []
        });
        await seedClient(clients, 'alice');
        const actorKey = groupStateMemberStorageKey({
            ...TEST_SCOPE,
            groupId: 'corrupt-room',
            principalId: 'alice'
        });
        await runtime.upsert(
            'group-state:members',
            actorKey,
            JSON.stringify(
                member({
                    groupId: 'corrupt-room',
                    principalId: 'mallory',
                    role: 'owner',
                    status: 'active'
                })
            ),
            Number.MAX_SAFE_INTEGER
        );

        await expect(readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('corrupt-membership'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        })).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption',
            storageKey: actorKey
        });
    });

    it('rejects a selected co-group principal stored in the wrong canonical slot', async () => {
        const runtime = new AudienceReadRepository();
        const groups = createTestGroupStateRepository(runtime);
        const clients = createTestClientStateRepository(runtime);
        await seedGroup({
            repository: groups,
            groupId: 'corrupt-client-room',
            ownerPrincipalId: 'alice',
            activePrincipalIds: ['bob'],
            leftPrincipalIds: []
        });
        await seedClient(clients, 'alice');
        await seedClient(clients, 'bob');
        const bobRef = { ...TEST_SCOPE, principalId: 'bob' };
        const bob = await clients.findPrincipal(bobRef);
        if (!bob) {
            throw new Error('Expected Bob principal before corruption');
        }
        const principalKey = clientStatePrincipalStorageKey(bobRef);
        await runtime.upsert(
            'client-state:principals',
            principalKey,
            JSON.stringify({ ...bob, principalId: 'erin' }),
            Number.MAX_SAFE_INTEGER
        );

        await expect(readClientMutation({
            repository: clients,
            groupRepository: groups,
            command: principalCommand('corrupt-co-group-client'),
            audienceObservedAtEpochMs: AUDIENCE_EPOCH_MS
        })).rejects.toMatchObject({
            code: 'client-state-repository-invariant-corruption',
            storageKey: principalKey
        });
    });
});

interface HeartbeatAudienceRepositories {
    readonly groups: ReturnType<typeof createTestGroupStateRepository>;
    readonly clients: ReturnType<typeof createTestClientStateRepository>;
}

async function seedHeartbeatAudience(
    runtime: FakeRuntimeStateRepository,
    coMemberPrincipalIds: readonly string[] = ['bob']
): Promise<HeartbeatAudienceRepositories> {
    const groups = createTestGroupStateRepository(runtime);
    const clients = createTestClientStateRepository(runtime);
    await seedGroup({
        repository: groups,
        groupId: 'room-one',
        ownerPrincipalId: 'alice',
        activePrincipalIds: coMemberPrincipalIds,
        leftPrincipalIds: []
    });
    for (const principalId of ['alice', ...coMemberPrincipalIds]) {
        await seedClient(clients, principalId);
    }
    return { groups, clients };
}

function disconnectCommandFor(generationId: string): ClientMutationCommand {
    const requestId = `disconnect:${generationId}`;
    const input = toDisconnectClientSessionMutationInput({
        operation: 'disconnectSession',
        scope: TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'alice-instance',
        sessionId: 'alice-session',
        request: {
            generationId,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            disconnectedAtEpochMs: HEARTBEAT_EPOCH_MS,
            reason: 'closed',
            requestId
        },
        defaultCommandId: requestId
    });
    return toClientMutationCommand(
        input,
        {
            nowEpochMs: HEARTBEAT_EPOCH_MS,
            serviceId: 'client-service',
            eventId: `event:${requestId}`,
            attemptCount: 1,
            expireAtEpochMs: 20_000,
            disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS
        },
        toClientMutationIssuedSessionAuthority(
            {
                clientId: 'alice',
                username: 'alice',
                sessionId: 'alice-session',
                accessTokenDigest: 'sha256:test-token',
                issuedAtEpochMs: 0,
                expiresAtEpochMs: 10_000
            },
            TEST_SCOPE,
            'disconnectSession'
        )
    );
}

function heartbeatCommandFor(generationId: string): ClientMutationCommand {
    const requestId = `heartbeat:${generationId}`;
    const input = toHeartbeatClientSessionMutationInput({
        scope: TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'alice-instance',
        sessionId: 'alice-session',
        request: {
            generationId,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            lastHeartbeatAtEpochMs: HEARTBEAT_EPOCH_MS,
            requestId
        },
        defaultCommandId: requestId
    });
    return toClientMutationCommand(
        input,
        {
            nowEpochMs: HEARTBEAT_EPOCH_MS,
            serviceId: 'client-service',
            eventId: `event:${requestId}`,
            attemptCount: 1,
            expireAtEpochMs: 20_000,
            disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS
        },
        toClientMutationIssuedSessionAuthority(
            {
                clientId: 'alice',
                username: 'alice',
                sessionId: 'alice-session',
                accessTokenDigest: 'sha256:test-token',
                issuedAtEpochMs: 0,
                expiresAtEpochMs: 10_000
            },
            TEST_SCOPE,
            'heartbeatSession'
        )
    );
}

function audienceSelectors(
    selectors: readonly RuntimeStateReadBatchSelector[]
): readonly RuntimeStateReadBatchSelector[] {
    return selectors.filter((selector) => selector.namespace.startsWith('group-state:') || isCoMemberClientSelector(selector));
}

function isCoMemberClientSelector(selector: RuntimeStateReadBatchSelector): boolean {
    return selector.namespace.startsWith('client-state:') &&
        /principal=(bob|carol|dave)/.test(JSON.stringify(selector));
}

interface SeedGroupInput {
    readonly repository: ReturnType<typeof createTestGroupStateRepository>;
    readonly groupId: string;
    readonly ownerPrincipalId: string;
    readonly activePrincipalIds: readonly string[];
    readonly leftPrincipalIds: readonly string[];
}

async function seedGroup(
    { repository, groupId, ownerPrincipalId, activePrincipalIds, leftPrincipalIds }: SeedGroupInput
): Promise<void> {
    const group: Group = createTestGroup({
        ...TEST_SCOPE,
        groupId,
        ownerPrincipalId,
        activeMemberCount: activePrincipalIds.length + 1,
        snapshotVersion: 1,
        rosterVersion: 1
    });
    await repository.putGroup(group);
    for (const principalId of [ownerPrincipalId, ...activePrincipalIds, ...leftPrincipalIds]) {
        const active = principalId === ownerPrincipalId || activePrincipalIds.includes(principalId);
        await repository.putMember(member({
            groupId,
            principalId,
            role: principalId === ownerPrincipalId ? 'owner' : 'member',
            status: active ? 'active' : 'left'
        }));
    }
}

interface MemberInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly role: GroupMember['role'];
    readonly status: 'active' | 'left';
}

function member({ groupId, principalId, role, status }: MemberInput): GroupMember {
    const common = {
        ...TEST_SCOPE,
        groupId,
        principalId,
        role,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        joined: audit(),
        removed: null,
        banned: null,
        updated: audit()
    };
    return status === 'active'
        ? { ...common, status: 'active', left: null }
        : { ...common, status: 'left', left: audit() };
}

async function seedClient(
    repository: ReturnType<typeof createTestClientStateRepository>,
    principalId: string,
    scope: typeof TEST_SCOPE = TEST_SCOPE,
    sessionId = `${principalId}-session`
): Promise<void> {
    const principal: ClientPrincipal = {
        ...scope,
        principalId,
        username: principalId,
        displayName: principalId,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        status: 'active',
        disabled: null,
        deleted: null,
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit(),
        updated: audit(),
        lastSeenAtEpochMs: 1
    };
    await repository.insertPrincipal(principal);
    await repository.insertInstance({ ...instance(principalId, `${principalId}-instance`), ...scope });
    await repository.insertSession({
        ...session({ principalId, sessionId, expiresAtEpochMs: 4_000_000_000_000 }),
        ...scope
    });
}

function instance(principalId: string, clientInstanceId: string): ClientInstance {
    return {
        ...TEST_SCOPE,
        principalId,
        clientInstanceId,
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit(),
        updated: audit()
    };
}

interface SessionInput {
    readonly principalId: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

function session({ principalId, sessionId, expiresAtEpochMs }: SessionInput): ClientSession {
    return {
        ...TEST_SCOPE,
        principalId,
        clientInstanceId: `${principalId}-instance`,
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function audit(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
