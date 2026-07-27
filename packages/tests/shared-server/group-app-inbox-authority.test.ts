import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import {
    type AppInboxTestDatabase,
    createAppInboxTestDatabase,
} from './app-inbox-test-database.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    AppGroupInboxService,
    AppInboxService,
    type AppInboxEnqueueInput,
    AppInboxType,
    type GroupCreateAppInboxPayload,
    type GroupDirectorAppointAppInboxPayload,
    type GroupInviteAcceptAppInboxPayload,
    type GroupInviteCreateAppInboxPayload,
    type GroupInviteRevokeAppInboxPayload,
    type GroupJoinAppInboxPayload,
    type GroupJoinCodeRotateAppInboxPayload,
    type GroupMemberBanAppInboxPayload,
    type GroupMemberRemoveAppInboxPayload,
    type GroupMemberRoleSetAppInboxPayload,
    type GroupMemberUnbanAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupOwnershipTransferAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceDisconnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import * as AppGroupInboxModule from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
    createGroupStateService,
    GroupMutationAuthorizationError,
    type GroupStateService,
    type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
};

describe('AppGroupInboxService authenticated authority', () => {
    it('exposes transaction-injected mutation phases without direct mutation bypasses', async () => {
        const harness = await createAuthorityHarness(['owner']);

        expect(harness.groupStateService).toMatchObject({
            read: expect.any(Function),
            compute: expect.any(Function),
            validate: expect.any(Function),
            write: expect.any(Function),
        });
        for (const method of [
            'createGroup',
            'updateGroup',
            'joinGroup',
            'upsertMember',
            'connectPresenceSession',
            'heartbeatPresenceSession',
            'disconnectPresenceSession',
        ]) {
            expect(Reflect.get(harness.groupStateService, method)).toBeUndefined();
        }
    });

    it('restarts the AppInbox group operation and denies a retry after authority changes', async () => {
        const nowEpochMs = Date.now();
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const attempts: Array<Readonly<{
            attempt: number;
            outcome: 'conflict' | 'denied';
            authorized: boolean;
        }>> = [];
        let authorized = true;
        const phaseService = {
            prepareMutation: vi.fn(async () => ({
                authorityProof: {
                    version: 1,
                    principalId: 'owner',
                    sessionId: 'owner-session',
                    sessionIssuedAtEpochMs: nowEpochMs - 1_000,
                    sessionExpiresAtEpochMs: nowEpochMs + 60_000,
                    commandMac: 'a'.repeat(64),
                },
                descriptor: {
                    operation: 'updateGroup',
                    scope: SCOPE,
                    groupId: 'outer-retry-room',
                    targetPrincipalId: null,
                    sessionId: null,
                    request: {
                        displayName: 'Must Not Apply',
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId: 'outer-retry-authority-change',
                    },
                },
                command: {
                    operation: 'updateGroup',
                    aggregateRef: { ...SCOPE, groupId: 'outer-retry-room' },
                    commandId: 'outer-retry-authority-change',
                    requestId: 'outer-retry-authority-change',
                    input: {},
                },
                facts: {
                    nowEpochMs,
                    expireAtEpochMs: nowEpochMs + 60_000,
                    serviceId: 'server-12345678',
                    eventId: 'outer-retry-event',
                    commandHash: `sha256:${'a'.repeat(64)}`,
                    resolvedJoinCode: null,
                    joinCodeVerifier: null,
                    internalAuthority: 'none',
                    authenticatedAuthority: {
                        principalId: 'owner',
                        sessionId: 'owner-session',
                    },
                },
                causalToken: 'causal-token',
                queueResourceId: 'outer-retry-authority-change',
            })),
            read: vi.fn(async (command: Readonly<{ facts: { attemptCount: number } }>) => ({
                authorized,
                command,
            })),
            compute: vi.fn((_command, read) => ({
                outcome: 'write',
                receipt: { commandId: 'outer-retry-authority-change' },
                read,
            })),
            validate: vi.fn((_command, _read, computed) => {
                if (!computed.read.authorized) {
                    attempts.push({
                        attempt: computed.read.command.facts.attemptCount,
                        outcome: 'denied',
                        authorized: false,
                    });
                    throw new GroupMutationAuthorizationError(
                        'Authenticated session changed before retry.',
                    );
                }
            }),
            write: vi.fn(async (_transaction, computed) => {
                const attempt = computed.read.command.facts.attemptCount as number;
                attempts.push({ attempt, outcome: 'conflict', authorized: true });
                authorized = false;
                throw new RuntimeStateWriteConflictError();
            }),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
            phaseService as never,
            'server-12345678',
        );
        const authority = authSession(
            'owner',
            'owner-session',
            'owner-token',
            nowEpochMs,
        );
        const pending = authenticatedProcessor<GroupUpdateAppInboxPayload, GroupStateWritten>(
            service,
        )({
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'outer-retry-authority-change',
            contextId: 'ar-eye-hunter:default:outer-retry-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'outer-retry-room',
                request: {
                    displayName: 'Must Not Apply',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'outer-retry-authority-change',
                },
            },
        }, authority);

        await waitForQueueEntry(queue);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await new Promise((resolve) => setTimeout(resolve, 5));
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect((await pending).left).toContain('Forbidden:');
        expect(attempts).toEqual([
            { attempt: 1, outcome: 'conflict', authorized: true },
            { attempt: 2, outcome: 'denied', authorized: false },
        ]);
        expect(phaseService.read).toHaveBeenCalledTimes(2);
        expect(phaseService.compute).toHaveBeenCalledTimes(2);
        expect(phaseService.validate).toHaveBeenCalledTimes(2);
        expect(phaseService.write).toHaveBeenCalledTimes(1);
    });

    it('fails closed before a direct user mutation can read or write without authority', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'direct-missing-authority', 'Before');

        expect(Reflect.get(harness.groupStateService, 'updateGroup')).toBeUndefined();

        expect((await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'direct-missing-authority',
        }))?.group.displayName).toBe('Before');
    });

    it('rejects a raw user inbox call without authority before enqueue', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const input: AppInboxEnqueueInput<GroupCreateAppInboxPayload> = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'raw-missing-authority',
            contextId: 'ar-eye-hunter:default:raw-missing-authority',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'raw-missing-authority',
                    displayName: 'Must Not Exist',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'raw-missing-authority',
                },
            },
        };

        await expect(Reflect.apply(
            harness.service.processEntryUntilCompletion,
            harness.service,
            [input],
        )).rejects.toMatchObject({ status: 403 });

        expect(await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'raw-missing-authority',
        })).toBeUndefined();
        expect([...harness.queueEntries()].filter((entry) =>
            entry.status === EntityStatus.NEW
        )).toHaveLength(0);
    });

    it('rejects a dequeued user command whose authority proof has extra fields', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const input: AppInboxEnqueueInput<GroupCreateAppInboxPayload> = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'raw-extra-proof',
            contextId: 'ar-eye-hunter:default:raw-extra-proof',
            senderId: 'owner',
            authority: {
                version: 1,
                principalId: 'owner',
                sessionId: 'owner-session',
                sessionIssuedAtEpochMs: harness.sessions.owner.issuedAtEpochMs,
                sessionExpiresAtEpochMs: harness.sessions.owner.expiresAtEpochMs,
                commandMac: '0'.repeat(64),
                internalAuthority: 'expiry',
            },
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'raw-extra-proof',
                    displayName: 'Must Not Exist',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'raw-extra-proof',
                },
            },
        };

        const pending = AppInboxService.prototype.processEntryUntilCompletion.call(
            harness.service,
            input,
        );
        await waitForQueueEntry(harness.queue);
        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect((await pending).left).toContain('durable group mutation facts are malformed');
        expect(await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'raw-extra-proof',
        })).toBeUndefined();
    });

    it('rejects legacy maintenance inbox types and exposes no maintenance method', async () => {
        const harness = await createAuthorityHarness(['owner']);
        expect(Reflect.get(harness.groupStateService, 'expireExpiredPresenceSessions'))
            .toBeUndefined();
        expect(Reflect.get(
            harness.groupStateService,
            'disconnectPresenceSessionsBySessionIdWritten',
        )).toBeUndefined();

        await expect(Reflect.apply(
            harness.service.processEntryUntilCompletion,
            harness.service,
            [{
                type: 'GROUP_EXPIRED_PRESENCE_SESSIONS',
                resourceId: 'raw-expiry',
                contextId: 'raw-expiry',
                senderId: 'attacker',
                data: { atEpochMs: harness.nowEpochMs },
            }],
        )).rejects.toMatchObject({ status: 403 });
        expect([...harness.queueEntries()].filter((entry) =>
            entry.status === EntityStatus.NEW
        )).toHaveLength(0);
    });

    it('rejects an attacker bearer that claims the owner actor', async () => {
        const nowEpochMs = Date.now();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authSessions = new AuthSessionRepository(runtimeRepository);
        const owner = authSession('owner', 'owner-session', 'owner-token', nowEpochMs);
        const attacker = authSession(
            'attacker',
            'attacker-session',
            'attacker-token',
            nowEpochMs,
        );
        await authSessions.putSession(owner);
        await authSessions.putSession(attacker);

        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const groupStateService = createGroupStateService({
            runtimeRepository,
            serviceId: 'server-12345678',
            now: () => nowEpochMs,
            authSessionRepository: authSessions,
        } as Parameters<typeof createGroupStateService>[0] & Readonly<{
            authSessionRepository: AuthSessionRepository;
        }>);
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results, { runtimeRepository }),
            groupStateService,
            'server-12345678',
        );

        const created = await processAuthenticated<
            GroupCreateAppInboxPayload,
            GroupStateWritten
        >(service, reader, owner, {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'create-authority-room',
            contextId: 'ar-eye-hunter:default:authority-room',
            senderId: owner.clientId,
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'authority-room',
                    displayName: 'Authority Room',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: owner.clientId,
                    actorPrincipalId: owner.clientId,
                    actorSessionId: owner.sessionId,
                    requestId: 'create-authority-room',
                },
            },
        });
        expect(created.right?.status).toBe('created');

        await expect(processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(service, reader, attacker, {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'forged-owner-update',
            contextId: 'ar-eye-hunter:default:authority-room',
            senderId: attacker.clientId,
            data: {
                scope: SCOPE,
                groupId: 'authority-room',
                request: {
                    displayName: 'Forged Name',
                    actorPrincipalId: owner.clientId,
                    actorSessionId: owner.sessionId,
                    requestId: 'forged-owner-update',
                },
            },
        })).rejects.toMatchObject({ status: 403 });
        const repository = new GroupStateRepository(runtimeRepository);
        const snapshot = await repository.readSnapshot({
            ...SCOPE,
            groupId: 'authority-room',
        });
        expect(snapshot?.group.displayName).toBe('Authority Room');
    });

    it('rejects a direct raw-service attacker that claims the owner actor', async () => {
        const harness = await createAuthorityHarness(['owner', 'attacker']);
        await createRoom(harness, 'raw-authority-room', 'Raw Authority Room');

        expect(Reflect.get(harness.groupStateService, 'updateGroup')).toBeUndefined();

        const snapshot = await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'raw-authority-room',
        });
        expect(snapshot?.group.displayName).toBe('Raw Authority Room');
        expect(await harness.repository.listEvents({
            ...SCOPE,
            groupId: 'raw-authority-room',
        })).toHaveLength(1);
    });

    it('rejects an attacker bearer mutating another principal presence session', async () => {
        const harness = await createAuthorityHarness(['owner', 'victim', 'attacker']);
        await createRoom(harness, 'presence-authority-room', 'Presence Authority Room');
        await processAuthenticated<
            GroupMemberUpsertAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, {
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: 'activate-victim',
            contextId: 'ar-eye-hunter:default:presence-authority-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'presence-authority-room',
                principalId: 'victim',
                request: {
                    status: 'active',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'activate-victim',
                },
            },
        });
        await processAuthenticated<
            GroupPresenceConnectAppInboxPayload,
            GroupMutationReceipt
        >(harness.service, harness.reader, harness.sessions.victim, {
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: 'connect-victim',
            contextId: 'ar-eye-hunter:default:presence-authority-room',
            senderId: 'victim',
            data: {
                scope: SCOPE,
                groupId: 'presence-authority-room',
                sessionId: 'victim-session',
                request: {
                    principalId: 'victim',
                    generationId: 'victim-generation',
                    connectedAtEpochMs: harness.nowEpochMs,
                    lastHeartbeatAtEpochMs: harness.nowEpochMs,
                    expiresAtEpochMs: harness.nowEpochMs + 60_000,
                    actorPrincipalId: 'victim',
                    actorSessionId: 'victim-session',
                    requestId: 'connect-victim',
                },
            },
        });

        await expect(processAuthenticated<
            GroupPresenceHeartbeatAppInboxPayload,
            GroupMutationReceipt
        >(harness.service, harness.reader, harness.sessions.attacker, {
            type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            resourceId: 'forged-victim-heartbeat',
            contextId: 'ar-eye-hunter:default:presence-authority-room',
            senderId: 'attacker',
            data: {
                scope: SCOPE,
                groupId: 'presence-authority-room',
                sessionId: 'victim-session',
                request: {
                    principalId: 'victim',
                    generationId: 'victim-generation',
                    lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000,
                    expiresAtEpochMs: harness.nowEpochMs + 61_000,
                    actorPrincipalId: 'victim',
                    actorSessionId: 'victim-session',
                    requestId: 'forged-victim-heartbeat',
                },
            },
        })).rejects.toMatchObject({ status: 403 });
        expect(await harness.repository.findPresenceSession({
            ...SCOPE,
            groupId: 'presence-authority-room',
            sessionId: 'victim-session',
        })).toMatchObject({
            lastHeartbeatAtEpochMs: harness.nowEpochMs,
            expiresAtEpochMs: harness.nowEpochMs + 60_000,
        });
    });

    it('re-evaluates the exact denied request after the actor is promoted', async () => {
        const harness = await createAuthorityHarness(['owner', 'member']);
        await createRoom(harness, 'causal-denial-room', 'Causal Denial Room');
        await processAuthenticated<
            GroupMemberUpsertAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, {
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: 'activate-member',
            contextId: 'ar-eye-hunter:default:causal-denial-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'causal-denial-room',
                principalId: 'member',
                request: {
                    status: 'active',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'activate-member',
                },
            },
        });
        const updateInput: AppInboxEnqueueInput<GroupUpdateAppInboxPayload> = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'member-update-after-promotion',
            contextId: 'ar-eye-hunter:default:causal-denial-room',
            senderId: 'member',
            data: {
                scope: SCOPE,
                groupId: 'causal-denial-room',
                request: {
                    displayName: 'Member Updated Room',
                    actorPrincipalId: 'member',
                    actorSessionId: 'member-session',
                    requestId: 'member-update-after-promotion',
                },
            },
        };
        const denied = await processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.member, updateInput);
        expect(denied.left).toContain('Forbidden:');

        await processAuthenticated<
            GroupMemberRoleSetAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, {
            type: AppInboxType.GROUP_MEMBER_ROLE_SET,
            resourceId: 'promote-member',
            contextId: 'ar-eye-hunter:default:causal-denial-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'causal-denial-room',
                principalId: 'member',
                request: {
                    role: 'admin',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'promote-member',
                },
            },
        });

        const retried = await processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.member, updateInput);
        expect(retried.right?.result.right?.snapshot.group.displayName).toBe(
            'Member Updated Room',
        );
        expect((await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'causal-denial-room',
        }))?.group.displayName).toBe('Member Updated Room');
    });

    it('re-evaluates the exact no-op request after relevant state changes', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'causal-noop-room', 'Target Name');
        const targetInput: AppInboxEnqueueInput<GroupUpdateAppInboxPayload> = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'restore-target-name',
            contextId: 'ar-eye-hunter:default:causal-noop-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'causal-noop-room',
                request: {
                    displayName: 'Target Name',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'restore-target-name',
                },
            },
        };
        const initialNoOp = await processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, targetInput);
        expect(initialNoOp.right?.result.right?.event).toBeNull();

        await processAuthenticated<GroupUpdateAppInboxPayload, GroupStateWritten>(
            harness.service,
            harness.reader,
            harness.sessions.owner,
            {
                ...targetInput,
                resourceId: 'change-away-from-target',
                data: {
                    ...targetInput.data,
                    request: {
                        ...targetInput.data.request,
                        displayName: 'Changed Name',
                        requestId: 'change-away-from-target',
                    },
                },
            },
        );

        const retried = await processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, targetInput);
        expect(retried.right?.result.right?.event?.eventType).toBe('group-updated');
        expect((await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'causal-noop-room',
        }))?.group.displayName).toBe('Target Name');
    });

    it('rechecks a revoked session before replaying a completed queue result', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'revoked-replay-room', 'Before Replay');
        const input: AppInboxEnqueueInput<GroupUpdateAppInboxPayload> = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'revoked-session-update',
            contextId: 'ar-eye-hunter:default:revoked-replay-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'revoked-replay-room',
                request: {
                    displayName: 'After Replay',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'revoked-session-update',
                },
            },
        };
        const first = await processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, input);
        expect(first.right?.status).toBe('ok');

        await harness.authSessions.deleteSession(harness.sessions.owner);

        await expect(processAuthenticated<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service, harness.reader, harness.sessions.owner, input))
            .rejects.toMatchObject({ status: 403 });
        expect(await harness.repository.listEvents({
            ...SCOPE,
            groupId: 'revoked-replay-room',
        })).toHaveLength(2);
    });

    it('queues a verifiable authority proof without serializing the bearer token', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'proof-wire-room', 'Before Wire Proof');
        const input: AppInboxEnqueueInput<GroupUpdateAppInboxPayload> = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'proof-wire-update',
            contextId: 'ar-eye-hunter:default:proof-wire-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'proof-wire-room',
                request: {
                    displayName: 'After Wire Proof',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'proof-wire-update',
                },
            },
        };
        const pending = authenticatedProcessor<GroupUpdateAppInboxPayload, GroupStateWritten>(
            harness.service,
        )(input, harness.sessions.owner);
        await waitForQueueEntry(harness.queue);
        const queuedWire = JSON.stringify([
            ...(harness.queue as unknown as { data: Map<string, ResourceEntry> }).data.values(),
        ]);
        expect(queuedWire).not.toContain(harness.sessions.owner.accessToken);
        expect(queuedWire).toContain('authority');
        expect(queuedWire).toContain('commandMac');

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect((await pending).right?.status).toBe('ok');
    });

    it('rechecks authority after dequeue and rejects a session revoked while queued', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'queued-revocation-room', 'Before Revocation');
        const input: AppInboxEnqueueInput<GroupUpdateAppInboxPayload> = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'queued-revocation-update',
            contextId: 'ar-eye-hunter:default:queued-revocation-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'queued-revocation-room',
                request: {
                    displayName: 'Must Not Apply',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'queued-revocation-update',
                },
            },
        };
        const pending = authenticatedProcessor<GroupUpdateAppInboxPayload, GroupStateWritten>(
            harness.service,
        )(input, harness.sessions.owner);
        await waitForQueueEntry(harness.queue);
        await harness.authSessions.deleteSession(harness.sessions.owner);

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect((await pending).left).toContain('Forbidden:');
        expect((await harness.repository.readSnapshot({
            ...SCOPE,
            groupId: 'queued-revocation-room',
        }))?.group.displayName).toBe('Before Revocation');
        expect(await harness.repository.listEvents({
            ...SCOPE,
            groupId: 'queued-revocation-room',
        })).toHaveLength(1);
    });

    it('coalesces concurrent identical effectful requests at the same causal state', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'coalesced-room', 'Before Coalescing');
        const input: AppInboxEnqueueInput<GroupUpdateAppInboxPayload> = {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'coalesced-update',
            contextId: 'ar-eye-hunter:default:coalesced-room',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'coalesced-room',
                request: {
                    displayName: 'After Coalescing',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'coalesced-update',
                },
            },
        };
        const process = authenticatedProcessor<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(harness.service);
        const first = process(input, harness.sessions.owner);
        const second = process(input, harness.sessions.owner);
        await waitForQueueEntry(harness.queue);
        const newEntries = [
            ...(harness.queue as unknown as { data: Map<string, ResourceEntry> }).data.values(),
        ].filter((entry) => entry.status === EntityStatus.NEW);
        expect(newEntries).toHaveLength(1);

        await harness.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.right?.status).toBe('ok');
        expect(secondResult.right?.status).toBe('ok');
        expect(await harness.repository.listEvents({
            ...SCOPE,
            groupId: 'coalesced-room',
        })).toHaveLength(2);
    });

    it('advertises every authenticated group operation covered by the real handler matrix', () => {
        expect(Reflect.get(AppGroupInboxModule, 'AUTHENTICATED_GROUP_INBOX_TYPES')).toEqual([
            AppInboxType.GROUP_CREATE,
            AppInboxType.GROUP_UPDATE,
            AppInboxType.GROUP_DIRECTOR_APPOINT,
            AppInboxType.GROUP_JOIN,
            AppInboxType.GROUP_INVITE_CREATE,
            AppInboxType.GROUP_INVITE_REVOKE,
            AppInboxType.GROUP_INVITE_ACCEPT,
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
        ]);
    });

    it('runs every advertised group operation through real AppGroup phases and one transaction', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob', 'charlie']);
        const read = vi.spyOn(harness.groupStateService, 'read');
        const compute = vi.spyOn(harness.groupStateService, 'compute');
        const validate = vi.spyOn(harness.groupStateService, 'validate');
        const write = vi.spyOn(harness.groupStateService, 'write');
        const observeSnapshot = vi.spyOn(
            harness.groupStateService as GroupStateService & Readonly<{
                observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
            }>,
            'observeSnapshot',
        );
        const authorityRead = vi.spyOn(harness.authSessions, 'findBySessionId');
        const groupId = 'operation-matrix-room';
        const ownerActor = {
            actorPrincipalId: 'owner',
            actorSessionId: 'owner-session',
        } as const;
        const bobActor = {
            actorPrincipalId: 'bob',
            actorSessionId: 'bob-session',
        } as const;
        const charlieActor = {
            actorPrincipalId: 'charlie',
            actorSessionId: 'charlie-session',
        } as const;
        const cases: readonly Readonly<{
            type: AppInboxType;
            operation: string;
            authority: IssuedAuthSession;
            data: unknown;
            assertDomain(): Promise<void>;
        }>[] = [
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
                        requestId: 'matrix-create',
                    },
                } satisfies GroupCreateAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.group.displayName).toBe('Operation Matrix');
                },
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
                        requestId: 'matrix-update',
                    },
                } satisfies GroupUpdateAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.group.description).toBe('Updated through AppGroup');
                },
            },
            {
                type: AppInboxType.GROUP_JOIN,
                operation: 'joinGroup',
                authority: harness.sessions.bob,
                data: {
                    scope: SCOPE,
                    groupId,
                    request: { ...bobActor, requestId: 'matrix-join-bob' },
                } satisfies GroupJoinAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'bob'))
                        .toMatchObject({ status: 'active', role: 'member' });
                },
            },
            inviteCase('matrix-invite-charlie', async () => {
                expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                    ?.members.find((member) => member.principalId === 'charlie'))
                    .toMatchObject({ status: 'invited', invitedByPrincipalId: 'owner' });
            }),
            {
                type: AppInboxType.GROUP_INVITE_REVOKE,
                operation: 'revokeGroupInvite',
                authority: harness.sessions.owner,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'charlie',
                    request: { ...ownerActor, requestId: 'matrix-revoke-charlie' },
                } satisfies GroupInviteRevokeAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'charlie'))
                        .toMatchObject({ status: 'left' });
                },
            },
            inviteCase('matrix-reinvite-charlie', async () => {
                expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                    ?.members.find((member) => member.principalId === 'charlie'))
                    .toMatchObject({ status: 'invited' });
            }),
            {
                type: AppInboxType.GROUP_INVITE_ACCEPT,
                operation: 'acceptGroupInvite',
                authority: harness.sessions.charlie,
                data: {
                    scope: SCOPE,
                    groupId,
                    request: { ...charlieActor, requestId: 'matrix-accept-charlie' },
                } satisfies GroupInviteAcceptAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'charlie'))
                        .toMatchObject({ status: 'active' });
                },
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
                        requestId: 'matrix-rotate-code',
                    },
                } satisfies GroupJoinCodeRotateAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.group.metadata).toHaveProperty('rallarJoinCode');
                },
            },
            {
                type: AppInboxType.GROUP_MEMBER_ROLE_SET,
                operation: 'setGroupMemberRole',
                authority: harness.sessions.owner,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'bob',
                    request: { role: 'admin', ...ownerActor, requestId: 'matrix-role-bob' },
                } satisfies GroupMemberRoleSetAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'bob'))
                        .toMatchObject({ role: 'admin' });
                },
            },
            governedCase(AppInboxType.GROUP_MEMBER_BAN, 'banGroupMember',
                'matrix-ban-charlie', 'banned'),
            governedCase(AppInboxType.GROUP_MEMBER_UNBAN, 'unbanGroupMember',
                'matrix-unban-charlie', 'left'),
            {
                type: AppInboxType.GROUP_MEMBER_UPSERT,
                operation: 'upsertMember',
                authority: harness.sessions.owner,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'charlie',
                    request: { status: 'active', ...ownerActor, requestId: 'matrix-upsert' },
                } satisfies GroupMemberUpsertAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'charlie'))
                        .toMatchObject({ status: 'active' });
                },
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
                        requestId: 'matrix-transfer',
                    },
                } satisfies GroupOwnershipTransferAppInboxPayload,
                assertDomain: async () => {
                    const members = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members;
                    expect(members?.find((member) => member.principalId === 'owner')?.role)
                        .toBe('admin');
                    expect(members?.find((member) => member.principalId === 'bob')?.role)
                        .toBe('owner');
                },
            },
            {
                type: AppInboxType.GROUP_MEMBER_REMOVE,
                operation: 'removeGroupMember',
                authority: harness.sessions.bob,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'charlie',
                    request: { ...bobActor, requestId: 'matrix-remove-charlie' },
                } satisfies GroupMemberRemoveAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'charlie'))
                        .toMatchObject({ status: 'removed' });
                },
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
                        requestId: 'matrix-connect',
                    },
                } satisfies GroupPresenceConnectAppInboxPayload,
                assertDomain: async () => {
                    expect(await harness.repository.findPresenceSession({
                        ...SCOPE,
                        groupId,
                        sessionId: 'bob-session',
                    })).toMatchObject({ generationId: 'matrix-generation', status: 'active' });
                },
            },
            {
                type: AppInboxType.GROUP_DIRECTOR_APPOINT,
                operation: 'appointDirector',
                authority: harness.sessions.bob,
                data: {
                    scope: SCOPE,
                    groupId,
                    request: { ...bobActor, requestId: 'matrix-director' },
                } satisfies GroupDirectorAppointAppInboxPayload,
                assertDomain: async () => {
                    const snapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
                    expect(snapshot?.group.metadata).toHaveProperty('rallarDirector');
                },
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
                        requestId: 'matrix-heartbeat',
                    },
                } satisfies GroupPresenceHeartbeatAppInboxPayload,
                assertDomain: async () => {
                    expect(await harness.repository.findPresenceSession({
                        ...SCOPE,
                        groupId,
                        sessionId: 'bob-session',
                    })).toMatchObject({ lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000 });
                },
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
                        requestId: 'matrix-disconnect',
                    },
                } satisfies GroupPresenceDisconnectAppInboxPayload,
                assertDomain: async () => {
                    expect(await harness.repository.findPresenceSession({
                        ...SCOPE,
                        groupId,
                        sessionId: 'bob-session',
                    })).toMatchObject({ status: 'disconnected' });
                },
            },
        ];

        function inviteCase(
            requestId: string,
            assertDomain: () => Promise<void>,
        ) {
            return {
                type: AppInboxType.GROUP_INVITE_CREATE,
                operation: 'createGroupInvite',
                authority: harness.sessions.owner,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'charlie',
                    request: {
                        invitationExpiresAtEpochMs: harness.nowEpochMs + 60_000,
                        ...ownerActor,
                        requestId,
                    },
                } satisfies GroupInviteCreateAppInboxPayload,
                assertDomain,
            } as const;
        }

        function governedCase(
            type: AppInboxType.GROUP_MEMBER_BAN | AppInboxType.GROUP_MEMBER_UNBAN,
            operation: 'banGroupMember' | 'unbanGroupMember',
            requestId: string,
            status: 'banned' | 'left',
        ) {
            return {
                type,
                operation,
                authority: harness.sessions.owner,
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'charlie',
                    request: { ...ownerActor, requestId },
                } satisfies GroupMemberBanAppInboxPayload | GroupMemberUnbanAppInboxPayload,
                assertDomain: async () => {
                    expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))
                        ?.members.find((member) => member.principalId === 'charlie'))
                        .toMatchObject({ status });
                },
            } as const;
        }

        for (const testCase of cases) {
            read.mockClear();
            compute.mockClear();
            validate.mockClear();
            write.mockClear();
            authorityRead.mockClear();
            const previousOutboxCount = harness.database.outboxEntries.size;
            const requestId = (testCase.data as { request: { requestId: string } })
                .request.requestId;
            const result = await processAuthenticated(
                harness.service,
                harness.reader,
                testCase.authority,
                {
                    type: testCase.type,
                    resourceId: requestId,
                    contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
                    senderId: testCase.authority.clientId,
                    data: testCase.data,
                },
            );

            expect(result.right, `${testCase.operation} result`).toBeDefined();
            expect(read).toHaveBeenCalledOnce();
            expect(compute).toHaveBeenCalledOnce();
            expect(validate).toHaveBeenCalledOnce();
            expect(write).toHaveBeenCalledOnce();
            expect(authorityRead).toHaveBeenCalled();
            const command = read.mock.calls[0]?.[0];
            expect(command?.command.operation).toBe(testCase.operation);
            expect(command?.facts).toMatchObject({
                attemptCount: 1,
                serviceId: 'server-12345678',
                internalAuthority: 'none',
                authenticatedAuthority: {
                    principalId: testCase.authority.clientId,
                    sessionId: testCase.authority.sessionId,
                },
            });
            expect(command?.facts.eventId).toMatch(/^group-event:/u);
            expect(command?.facts.commandHash).toMatch(/^sha256:/u);
            expect(harness.database.outboxEntries.size).toBe(previousOutboxCount + 1);
            expect(harness.queueEntries().some((entry) =>
                entry.status === EntityStatus.COMPLETED &&
                entry.dequeueAudit.attempts === 1
            )).toBe(true);
            await testCase.assertDomain();
        }
        await vi.waitFor(() =>
            expect(observeSnapshot).toHaveBeenCalledTimes(cases.length)
        );
    }, 30_000);
});

