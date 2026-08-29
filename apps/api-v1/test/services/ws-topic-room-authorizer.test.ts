import { type GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { newALEventRoute, newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { AuditStamp, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import assert from 'node:assert/strict';

import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import type { ApiV1RoomWsAuthorizerDependencies } from '../../src/services/ws-topic-room-authorizer.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';

const ABSENT_POLICY: ApiV1RoomWsAuthorizerDependencies = {
    readLifecyclePolicy: () => Promise.resolve({ status: 'absent' })
};

Deno.test('API room authorization reads the current scoped group snapshot', async () => {
    const snapshot = createSnapshot();
    let requestedRef: unknown;
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: (ref) => {
            requestedRef = ref;
            return Promise.resolve(snapshot);
        }
    }, ABSENT_POLICY);
    const message = newALMulticastMessage(
        'session-1',
        newALEventRoute('room.chat', 'group-1', 'message-1'),
        snapshot.group,
        'chat.message.v1',
        { text: 'hello' }
    );

    const decision = await authorizer({
        message,
        roomId: 'group-1',
        roomRef: snapshot.group,
        senderId: 'session-1',
        topicId: 'room.chat',
        typeId: 'chat.message.v1'
    });

    assert.equal(decision, true);
    assert.deepEqual(requestedRef, snapshot.group);
});

Deno.test('API room authorization fails closed without a scoped group reference', async () => {
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () => Promise.resolve(createSnapshot())
    }, ABSENT_POLICY);
    const message = {
        ...newALMulticastMessage(
            'session-1',
            newALEventRoute('room.chat', 'group-1', 'message-1'),
            createSnapshot().group,
            'chat.message.v1',
            { text: 'hello' }
        ),
        targets: undefined
    };

    const decision = await authorizer({
        message,
        roomId: 'group-1',
        senderId: 'session-1',
        topicId: 'room.chat',
        typeId: 'chat.message.v1'
    });

    assert.equal(decision, false);
});

Deno.test('API room authorization observes remote bans and deletion across warm server caches', async () => {
    let current: GroupSnapshot | undefined = createSnapshot();
    let revisionProbes = 0;
    let stableReads = 0;
    const durable = {
        readCausalRevision: () => {
            revisionProbes += 1;
            return Promise.resolve(current?.causalRevision);
        },
        readSnapshot: () => {
            stableReads += 1;
            return Promise.resolve(current);
        }
    } as unknown as GroupStateService;
    const serverA = createCachedGroupStateService({
        durable,
        cache: createIndependentCache(() => {
            stableReads += 1;
            return Promise.resolve(current);
        })
    });
    const serverB = createCachedGroupStateService({
        durable,
        cache: createIndependentCache(() => {
            stableReads += 1;
            return Promise.resolve(current);
        })
    });
    const authorizer = createApiV1RoomWsAuthorizer(serverB, ABSENT_POLICY);
    const message = newALMulticastMessage(
        'session-1',
        newALEventRoute('room.chat', 'group-1', 'message-1'),
        createSnapshot().group,
        'chat.message.v1',
        { text: 'hello' }
    );
    const input = {
        message,
        roomId: 'group-1',
        roomRef: createSnapshot().group,
        senderId: 'session-1',
        topicId: 'room.chat',
        typeId: 'chat.message.v1'
    };

    assert.equal(await authorizer(input), true);
    const bannedSnapshot: GroupSnapshot = {
        ...createSnapshot(),
        causalRevision: { groupRevision: 3, presenceRevision: 1 },
        group: {
            ...createSnapshot().group,
            snapshotVersion: 3,
            activeMemberCount: 0
        },
        members: createSnapshot().members.map((member): GroupMember => ({
            ...member,
            status: 'banned',
            left: null,
            removed: null,
            banned: auditStamp(3)
        }))
    };
    current = bannedSnapshot;
    await serverA.observeSnapshot(bannedSnapshot);

    assert.notEqual(await authorizer(input), true);
    current = undefined;
    assert.equal(await authorizer(input), false);
    assert.equal(revisionProbes, 0);
    assert.equal(stableReads, 3);
});

