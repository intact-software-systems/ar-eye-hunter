import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from '../../app-inbox-test-database.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  AppGroupInboxService,
  type AppInboxEnqueueInput,
  AppInboxType,
  type GroupMemberRoleSetAppInboxPayload,
  type GroupMemberUpsertAppInboxPayload,
  type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  GroupMutationAuthorizationError,
  type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { authSession } from '../group-state-test-runtime.ts';
import {
  SCOPE,
  type AuthorityHarness,
  TestResourceInbox,
  TestResourceInboxResults,
  createAuthorityHarness,
  createResilience,
  createRoom,
  listRoomEvents,
  processAuthenticated,
  waitForQueueEntry,
} from './group-state-inbox-test-runtime.ts';

interface RetryAttempt {
  readonly attempt: number;
  readonly outcome: 'conflict' | 'denied';
  readonly authorized: boolean;
}

describe('AppGroupInboxService authenticated authority', { timeout: 30_000 }, () => {
  it('restarts the AppInbox group operation and denies a retry after authority changes', async () => {
    const nowEpochMs = Date.now();
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const attempts: RetryAttempt[] = [];
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
          formationDamping: 'legacy',
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
          throw new GroupMutationAuthorizationError('Authenticated session changed before retry.');
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
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database: createAppInboxTestDatabase(queue, results),
        groupStateService: phaseService as never,
      },
      {
        serviceId: 'server-12345678',
      },
    );
    const authority = authSession({
      clientId: 'owner',
      sessionId: 'owner-session',
      accessToken: 'owner-token',
      nowEpochMs,
    });
    const pending = service.processAuthenticatedEntryUntilCompletion<
      GroupUpdateAppInboxPayload,
      GroupStateWritten
    >(
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
            requestId: 'outer-retry-authority-change',
          },
        },
      },
      authority,
    );

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

  it('re-evaluates the exact denied request after the actor is promoted', async () => {
    const harness = await createAuthorityHarness(['owner', 'member']);
    await createRoom(harness, 'causal-denial-room', 'Causal Denial Room');
    await processAs<GroupMemberUpsertAppInboxPayload>(harness, 'owner', {
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
    const denied = await processAs<GroupUpdateAppInboxPayload>(harness, 'member', updateInput);
    expect(denied.left).toContain('Forbidden:');

    await processAs<GroupMemberRoleSetAppInboxPayload>(harness, 'owner', {
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

    const retried = await processAs<GroupUpdateAppInboxPayload>(harness, 'member', updateInput);
    expect(retried.right?.result.right?.snapshot.group.displayName).toBe('Member Updated Room');
    expect(await readDisplayName(harness, 'causal-denial-room')).toBe('Member Updated Room');
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
    const initialNoOp = await processAs<GroupUpdateAppInboxPayload>(harness, 'owner', targetInput);
    expect(initialNoOp.right?.result.right?.event).toBeNull();

    await processAs<GroupUpdateAppInboxPayload>(harness, 'owner', {
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
    });

    const retried = await processAs<GroupUpdateAppInboxPayload>(harness, 'owner', targetInput);
    expect(retried.right?.result.right?.event?.eventType).toBe('group-updated');
    expect(await readDisplayName(harness, 'causal-noop-room')).toBe('Target Name');
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
    const first = await processAs<GroupUpdateAppInboxPayload>(harness, 'owner', input);
    expect(first.right?.status).toBe('ok');

    await harness.authSessions.deleteSession(harness.sessions.owner);

    await expect(
      processAs<GroupUpdateAppInboxPayload>(harness, 'owner', input),
    ).rejects.toMatchObject({ status: 403 });
    expect(await listRoomEvents(harness, 'revoked-replay-room')).toHaveLength(2);
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
    const pending = harness.service.processAuthenticatedEntryUntilCompletion<
      GroupUpdateAppInboxPayload,
      GroupStateWritten
    >(input, harness.sessions.owner);
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
        waitJitterRatio: 0,
      },
    });
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
    const first = harness.service.processAuthenticatedEntryUntilCompletion<
      GroupUpdateAppInboxPayload,
      GroupStateWritten
    >(input, harness.sessions.owner);
    const second = harness.service.processAuthenticatedEntryUntilCompletion<
      GroupUpdateAppInboxPayload,
      GroupStateWritten
    >(input, harness.sessions.owner);
    await waitForQueueEntry(harness.queue);
    const newEntries = (await harness.queueEntries()).filter(
      (entry) => entry.status === EntityStatus.NEW,
    );
    expect(newEntries).toHaveLength(1);

    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.right?.status).toBe('ok');
    expect(secondResult.right?.status).toBe('ok');
    expect(await listRoomEvents(harness, 'coalesced-room')).toHaveLength(2);
  });
});

function processAs<V>(
  harness: AuthorityHarness,
  principalId: string,
  input: AppInboxEnqueueInput<V>,
) {
  return processAuthenticated<V, GroupStateWritten>(
    harness.service,
    harness.reader,
    harness.sessions[principalId],
    input,
  );
}

async function readDisplayName(harness: AuthorityHarness, groupId: string) {
  return (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.displayName;
}
