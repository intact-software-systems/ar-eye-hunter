import { DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS } from '@shared/api/group-director.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from '../../app-inbox-test-database.ts';

import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { AppGroupInboxService, AppInboxType } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';

import { AppInboxIdempotencyConflictError } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { GroupMutationAuthorizationError, type GroupStateWritten } from '@shared-server/rallar-system/services/group-state-service.ts';

import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { authSession } from '../group-state-test-runtime.ts';
import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    listRoomEvents,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    TestResourceInbox,
    TestResourceInboxResults,
    waitForQueueEntry,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

interface RetryAttempt {
    readonly attempt: number;
    readonly outcome: 'conflict' | 'denied';
    readonly authorized: boolean;
}

describe('AppGroupInboxService authenticated authority', { timeout: 30_000 }, () => {
    it(
        'restarts the AppInbox group operation ' + 'and denies a retry after authority changes',
        async () => {
            const nowEpochMs = Date.now();
            const queue = new TestResourceInbox();
            const reader = new InboxQueueReader(queue);
            const results = new TestResourceInboxResults();
            const attempts: RetryAttempt[] = [];
            let authorized = true;
            const authorizedMutation = {
                authorityProof: {
                    version: 1 as const,
                    principalId: 'owner',
                    sessionId: 'owner-session',
                    sessionIssuedAtEpochMs: nowEpochMs - 1_000,
                    sessionExpiresAtEpochMs: nowEpochMs + 60_000,
                    commandMac: 'a'.repeat(64)
                },
                descriptor: {
                    operation: 'updateGroup' as const,
                    scope: SCOPE,
                    groupId: 'outer-retry-room',
                    targetPrincipalId: null,
                    sessionId: null,
                    request: {
                        displayName: 'Must Not Apply',
                        actorPrincipalId: 'owner',
                        actorSessionId: 'owner-session',
                        requestId: 'outer-retry-authority-change'
                    }
                }
            };
            const phaseService = {
                authorizeMutation: vi.fn(async () => authorizedMutation),
                prepareAppInboxMutation: vi.fn(async () => ({
                    ...authorizedMutation,
                    command: {
                        operation: 'updateGroup',
                        aggregateRef: { ...SCOPE, groupId: 'outer-retry-room' },
                        commandId: 'outer-retry-authority-change',
                        requestId: 'outer-retry-authority-change',
                        input: {}
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
                        formationDamping: 'legacy',
                        authenticatedAuthority: {
                            principalId: 'owner',
                            sessionId: 'owner-session'
                        }
                    },
                    causalToken: 'causal-token',
                    queueResourceId: 'outer-retry-authority-change'
                })),
                read: vi.fn(async (command: Readonly<{ facts: { attemptCount: number; }; }>) => ({
                    authorized,
                    command
                })),
                compute: vi.fn((_command, read) => ({
                    outcome: 'write',
                    receipt: { commandId: 'outer-retry-authority-change' },
                    read
                })),
                validate: vi.fn((_command, _read, computed) => {
                    if (!computed.read.authorized) {
                        attempts.push({
                            attempt: computed.read.command.facts.attemptCount,
                            outcome: 'denied',
                            authorized: false
                        });
                        throw new GroupMutationAuthorizationError(
                            'Authenticated session changed before retry.'
                        );
                    }
                }),
                write: vi.fn(async (_transaction, computed) => {
                    const attempt = computed.read.command.facts.attemptCount as number;
                    attempts.push({ attempt, outcome: 'conflict', authorized: true });
                    authorized = false;
                    throw new RuntimeStateWriteConflictError();
                })
            };
            const service = new AppGroupInboxService(
                {
                    inboxQueueReader: reader,
                    resourceInboxRepository: queue,
                    resourceInboxResultsRepository: results,
                    database: createAppInboxTestDatabase(queue, results),
                    groupStateService: phaseService as never
                },
                {
                    serviceId: 'server-12345678'
                }
            );
            const authority = authSession({
                clientId: 'owner',
                sessionId: 'owner-session',
                accessToken: 'owner-token',
                nowEpochMs
            });
            const pending = service.processAuthenticatedGroupEntryUntilCompletion(
                {
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
                            requestId: 'outer-retry-authority-change'
                        }
                    }
                },
                authority
            );

            await waitForQueueEntry(queue);
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            await new Promise((resolve) => setTimeout(resolve, 5));
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

            expect((await pending).left).toContain('Forbidden:');
            expect(attempts).toEqual([
                { attempt: 1, outcome: 'conflict', authorized: true },
                { attempt: 2, outcome: 'denied', authorized: false }
            ]);
            expect(phaseService.read).toHaveBeenCalledTimes(2);
            expect(phaseService.compute).toHaveBeenCalledTimes(2);
            expect(phaseService.validate).toHaveBeenCalledTimes(2);
            expect(phaseService.write).toHaveBeenCalledTimes(1);
        }
    );

    it('replays the exact denied result after the actor is promoted', async () => {
        const harness = await createAuthorityHarness(['owner', 'member']);
        await createRoom(harness, 'causal-denial-room', 'Causal Denial Room');
        await processAs(harness, 'owner', {
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
                    requestId: 'activate-member'
                }
            }
        });
        const updateInput: AuthenticatedGroupMutationEnqueue = {
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
                    requestId: 'member-update-after-promotion'
                }
            }
        };
        const denied = await processAs(harness, 'member', updateInput);
        expect(denied.left).toContain('Forbidden:');

        await processAs(harness, 'owner', {
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
                    requestId: 'promote-member'
                }
            }
        });

        const replay = await processAs(harness, 'member', updateInput);
        expect(replay).toEqual(denied);
        expect(await readDisplayName(harness, 'causal-denial-room')).toBe('Causal Denial Room');
        expect(await listRoomEvents(harness, 'causal-denial-room')).toHaveLength(3);
    });

    it('replays the exact no-op result after relevant state changes', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'causal-noop-room', 'Target Name');
        const targetInput: AuthenticatedGroupMutationEnqueue = {
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
                    requestId: 'restore-target-name'
                }
            }
        };
        const initialNoOp = await processAs(harness, 'owner', targetInput);
        expect(requireGroupStateResult(initialNoOp).result.right?.event).toBeNull();

        await processAs(harness, 'owner', {
            ...targetInput,
            resourceId: 'change-away-from-target',
            data: {
                ...targetInput.data,
                request: {
                    ...targetInput.data.request,
                    displayName: 'Changed Name',
                    requestId: 'change-away-from-target'
                }
            }
        });

        const retried = await processAs(harness, 'owner', targetInput);
        expect(retried).toEqual(initialNoOp);
        expect(requireGroupStateResult(retried).result.right?.event).toBeNull();
        expect(await readDisplayName(harness, 'causal-noop-room')).toBe('Changed Name');
    });

    it('rechecks a revoked session before replaying a completed queue result', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'revoked-replay-room', 'Before Replay');
        const input: AuthenticatedGroupMutationEnqueue = {
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
                    requestId: 'revoked-session-update'
                }
            }
        };
        const first = await processAs(harness, 'owner', input);
        expect(requireGroupStateResult(first).status).toBe('ok');

        await harness.authSessions.deleteSession(harness.sessions.owner);

        await expect(processAs(harness, 'owner', input)).rejects.toMatchObject({ status: 403 });
        expect(await listRoomEvents(harness, 'revoked-replay-room')).toHaveLength(2);
    });

    it('replays one logical mutation after caller credential renewal', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'renewed-session-room', 'Before Renewal');
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_UPDATE,
            topicId: AppInboxType.GROUP_UPDATE,
            resourceId: 'renewed-session-update',
            contextId: 'application=ar-eye-hunter:workspace=default:group=renewed-session-room:caller=owner',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'renewed-session-room',
                request: {
                    displayName: 'After Renewal',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'renewed-session-update'
                }
            }
        };
        const first = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input
        });
        const renewed = authSession({
            clientId: 'owner',
            sessionId: 'owner-renewed-session',
            accessToken: 'owner-renewed-token',
            nowEpochMs: harness.nowEpochMs
        });
        await harness.authSessions.deleteSession(harness.sessions.owner);
        await harness.authSessions.putSession(renewed);

        const replay = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: renewed,
            input: {
                ...input,
                data: {
                    ...input.data,
                    request: {
                        ...input.data.request,
                        actorSessionId: renewed.sessionId
                    }
                }
            }
        });

        expect(replay).toEqual(first);
        expect(await readDisplayName(harness, 'renewed-session-room')).toBe('After Renewal');
        expect(await listRoomEvents(harness, 'renewed-session-room')).toHaveLength(2);
    });

    it('rechecks authority after dequeue and rejects a session revoked while queued', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, 'queued-revocation-room', 'Before Revocation');
        const input: AuthenticatedGroupMutationEnqueue = {
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
                    requestId: 'queued-revocation-update'
                }
            }
        };
        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        await harness.authSessions.deleteSession(harness.sessions.owner);

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect((await pending).left).toContain('Forbidden:');
        expect(await readDisplayName(harness, 'queued-revocation-room')).toBe('Before Revocation');
        expect(await listRoomEvents(harness, 'queued-revocation-room')).toHaveLength(1);
    });

    it('coalesces concurrent identical effectful requests at the same causal state', async () => {
        const harness = await createAuthorityHarness(['owner'], {
            serviceOptions: {
                waitMaxElapsedMsecs: 25_000,
                waitRetryIntervalMsecs: 10,
                waitMaxRetryIntervalMsecs: 10,
                waitJitterRatio: 0
            }
        });
        await createRoom(harness, 'coalesced-room', 'Before Coalescing');
        const prepareMutation = vi.spyOn(harness.groupStateService, 'prepareAppInboxMutation');
        const input: AuthenticatedGroupMutationEnqueue = {
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
                    requestId: 'coalesced-update'
                }
            }
        };
        const first = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        const second = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        const newEntries = (await harness.queueEntries()).filter(
            (entry) => entry.status === EntityStatus.NEW
        );
        expect(newEntries).toHaveLength(1);
        expect(prepareMutation).not.toHaveBeenCalled();

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(requireGroupStateResult(firstResult).status).toBe('ok');
        expect(requireGroupStateResult(secondResult).status).toBe('ok');
        expect(prepareMutation).toHaveBeenCalledTimes(1);
        expect(await listRoomEvents(harness, 'coalesced-room')).toHaveLength(2);
    });

    it('coalesces domain-default-equivalent intent before materializing facts', async () => {
        const harness = await createAuthorityHarness(['owner'], {
            serviceOptions: {
                waitMaxElapsedMsecs: 25_000,
                waitRetryIntervalMsecs: 10,
                waitMaxRetryIntervalMsecs: 10,
                waitJitterRatio: 0
            }
        });
        await createRoom(harness, 'default-equivalence-room', 'Default Equivalence');
        await processAs(harness, 'owner', {
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: 'default-equivalence-presence',
            contextId: 'default-equivalence-presence-context',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'default-equivalence-room',
                sessionId: 'owner-session',
                request: {
                    generationId: 'default-equivalence-generation',
                    principalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    connectedAtEpochMs: harness.nowEpochMs,
                    lastHeartbeatAtEpochMs: harness.nowEpochMs,
                    expiresAtEpochMs: harness.nowEpochMs + 60_000,
                    requestId: 'default-equivalence-presence'
                }
            }
        });
        const prepareMutation = vi.spyOn(harness.groupStateService, 'prepareAppInboxMutation');
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_DIRECTOR_APPOINT,
            topicId: AppInboxType.GROUP_DIRECTOR_APPOINT,
            resourceId: 'director-default-equivalence',
            contextId: 'application=ar-eye-hunter:workspace=default:group=default-equivalence-room:caller=owner',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'default-equivalence-room',
                request: {
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'director-default-equivalence'
                }
            }
        };
        const omittedDefault = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        const explicitDefault = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            {
                ...input,
                data: {
                    ...input.data,
                    request: {
                        ...input.data.request,
                        heartbeatTtlMs: DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS
                    }
                }
            },
            harness.sessions.owner
        );

        await waitForQueueEntry(harness.queue);
        expect(
            (await harness.queueEntries()).filter((entry) => entry.status === EntityStatus.NEW)
        ).toHaveLength(1);
        expect(prepareMutation).not.toHaveBeenCalled();
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const [omittedResult, explicitResult] = await Promise.all([omittedDefault, explicitDefault]);
        expect(explicitResult).toEqual(omittedResult);
        expect(prepareMutation).toHaveBeenCalledTimes(1);
        expect(await listRoomEvents(harness, 'default-equivalence-room')).toHaveLength(3);
    });

    it('rejects a different contender before the winner materializes facts', async () => {
        const harness = await createAuthorityHarness(['owner'], {
            serviceOptions: {
                waitMaxElapsedMsecs: 25_000,
                waitRetryIntervalMsecs: 10,
                waitMaxRetryIntervalMsecs: 10,
                waitJitterRatio: 0
            }
        });
        await createRoom(harness, 'different-contender-room', 'Before Contention');
        const prepareMutation = vi.spyOn(harness.groupStateService, 'prepareAppInboxMutation');
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_UPDATE,
            topicId: AppInboxType.GROUP_UPDATE,
            resourceId: 'different-contender-update',
            contextId: 'different-contender-context',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId: 'different-contender-room',
                request: {
                    displayName: 'Winning Intent',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'different-contender-update'
                }
            }
        };
        const winner = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            input,
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        const conflict = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            {
                ...input,
                data: {
                    ...input.data,
                    request: { ...input.data.request, displayName: 'Losing Intent' }
                }
            },
            harness.sessions.owner
        );
        const conflictExpectation = expect(conflict).rejects.toBeInstanceOf(
            AppInboxIdempotencyConflictError
        );
        await conflictExpectation;
        expect(prepareMutation).not.toHaveBeenCalled();

        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(requireGroupStateResult(await winner).status).toBe('ok');
        expect(prepareMutation).toHaveBeenCalledTimes(1);
        expect(await readDisplayName(harness, 'different-contender-room')).toBe('Winning Intent');
        expect(await listRoomEvents(harness, 'different-contender-room')).toHaveLength(2);
    });
});

function processAs(
    harness: AuthorityHarness,
    principalId: string,
    input: AuthenticatedGroupMutationEnqueue
) {
    return processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions[principalId],
        input
    });
}

async function readDisplayName(harness: AuthorityHarness, groupId: string) {
    return (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.displayName;
}
