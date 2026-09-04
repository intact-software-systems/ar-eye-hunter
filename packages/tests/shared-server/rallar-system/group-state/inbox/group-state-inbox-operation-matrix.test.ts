import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    AUTHENTICATED_GROUP_INBOX_TYPES,
    type GroupAdmissionDeclineAppInboxPayload,
    type GroupAdmissionGrantAppInboxPayload,
    type GroupConnectAppInboxPayload,
    type GroupCreateAppInboxPayload,
    type GroupDirectorAppointAppInboxPayload,
    type GroupInviteAcceptAppInboxPayload,
    type GroupInviteRevokeAppInboxPayload,
    type GroupJoinAppInboxPayload,
    type GroupJoinCodeRotateAppInboxPayload,
    type GroupLifecycleTransitionAppInboxPayload,
    type GroupMemberRemoveAppInboxPayload,
    type GroupMemberRoleSetAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupOwnershipTransferAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceDisconnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupReconfigureAppInboxPayload,
    type GroupTransportCommandAppInboxPayload,
    type GroupUpdateAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

import {
    createGovernedOperationCase,
    createInviteOperationCase,
    readMatrixMember,
    readMatrixPresenceSession,
    runOperationMatrix,
    type OperationMatrixCase
} from './group-state-inbox-operation-matrix-runtime.ts';
import { createAuthorityHarness, processAuthenticated, SCOPE } from './group-state-inbox-test-runtime.ts';

/**
 * Advertised operations the `cases` array below does not carry. Declared so
 * the coupling assertion can be exact: a prose note beside the advertised list
 * cannot stop an operation from being advertised and then silently going
 * unrun, which is what this list existing at all makes visible.
 *
 * Both entries reach their source stages only against a stored planned row,
 * which the matrix harness does not have, so both run the real phases in this
 * file's second test instead; `connect` also lands its denial against a
 * missing row after the matrix. Nothing else is advertised and unrun: 8d
 * retired the two legacy establishment commands and 6c gave `start` and
 * `reset` their own cases.
 */
const INBOX_TYPES_OUTSIDE_THE_CASE_ARRAY: readonly AppInboxType[] = [
    AppInboxType.GROUP_CONNECT,
    AppInboxType.GROUP_ACTIVATE
];