type AuthorityHarness = Readonly<{
    nowEpochMs: number;
    runtimeRepository: FakeRuntimeStateRepository;
    repository: GroupStateRepository;
    authSessions: AuthSessionRepository;
    groupStateService: GroupStateService;
    service: AppGroupInboxService;
    database: AppInboxTestDatabase;
    reader: InboxQueueReader;
    queue: TestResourceInbox;
    sessions: Readonly<Record<string, IssuedAuthSession>>;
    queueEntries(): readonly ResourceEntry[];
}>;

async function createAuthorityHarness(
    principalIds: readonly string[],
): Promise<AuthorityHarness> {
    const nowEpochMs = Date.now();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const sessions = Object.fromEntries(principalIds.map((principalId) => [
        principalId,
        authSession(
            principalId,
            `${principalId}-session`,
            `${principalId}-token`,
            nowEpochMs,
        ),
    ]));
    for (const session of Object.values(sessions)) {
        await authSessions.putSession(session);
    }
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const groupStateService = createGroupStateService({
        runtimeRepository,
        createGroupStateEventStore: () => database.groupEventStore,
        serviceId: 'server-12345678',
        now: () => nowEpochMs,
        authSessionRepository: authSessions,
    } as Parameters<typeof createGroupStateService>[0] & Readonly<{
        authSessionRepository: AuthSessionRepository;
    }>);
    return {
        nowEpochMs,
        runtimeRepository,
        repository: new GroupStateRepository(runtimeRepository, {
            events: database.groupEventStore,
        }),
        authSessions,
        groupStateService,
        service: new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            database,
            groupStateService,
            'server-12345678',
        ),
        database,
        reader,
        queue,
        sessions,
        queueEntries: () => [
            ...(queue as unknown as { data: Map<string, ResourceEntry> }).data.values(),
        ],
    };
}