Deno.test('API room authorization blocks pre-activation app data when policy says so', async () => {
    const snapshot = createConnectingSnapshot();
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () => Promise.resolve(snapshot)
    }, {
        readLifecyclePolicy: () =>
            Promise.resolve({
                status: 'present',
                policy: resolveGroupLifecyclePolicyPreset('match')
            })
    });

    const decision = await authorizer(roomChatInput(snapshot));

    assert.equal(typeof decision, 'object');
    assert.equal((decision as { authorized: boolean; }).authorized, false);
    assert.match(
        (decision as { logMessage?: string; }).logMessage ?? '',
        /group-data-blocked-until-active/
    );
});

Deno.test('API room authorization treats an absent pre-activation policy like an allowed policy', async () => {
    const snapshot = createConnectingSnapshot();
    for (
        const dependencies of [
            ABSENT_POLICY,
            {
                readLifecyclePolicy: () =>
                    Promise.resolve({
                        status: 'present' as const,
                        policy: resolveGroupLifecyclePolicyPreset('optimistic')
                    })
            }
        ]
    ) {
        const authorizer = createApiV1RoomWsAuthorizer({
            readCurrentSnapshot: () => Promise.resolve(snapshot)
        }, dependencies);

        assert.equal(await authorizer(roomChatInput(snapshot)), true);
    }
});

Deno.test('API room authorization fails closed on a corrupt policy before activation', async () => {
    const snapshot = createConnectingSnapshot();
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () => Promise.resolve(snapshot)
    }, {
        readLifecyclePolicy: () => Promise.resolve({ status: 'corrupt', reason: 'unreadable stored policy' })
    });

    const decision = await authorizer(roomChatInput(snapshot));

    assert.equal((decision as { authorized: boolean; }).authorized, false);
});

Deno.test('API room authorization reads no policy for active groups', async () => {
    const snapshot = createSnapshot();
    let policyReads = 0;
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () => Promise.resolve(snapshot)
    }, {
        readLifecyclePolicy: () => {
            policyReads += 1;
            return Promise.resolve({ status: 'absent' });
        }
    });

    const decision = await authorizer(roomChatInput(snapshot));

    assert.equal(decision, true);
    assert.equal(policyReads, 0);
});

Deno.test('API room authorization reads no policy during accepted-layout reconfiguration stages', async () => {
    for (const lifecycleState of ['reconfiguring', 'reconnecting'] as const) {
        const current = createSnapshot();
        const snapshot = {
            ...current,
            group: { ...current.group, lifecycleState }
        };
        let policyReads = 0;
        const authorizer = createApiV1RoomWsAuthorizer({
            readCurrentSnapshot: () => Promise.resolve(snapshot)
        }, {
            readLifecyclePolicy: () => {
                policyReads += 1;
                return Promise.resolve({ status: 'corrupt', reason: 'must not read' });
            }
        });

        assert.equal(await authorizer(roomChatInput(snapshot)), true);
        assert.equal(policyReads, 0);
    }
});

Deno.test('API room authorization denies halted application data in every stage without policy reads', async () => {
    for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
        for (const presetName of ['optimistic', 'match'] as const) {
            const current = createSnapshot();
            const snapshot = {
                ...current,
                group: {
                    ...current.group,
                    lifecycleState,
                    transportState: 'halted' as const
                }
            };
            let policyReads = 0;
            const authorizer = createApiV1RoomWsAuthorizer({
                readCurrentSnapshot: () => Promise.resolve(snapshot)
            }, {
                readLifecyclePolicy: () => {
                    policyReads += 1;
                    return Promise.resolve({
                        status: 'present' as const,
                        policy: resolveGroupLifecyclePolicyPreset(presetName)
                    });
                }
            });

            assert.notEqual(await authorizer(roomChatInput(snapshot)), true);
            assert.equal(policyReads, 0);
        }
    }
});

