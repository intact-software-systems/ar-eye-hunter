import assert from 'node:assert/strict';

import type {
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizationInput
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { newALEventRoute, newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import type { ApiV1RoomWsAuthorizerDependencies } from '../../src/services/ws-topic-room-authorizer.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';
import { createRoomStateTestRuntime, putRoomSnapshot } from './ws-room-test-runtime.ts';

const ABSENT_POLICY: ApiV1RoomWsAuthorizerDependencies = {
    readLifecyclePolicy: () => Promise.resolve({ status: 'absent' })
};

Deno.test('API room authorization reads the current scoped group snapshot', async () => {
    const snapshot = createSnapshot();
    let requestedRef: GroupRef | undefined;
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

    assertAuthorized(decision);
    assert.deepEqual(decision.audience, { targets: message.targets, sessions: snapshot.activeSessions });
    assert.deepEqual(requestedRef, snapshot.group);
});

Deno.test('API room authorization rejects a different room in the same application and workspace', async () => {
    const snapshot = createSnapshot();
    const authorizer = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: () =>
            Promise.resolve({
                ...snapshot,
                group: { ...snapshot.group, groupId: 'another-room' },
                members: snapshot.members.map((member) => ({ ...member, groupId: 'another-room' })),
                activeSessions: snapshot.activeSessions.map((session) => ({ ...session, groupId: 'another-room' }))
            })
    }, ABSENT_POLICY);

    const decision = await authorizer(roomChatInput(snapshot));

    assertDenied(decision);
    assert.ok(typeof decision !== 'boolean' && !decision.authorized);
    assert.match(decision.logMessage ?? '', /scope mismatch/);
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
    const serverA = createRoomStateTestRuntime();
    const serverB = createRoomStateTestRuntime(serverA.runtimeRepository);
    const snapshot = createSnapshot();
    await putRoomSnapshot(serverA.repository, snapshot);
    serverA.cache.observe(snapshot);
    serverB.cache.observe(snapshot);
    const authorizer = createApiV1RoomWsAuthorizer(serverB.groupStateService, ABSENT_POLICY);
    try {
        assertAuthorized(await authorizer(roomChatInput(snapshot)));
        const bannedSnapshot: GroupSnapshot = {
            ...snapshot,
            causalRevision: { groupRevision: 3, presenceRevision: 1 },
            group: { ...snapshot.group, snapshotVersion: 3, activeMemberCount: 1 },
            members: snapshot.members.map((member): GroupMember =>
                member.principalId === 'principal-session-1'
                    ? { ...member, status: 'banned', left: null, removed: null, banned: auditStamp(3) }
                    : member
            ),
            activeSessions: [],
            memberCount: 1,
            onlineMemberCount: 0
        };
        await putRoomSnapshot(serverA.repository, bannedSnapshot);
        serverA.cache.observe(bannedSnapshot);
        assertDenied(await authorizer(roomChatInput(snapshot)));
        assert.deepEqual(serverB.cache.findByRef(snapshot.group), snapshot);
        serverA.runtimeRepository.data.clear();
        assert.equal(await authorizer(roomChatInput(snapshot)), false);
        assert.equal(serverB.reads.revisions, 0);
        assert.equal(serverB.reads.snapshots, 3);
    }
    finally {
        await serverA.manager.clear();
        await serverB.manager.clear();
    }
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

    assertDenied(decision);
    assert.ok(typeof decision !== 'boolean' && !decision.authorized);
    assert.match(
        decision.logMessage ?? '',
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

        assertAuthorized(await authorizer(roomChatInput(snapshot)));
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

    assertDenied(decision);
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

    assertAuthorized(decision);
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

        assertAuthorized(await authorizer(roomChatInput(snapshot)));
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

            assertDenied(await authorizer(roomChatInput(snapshot)));
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

    assertAuthorized(decision);
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

    assertAuthorized(
        await authorizer({
            message,
            roomId: 'group-1',
            roomRef: snapshot.group,
            senderId: 'session-1',
            topicId: 'room.crdt',
            typeId: 'crdt.update.v1'
        })
    );
    assert.equal(policyReads, 0);
});

function roomChatInput(snapshot: GroupSnapshot): RallarServerWsRoomAuthorizationInput {
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

function createSnapshot(): GroupSnapshot {
    return createGroupSnapshot(2, ['session-1']);
}

function assertAuthorized(
    decision: RallarServerWsRoomAuthorizationDecision
): asserts decision is Extract<RallarServerWsRoomAuthorizationDecision, { authorized: true; }> {
    assert.ok(typeof decision !== 'boolean' && decision.authorized);
    assert.ok(decision.audience);
}

function assertDenied(decision: RallarServerWsRoomAuthorizationDecision): void {
    assert.ok(decision === false || (typeof decision !== 'boolean' && !decision.authorized));
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