async function createRoom(
    harness: AuthorityHarness,
    groupId: string,
    displayName: string,
): Promise<void> {
    const owner = harness.sessions.owner;
    const created = await processAuthenticated<
        GroupCreateAppInboxPayload,
        GroupStateWritten
    >(harness.service, harness.reader, owner, {
        type: AppInboxType.GROUP_CREATE,
        resourceId: `create-${groupId}`,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: owner.clientId,
        data: {
            scope: SCOPE,
            request: {
                groupId,
                displayName,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: owner.clientId,
                actorPrincipalId: owner.clientId,
                actorSessionId: owner.sessionId,
                requestId: `create-${groupId}`,
            },
        },
    });
    expect(created.right?.status).toBe('created');
}

async function processAuthenticated<V, R>(
    service: AppGroupInboxService,
    reader: InboxQueueReader,
    authority: IssuedAuthSession,
    input: AppInboxEnqueueInput<V>,
): Promise<Either<string, R>> {
    const pending = authenticatedProcessor<V, R>(service)(input, authority);
    const outcome = await Promise.race([
        pending.then(() => 'settled' as const, () => 'settled' as const),
        waitForQueueEntry(reader.inbox as unknown as InMemoryQueueBox)
            .then(() => 'queued' as const),
    ]);
    if (outcome === 'queued') {
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
    }
    return await pending;
}

function authenticatedProcessor<V, R>(
    service: AppGroupInboxService,
): (
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession,
) => Promise<Either<string, R>> {
    return service.processAuthenticatedEntryUntilCompletion.bind(service) as unknown as (
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ) => Promise<Either<string, R>>;
}

async function waitForQueueEntry(queue: InMemoryQueueBox): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const data = (queue as unknown as {
            data: Map<string, ResourceEntry>;
        }).data;
        if (data.size > 0 && [...data.values()].some((entry) =>
            entry.status === EntityStatus.NEW
        )) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected authenticated app inbox entry to be enqueued');
}

function authSession(
    clientId: string,
    sessionId: string,
    accessToken: string,
    nowEpochMs: number,
): IssuedAuthSession {
    return {
        clientId,
        sessionId,
        accessToken,
        username: clientId,
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60_000,
    };
}

class TestResourceInbox extends InMemoryQueueBox {
    async isEntryWithStatus(
        key: Key,
        statuses: EntityStatus[],
    ): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return entry === undefined || isExpiredResourceEntry(entry)
            ? undefined
            : entry;
    }
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}