Deno.test('API room authorization exempts the CRDT topics from the data-policy gate', async () => {
    const snapshot = createConnectingSnapshot();
    let policyReads = 0;
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () => Promise.resolve(snapshot)
    }, {
        readLifecyclePolicy: () => {
            policyReads += 1;
            return Promise.resolve({
                status: 'present',
                policy: resolveGroupLifecyclePolicyPreset('match')
            });
        }
    });
    const message = newALMulticastMessage(
        'session-1',
        newALEventRoute('room.crdt', 'group-1', 'message-1'),
        snapshot.group,
        'crdt.update.v1',
        { update: 'payload' }
    );

    const decision = await authorizer({
        message,
        roomId: 'group-1',
        roomRef: snapshot.group,
        senderId: 'session-1',
        topicId: 'room.crdt',
        typeId: 'crdt.update.v1'
    });

    assert.equal(decision, true);
    assert.equal(policyReads, 0);
});

Deno.test('API room authorization allows CRDT while transport is halted without policy reads', async () => {
    const current = createConnectingSnapshot();
    const snapshot = {
        ...current,
        group: { ...current.group, transportState: 'halted' as const }
    };
    let policyReads = 0;
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () => Promise.resolve(snapshot)
    }, {
        readLifecyclePolicy: () => {
            policyReads += 1;
            return Promise.resolve({ status: 'corrupt', reason: 'must not read' });
        }
    });
    const message = newALMulticastMessage(
        'session-1',
        newALEventRoute('room.crdt', 'group-1', 'message-halted-crdt'),
        snapshot.group,
        'crdt.update.v1',
        { update: 'payload' }
    );

    assert.equal(
        await authorizer({
            message,
            roomId: 'group-1',
            roomRef: snapshot.group,
            senderId: 'session-1',
            topicId: 'room.crdt',
            typeId: 'crdt.update.v1'
        }),
        true
    );
    assert.equal(policyReads, 0);
});

function roomChatInput(snapshot: GroupSnapshot) {
    return {
        message: newALMulticastMessage(
            'session-1',
            newALEventRoute('room.chat', 'group-1', 'message-1'),
            snapshot.group,
            'chat.message.v1',
            { text: 'hello' }
        ),
        roomId: 'group-1',
        roomRef: snapshot.group,
        senderId: 'session-1',
        topicId: 'room.chat',
        typeId: 'chat.message.v1'
    };
}

function createConnectingSnapshot(): GroupSnapshot {
    const snapshot = createSnapshot();
    return {
        ...snapshot,
        group: { ...snapshot.group, lifecycleState: 'connecting', formationEpoch: 1 }
    };
}

function createIndependentCache(
    readDurable: () => Promise<GroupSnapshot | undefined>
) {
    let cached: GroupSnapshot | undefined;
    return {
        findOrLoadByRef: async (
            _ref: unknown,
            options: {
                minCausalRevision?: Readonly<{
                    groupRevision: number;
                    presenceRevision: number;
                }>;
            } = {}
        ) => {
            if (
                cached &&
                (options.minCausalRevision === undefined ||
                    (cached.causalRevision.groupRevision >=
                            options.minCausalRevision.groupRevision &&
                        cached.causalRevision.presenceRevision >=
                            options.minCausalRevision.presenceRevision))
            ) {
                return cached;
            }
            cached = await readDurable();
            return cached;
        },
        observe: (snapshot: GroupSnapshot) => {
            const order = cached === undefined
                ? null
                : compareGroupCausalRevision(snapshot.causalRevision, cached.causalRevision);
            if (order === 'incomparable') {
                throw new TypeError('Test cache received incomparable group snapshots');
            }
            const observation = cached === undefined
                ? 'inserted' as const
                : order === 'dominates'
                ? 'advanced' as const
                : 'duplicate' as const;
            if (observation !== 'duplicate') {
                cached = snapshot;
            }
            return observation;
        }
    };
}

function createSnapshot(): GroupSnapshot {
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            displayName: 'Group 1',
            snapshotVersion: 2,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            activeMemberCount: 1,
            ownerPrincipalId: 'alice',
            created: auditStamp(1),
            updated: auditStamp(2)
        }),
        members: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            joined: auditStamp(1),
            updated: auditStamp(2),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        }],
        activeSessions: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId: 'alice',
            sessionId: 'session-1',
            generationId: 'generation-1',
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 2,
            expiresAtEpochMs: Date.now() + 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }],
        memberCount: 1,
        onlineMemberCount: 1
    };
}

function auditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