describe('GroupStateInboxService authenticated authority', () => {
    it('exposes transaction-injected mutation phases without direct mutation bypasses', async () => {
        const harness = await createAuthorityHarness(['owner']);
        expect(harness.groupStateService).toMatchObject({
            read: expect.any(Function),
            compute: expect.any(Function),
            validate: expect.any(Function),
            write: expect.any(Function)
        });
        for (
            const method of [
                'createGroup',
                'updateGroup',
                'joinGroup',
                'upsertMember',
                'connectPresenceSession',
                'heartbeatPresenceSession',
                'disconnectPresenceSession'
            ]
        ) {
            expect(Reflect.get(harness.groupStateService, method)).toBeUndefined();
        }
    });

    it('advertises every authenticated group operation covered by the real handler matrix', () => {
        expect(AUTHENTICATED_GROUP_INBOX_TYPES).toEqual([
            AppInboxType.GROUP_CREATE,
            AppInboxType.GROUP_UPDATE,
            AppInboxType.GROUP_DIRECTOR_APPOINT,
            AppInboxType.GROUP_PLAN,
            AppInboxType.GROUP_CONNECT,
            AppInboxType.GROUP_ACTIVATE,
            AppInboxType.GROUP_RECONFIGURE,
            AppInboxType.GROUP_JOIN,
            AppInboxType.GROUP_INVITE_CREATE,
            AppInboxType.GROUP_INVITE_REVOKE,
            AppInboxType.GROUP_INVITE_ACCEPT,
            AppInboxType.GROUP_ADMISSION_GRANT,
            AppInboxType.GROUP_ADMISSION_DECLINE,
            AppInboxType.GROUP_JOIN_CODE_ROTATE,
            AppInboxType.GROUP_MEMBER_REMOVE,
            AppInboxType.GROUP_MEMBER_BAN,
            AppInboxType.GROUP_MEMBER_UNBAN,
            AppInboxType.GROUP_MEMBER_ROLE_SET,
            AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            AppInboxType.GROUP_MEMBER_UPSERT,
            AppInboxType.GROUP_PRESENCE_CONNECT,
            AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            AppInboxType.GROUP_PRESENCE_DISCONNECT,
            AppInboxType.GROUP_TRANSPORT_PAUSE,
            AppInboxType.GROUP_TRANSPORT_RESUME,
            AppInboxType.GROUP_FORMATION_START,
            AppInboxType.GROUP_FORMATION_RESET
        ]);
    });

    it(
        'runs every advertised group operation through real AppGroup phases and one transaction',
        async () => {
            const harness = await createAuthorityHarness(['owner', 'bob', 'charlie']);
            const groupId = 'operation-matrix-room';
            const reconfigureGroupId = 'operation-matrix-reconfigure';
            const phasedGroupId = 'operation-matrix-phased';
            const resetGroupId = 'operation-matrix-reset';
            const admissionGroupId = 'operation-matrix-admissions';
            const ownerActor = {
                actorPrincipalId: 'owner',
                actorSessionId: 'owner-session'
            } as const;
            const bobActor = {
                actorPrincipalId: 'bob',
                actorSessionId: 'bob-session'
            } as const;
            const charlieActor = {
                actorPrincipalId: 'charlie',
                actorSessionId: 'charlie-session'
            } as const;
            const cases: readonly OperationMatrixCase[] = [
                {
                    type: AppInboxType.GROUP_CREATE,
                    operation: 'createGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        request: {
                            groupId,
                            displayName: 'Operation Matrix',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: 'owner',
                            ...ownerActor,
                            requestId: 'matrix-create'
                        }
                    } satisfies GroupCreateAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.displayName
                        ).toBe('Operation Matrix');
                    }
                },
                {
                    type: AppInboxType.GROUP_UPDATE,
                    operation: 'updateGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: {
                            description: 'Updated through AppGroup',
                            ...ownerActor,
                            requestId: 'matrix-update'
                        }
                    } satisfies GroupUpdateAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.description
                        ).toBe('Updated through AppGroup');
                    }
                },
                {
                    type: AppInboxType.GROUP_JOIN,
                    operation: 'joinGroup',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: { ...bobActor, requestId: 'matrix-join-bob' }
                    } satisfies GroupJoinAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'bob')).toMatchObject({
                            status: 'active',
                            role: 'member'
                        });
                    }
                },
                createInviteOperationCase({
                    harness,
                    groupId,
                    ownerActor,
                    requestId: 'matrix-invite-charlie',
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
                            status: 'invited',
                            invitedByPrincipalId: 'owner'
                        });
                    }
                }),
                {
                    type: AppInboxType.GROUP_INVITE_REVOKE,
                    operation: 'revokeGroupInvite',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId,
                        principalId: 'charlie',
                        request: { ...ownerActor, requestId: 'matrix-revoke-charlie' }
                    } satisfies GroupInviteRevokeAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
                            status: 'left'
                        });
                    }
                },
                createInviteOperationCase({
                    harness,
                    groupId,
                    ownerActor,
                    requestId: 'matrix-reinvite-charlie',
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
                            status: 'invited'
                        });
                    }
                }),
                {
                    type: AppInboxType.GROUP_INVITE_ACCEPT,
                    operation: 'acceptGroupInvite',
                    authority: harness.sessions.charlie,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: { ...charlieActor, requestId: 'matrix-accept-charlie' }
                    } satisfies GroupInviteAcceptAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
                            status: 'active'
                        });
                    }
                },
                // The admission decisions need a group whose policy parks joins: a
                // manager-approval group with the owner as its assigned manager.
                {
                    type: AppInboxType.GROUP_CREATE,
                    operation: 'createGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        request: {
                            groupId: admissionGroupId,
                            displayName: 'Operation Matrix Admissions',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: 'owner',
                            lifecyclePolicy: {
                                manager: { selection: 'assigned', assignedPrincipalIds: ['owner'] },
                                admission: { mode: 'manager-approval' }
                            },
                            ...ownerActor,
                            requestId: 'matrix-create-admissions'
                        }
                    } satisfies GroupCreateAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId: admissionGroupId }))?.group
                                .lifecycleState
                        ).toBe('active');
                    }
                },
                {
                    type: AppInboxType.GROUP_JOIN,
                    operation: 'joinGroup',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId: admissionGroupId,
                        request: { ...bobActor, requestId: 'matrix-park-bob' }
                    } satisfies GroupJoinAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, admissionGroupId, 'bob')).toMatchObject({
                            status: 'pending'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_ADMISSION_DECLINE,
                    operation: 'declineGroupAdmission',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: admissionGroupId,
                        principalId: 'bob',
                        request: { ...ownerActor, requestId: 'matrix-decline-bob' }
                    } satisfies GroupAdmissionDeclineAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, admissionGroupId, 'bob')).toMatchObject({
                            status: 'left'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_JOIN,
                    operation: 'joinGroup',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId: admissionGroupId,
                        request: { ...bobActor, requestId: 'matrix-repark-bob' }
                    } satisfies GroupJoinAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, admissionGroupId, 'bob')).toMatchObject({
                            status: 'pending'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_ADMISSION_GRANT,
                    operation: 'grantGroupAdmission',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: admissionGroupId,
                        principalId: 'bob',
                        request: { ...ownerActor, requestId: 'matrix-grant-bob' }
                    } satisfies GroupAdmissionGrantAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, admissionGroupId, 'bob')).toMatchObject({
                            status: 'active'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
                    operation: 'rotateGroupJoinCode',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: {
                            joinCode: 'MATRIX42',
                            expiresAtEpochMs: harness.nowEpochMs + 120_000,
                            ...ownerActor,
                            requestId: 'matrix-rotate-code'
                        }
                    } satisfies GroupJoinCodeRotateAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.metadata
                        ).toHaveProperty('rallarJoinCode');
                    }
                },
                {
                    type: AppInboxType.GROUP_MEMBER_ROLE_SET,
                    operation: 'setGroupMemberRole',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId,
                        principalId: 'bob',
                        request: { role: 'admin', ...ownerActor, requestId: 'matrix-role-bob' }
                    } satisfies GroupMemberRoleSetAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'bob')).toMatchObject({ role: 'admin' });
                    }
                },
                createGovernedOperationCase({
                    harness,
                    groupId,
                    ownerActor,
                    type: AppInboxType.GROUP_MEMBER_BAN,
                    operation: 'banGroupMember',
                    requestId: 'matrix-ban-charlie',
                    status: 'banned'
                }),
                createGovernedOperationCase({
                    harness,
                    groupId,
                    ownerActor,
                    type: AppInboxType.GROUP_MEMBER_UNBAN,
                    operation: 'unbanGroupMember',
                    requestId: 'matrix-unban-charlie',
                    status: 'left'
                }),
                {
                    type: AppInboxType.GROUP_MEMBER_UPSERT,
                    operation: 'upsertMember',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId,
                        principalId: 'charlie',
                        request: { status: 'active', ...ownerActor, requestId: 'matrix-upsert' }
                    } satisfies GroupMemberUpsertAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
                            status: 'active'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
                    operation: 'transferGroupOwnership',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: {
                            newOwnerPrincipalId: 'bob',
                            ...ownerActor,
                            requestId: 'matrix-transfer'
                        }
                    } satisfies GroupOwnershipTransferAppInboxPayload,
                    assertDomain: async () => {
                        const members = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.members;
                        expect(members?.find((member) => member.principalId === 'owner')?.role).toBe('admin');
                        expect(members?.find((member) => member.principalId === 'bob')?.role).toBe('owner');
                    }
                },
                {
                    type: AppInboxType.GROUP_MEMBER_REMOVE,
                    operation: 'removeGroupMember',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId,
                        principalId: 'charlie',
                        request: { ...bobActor, requestId: 'matrix-remove-charlie' }
                    } satisfies GroupMemberRemoveAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
                            status: 'removed'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_PRESENCE_CONNECT,
                    operation: 'connectPresence',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId,
                        sessionId: 'bob-session',
                        request: {
                            principalId: 'bob',
                            generationId: 'matrix-generation',
                            connectedAtEpochMs: harness.nowEpochMs,
                            lastHeartbeatAtEpochMs: harness.nowEpochMs,
                            expiresAtEpochMs: harness.nowEpochMs + 60_000,
                            ...bobActor,
                            requestId: 'matrix-connect'
                        }
                    } satisfies GroupPresenceConnectAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixPresenceSession(harness, groupId, 'bob-session')).toMatchObject({
                            generationId: 'matrix-generation',
                            status: 'active'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_DIRECTOR_APPOINT,
                    operation: 'appointDirector',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: { ...bobActor, requestId: 'matrix-director' }
                    } satisfies GroupDirectorAppointAppInboxPayload,
                    assertDomain: async () => {
                        const snapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
                        expect(snapshot?.group.metadata).toHaveProperty('rallarDirector');
                    }
                },
                {
                    type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
                    operation: 'heartbeatPresence',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId,
                        sessionId: 'bob-session',
                        request: {
                            principalId: 'bob',
                            generationId: 'matrix-generation',
                            lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000,
                            expiresAtEpochMs: harness.nowEpochMs + 61_000,
                            ...bobActor,
                            requestId: 'matrix-heartbeat'
                        }
                    } satisfies GroupPresenceHeartbeatAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixPresenceSession(harness, groupId, 'bob-session')).toMatchObject({
                            lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
                    operation: 'disconnectPresence',
                    authority: harness.sessions.bob,
                    data: {
                        scope: SCOPE,
                        groupId,
                        sessionId: 'bob-session',
                        request: {
                            principalId: 'bob',
                            generationId: 'matrix-generation',
                            disconnectedAtEpochMs: harness.nowEpochMs + 2_000,
                            ...bobActor,
                            requestId: 'matrix-disconnect'
                        }
                    } satisfies GroupPresenceDisconnectAppInboxPayload,
                    assertDomain: async () => {
                        expect(await readMatrixPresenceSession(harness, groupId, 'bob-session')).toMatchObject({
                            status: 'disconnected'
                        });
                    }
                },
                {
                    type: AppInboxType.GROUP_CREATE,
                    operation: 'createGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        request: {
                            groupId: reconfigureGroupId,
                            displayName: 'Operation Matrix Reconfigure',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: 'owner',
                            lifecyclePolicy: { topology: { reconfigureLanding: 'hold' } },
                            ...ownerActor,
                            requestId: 'matrix-create-reconfigure'
                        }
                    } satisfies GroupCreateAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId: reconfigureGroupId }))
                                ?.group.lifecycleState
                        ).toBe('active');
                    }
                },
                {
                    type: AppInboxType.GROUP_RECONFIGURE,
                    operation: 'reconfigureGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: reconfigureGroupId,
                        request: {
                            expectedFormationEpoch: 0,
                            landing: null,
                            ...ownerActor,
                            requestId: 'matrix-reconfigure'
                        }
                    } satisfies GroupReconfigureAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId: reconfigureGroupId }))
                                ?.group.lifecycleState
                        ).toBe('reconfiguring');
                    }
                },
                {
                    type: AppInboxType.GROUP_CREATE,
                    operation: 'createGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        request: {
                            groupId: phasedGroupId,
                            displayName: 'Operation Matrix Phased',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: 'owner',
                            lifecyclePolicy: { formation: 'phased' },
                            ...ownerActor,
                            requestId: 'matrix-create-phased'
                        }
                    } satisfies GroupCreateAppInboxPayload,
                    // A phased creation arms the plan trigger's timer beside its summary (plan slice 11a).
                    extraOutboxEntries: 1,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId: phasedGroupId }))
                                ?.group.lifecycleState
                        ).toBe('forming');
                    }
                },
                {
                    type: AppInboxType.GROUP_PLAN,
                    operation: 'planGroupLayout',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: phasedGroupId,
                        request: { ...ownerActor, requestId: 'matrix-plan' }
                    } satisfies GroupLifecycleTransitionAppInboxPayload,
                    // The plan arms the connect trigger's latch and its intent work under the default preset (plan slice 11a).
                    extraOutboxEntries: 1,
                    assertDomain: async () => {
                        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId: phasedGroupId }))?.group;
                        expect(group?.lifecycleState).toBe('planned');
                        expect(group?.formationEpoch).toBe(1);
                    }
                },
                {
                    type: AppInboxType.GROUP_PLAN,
                    operation: 'planGroupLayout',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: phasedGroupId,
                        request: { ...ownerActor, requestId: 'matrix-replan' }
                    } satisfies GroupLifecycleTransitionAppInboxPayload,
                    assertDomain: async () => {
                        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId: phasedGroupId }))?.group;
                        // The idempotent replan re-pins nothing (decision 28).
                        expect(group?.lifecycleState).toBe('planned');
                        expect(group?.formationEpoch).toBe(1);
                    }
                },
                {
                    type: AppInboxType.GROUP_TRANSPORT_PAUSE,
                    operation: 'pauseGroupTransport',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: phasedGroupId,
                        request: { ...ownerActor, requestId: 'matrix-pause' }
                    } satisfies GroupTransportCommandAppInboxPayload,
                    assertDomain: async () => {
                        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId: phasedGroupId }))?.group;
                        expect(group?.transportState).toBe('halted');
                        // The valve is not a stage (decision 25): the routing plane
                        // the replan left behind is exactly where it was.
                        expect(group?.lifecycleState).toBe('planned');
                        expect(group?.formationEpoch).toBe(1);
                    }
                },
                {
                    type: AppInboxType.GROUP_TRANSPORT_RESUME,
                    operation: 'resumeGroupTransport',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: phasedGroupId,
                        request: { ...ownerActor, requestId: 'matrix-resume' }
                    } satisfies GroupTransportCommandAppInboxPayload,
                    assertDomain: async () => {
                        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId: phasedGroupId }))?.group;
                        expect(group?.transportState).toBe('flowing');
                        expect(group?.lifecycleState).toBe('planned');
                        expect(group?.formationEpoch).toBe(1);
                    }
                },
                {
                    type: AppInboxType.GROUP_CREATE,
                    operation: 'createGroup',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        request: {
                            groupId: resetGroupId,
                            displayName: 'Operation Matrix Reset',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: 'owner',
                            ...ownerActor,
                            requestId: 'matrix-create-reset'
                        }
                    } satisfies GroupCreateAppInboxPayload,
                    assertDomain: async () => {
                        expect(
                            (await harness.repository.readSnapshot({ ...SCOPE, groupId: resetGroupId }))
                                ?.group.lifecycleState
                        ).toBe('active');
                    }
                },
                {
                    type: AppInboxType.GROUP_FORMATION_RESET,
                    operation: 'resetGroupFormation',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: resetGroupId,
                        request: { ...ownerActor, requestId: 'matrix-reset' }
                    } satisfies GroupLifecycleTransitionAppInboxPayload,
                    assertDomain: async () => {
                        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId: resetGroupId }))?.group;
                        expect(group?.lifecycleState).toBe('dormant');
                        expect(group?.transportState).toBe('halted');
                    }
                },
                {
                    type: AppInboxType.GROUP_FORMATION_START,
                    operation: 'startGroupFormation',
                    authority: harness.sessions.owner,
                    data: {
                        scope: SCOPE,
                        groupId: resetGroupId,
                        request: { ...ownerActor, requestId: 'matrix-start-after-reset' }
                    } satisfies GroupLifecycleTransitionAppInboxPayload,
                    assertDomain: async () => {
                        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId: resetGroupId }))?.group;
                        expect(group?.lifecycleState).toBe('forming');
                    }
                }
            ];

            // The array carries exactly the advertised operations bar the declared
            // exceptions. Advertising one without running it, or dropping one that was
            // running, now fails here instead of passing quietly.
            expect([...new Set(cases.map((operationCase) => operationCase.type))].sort()).toEqual(
                AUTHENTICATED_GROUP_INBOX_TYPES
                    .filter((type) => !INBOX_TYPES_OUTSIDE_THE_CASE_ARRAY.includes(type))
                    .toSorted()
            );

            await runOperationMatrix(harness, groupId, cases);

            // `connect` executes the same real phases and lands its typed 409 denial:
            // with no planned topology row stored, the fence answers
            // no-planned-layout — proving the dispatch classifier routes the new
            // operation into the lifecycle builder, not the membership fallthrough.
            const connectResult = await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    type: AppInboxType.GROUP_CONNECT,
                    resourceId: 'matrix-connect',
                    contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${phasedGroupId}`,
                    senderId: harness.sessions.owner.clientId,
                    data: {
                        scope: SCOPE,
                        groupId: phasedGroupId,
                        request: {
                            ...ownerActor,
                            requestId: 'matrix-connect',
                            expectedFormationEpoch: 1,
                            expectedLayout: {
                                groupRevision: 1,
                                presenceRevision: 0,
                                version: 1,
                                state: 'active'
                            }
                        }
                    } satisfies GroupConnectAppInboxPayload
                }
            });
            // The code and status are what a caller acts on: a generic rejection
            // would still carry the phrase, so assert the mapped conflict itself.
            expect(connectResult.left?.code).toBe('group-connect-no-planned-layout');
            expect(connectResult.left?.status).toBe(409);
        },
        30_000
    );

    it(
        'connects against a stored planned layout, then activates the layout it dialed',
        async () => {
            // `connect` and `activate` both succeed only against a stored planned
            // row, so this runs its own harness with that row present. `connect`
            // must land the stage, stamp the establishment clock, and commit the
            // planned row's revision guard (the batch's fence against a replan
            // landing between read and commit); `activate` is then the only
            // command that promotes what `connect` dialed, and `connecting` is
            // reachable no other way, which is why the two share a run.
            const groupId = 'connect-success-room';
            const plannedIdentity = {
                groupRevision: 1,
                presenceRevision: 0,
                version: 1,
                state: 'active' as const
            };
            // The guard updates the stored row, so the row must really exist in the
            // same store the batch writes — a stubbed reader alone would make the
            // batch conflict, which is exactly what this fence is for. The store and
            // its row are therefore built before the harness that reads them.
            const runtimeRepository = new FakeRuntimeStateRepository();
            const plannedSnapshots = new RtcTopologySnapshotRepository(runtimeRepository);
            await plannedSnapshots.commitSnapshot({
                candidate: connectPlannedSnapshot(groupId, plannedIdentity)
            });
            const harness = await createAuthorityHarness(['owner'], {
                runtimeRepository,
                readPlannedLayoutRow: async (ref) => {
                    const entry = await plannedSnapshots.findSnapshotEntry(ref);
                    return entry ? { snapshot: entry.value, revision: entry.entry.revision } : null;
                }
            });
            const ownerActor = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' } as const;
            const contextId = `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`;
            const created = await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    type: AppInboxType.GROUP_CREATE,
                    resourceId: 'connect-create',
                    contextId,
                    senderId: harness.sessions.owner.clientId,
                    data: {
                        scope: SCOPE,
                        request: {
                            groupId,
                            displayName: 'Connect Success',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: 'owner',
                            lifecyclePolicy: { formation: 'phased' },
                            ...ownerActor,
                            requestId: 'connect-create'
                        }
                    } satisfies GroupCreateAppInboxPayload
                }
            });
            expect(created.right).toBeDefined();

            const planned = await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    type: AppInboxType.GROUP_PLAN,
                    resourceId: 'connect-plan',
                    contextId,
                    senderId: harness.sessions.owner.clientId,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: { ...ownerActor, requestId: 'connect-plan' }
                    } satisfies GroupLifecycleTransitionAppInboxPayload
                }
            });
            expect(planned.right).toBeDefined();
            const plannedGroup = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
            expect(plannedGroup?.lifecycleState).toBe('planned');

            const plannedBefore = (await plannedSnapshots.findSnapshotEntry({ ...SCOPE, groupId }))?.entry.revision ?? 0;
            const connected = await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    type: AppInboxType.GROUP_CONNECT,
                    resourceId: 'connect-success',
                    contextId,
                    senderId: harness.sessions.owner.clientId,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: {
                            ...ownerActor,
                            requestId: 'connect-success',
                            expectedFormationEpoch: plannedGroup?.formationEpoch ?? 0,
                            expectedLayout: plannedIdentity
                        }
                    } satisfies GroupConnectAppInboxPayload
                }
            });

            expect(connected.left).toBeUndefined();
            const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
            expect(group?.lifecycleState).toBe('connecting');
            expect(group?.formationEpoch).toBe((plannedGroup?.formationEpoch ?? 0) + 1);
            // Entering a dialing stage starts the attempt clock.
            expect(group?.establishmentStartedAtEpochMs).not.toBe(null);
            // Dialing a candidate is not acceptance (decision 42).
            expect(group?.acceptedLayoutIdentity).toBe(null);
            // The commit re-asserted the planned row: the guard rewrote it in the
            // same batch, so its revision advanced exactly once.
            const plannedAfter = await plannedSnapshots.findSnapshotEntry({ ...SCOPE, groupId });
            expect(plannedAfter?.entry.revision).toBe(plannedBefore + 1);
            expect(plannedAfter?.value).toEqual(connectPlannedSnapshot(groupId, plannedIdentity));

            // Dialing left the accepted slot empty, so what activation adds is
            // visible: the promotion writes it in the stage's own transaction
            // (decisions 24/42).
            const acceptedSnapshots = new RtcTopologySnapshotRepository(
                runtimeRepository,
                RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
            );
            expect(await acceptedSnapshots.findSnapshotEntry({ ...SCOPE, groupId })).toBeUndefined();

            const activated = await processAuthenticated({
                service: harness.service,
                reader: harness.reader,
                authority: harness.sessions.owner,
                input: {
                    type: AppInboxType.GROUP_ACTIVATE,
                    resourceId: 'connect-activate',
                    contextId,
                    senderId: harness.sessions.owner.clientId,
                    data: {
                        scope: SCOPE,
                        groupId,
                        request: { ...ownerActor, requestId: 'connect-activate' }
                    } satisfies GroupLifecycleTransitionAppInboxPayload
                }
            });

            expect(activated.left).toBeUndefined();
            const activeGroup = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
            expect(activeGroup?.lifecycleState).toBe('active');
            expect(activeGroup?.formationEpoch).toBe((group?.formationEpoch ?? 0) + 1);
            // The group row names the accepted identity and the accepted slot
            // holds the snapshot behind it: one promotion, not two sources of
            // truth.
            expect(activeGroup?.acceptedLayoutIdentity).toEqual(plannedIdentity);
            const accepted = await acceptedSnapshots.findSnapshotEntry({ ...SCOPE, groupId });
            expect(accepted?.value).toEqual(connectPlannedSnapshot(groupId, plannedIdentity));
            // The promotion re-asserts the planned row too, so its guard
            // advanced a second time in activation's batch.
            const plannedAfterActivation = await plannedSnapshots.findSnapshotEntry({ ...SCOPE, groupId });
            expect(plannedAfterActivation?.entry.revision).toBe(plannedBefore + 2);
        },
        30_000
    );
});

function connectPlannedSnapshot(
    groupId: string,
    identity: Readonly<{
        groupRevision: number;
        presenceRevision: number;
        version: number;
        state: 'active' | 'removed';
    }>
) {
    const groupRef = { ...SCOPE, groupId };
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: identity.groupRevision,
            presenceRevision: identity.presenceRevision
        },
        state: identity.state,
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: groupId,
        topology: 'tree' as const,
        activeSessionIds: [],
        nextHopsBySessionId: {},
        degreeLimit: 1,
        version: identity.version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2
    };
}
