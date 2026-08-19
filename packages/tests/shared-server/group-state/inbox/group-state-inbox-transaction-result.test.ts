import { describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { GroupStateInboxHandler } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';

import { createGroupStateTransactionBoundaryHarness } from './group-state-transaction-boundary-fixture.ts';

const EXPECTED_CREATE_GROUP_DURABLE_JSON =
  '{"status":"created","result":{"right":{"snapshot":' +
  '{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},' +
  '"group":{"applicationId":"ar-eye-hunter","workspaceId":"default",' +
  '"groupId":"transaction-boundary-room","slug":null,' +
  '"displayName":"Transaction boundary room","description":null,"kind":"room",' +
  '"status":"active","joinMode":"open","maxMembers":null,' +
  '"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,' +
  '"ownerPrincipalId":"owner","snapshotVersion":1,"metadataVersion":1,' +
  '"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1785628800000,' +
  '"actor":{"kind":"session","sessionId":"owner-session","principalId":"owner"},' +
  '"reason":null,"traceId":null,"requestId":"create-transaction-boundary-room"},' +
  '"updated":{"atEpochMs":1785628800000,"actor":{"kind":"session",' +
  '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
  '"traceId":null,"requestId":"create-transaction-boundary-room"},' +
  '"archived":null,"deleted":null,"expiresAtEpochMs":null,' +
  '"emptySinceEpochMs":null,"purgeAfterEpochMs":null,' +
  '"lifecycleState":"active","formationEpoch":0,"formationAttemptCount":0,"lastFormationOutcome":null,"establishmentStartedAtEpochMs":null,"formationElectorate":["owner"]},"members":[' +
  '{"applicationId":"ar-eye-hunter","workspaceId":"default",' +
  '"groupId":"transaction-boundary-room","principalId":"owner","role":"owner",' +
  '"status":"active","joined":{"atEpochMs":1785628800000,' +
  '"actor":{"kind":"session","sessionId":"owner-session","principalId":"owner"},' +
  '"reason":null,"traceId":null,"requestId":"create-transaction-boundary-room"},' +
  '"updated":{"atEpochMs":1785628800000,"actor":{"kind":"session",' +
  '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
  '"traceId":null,"requestId":"create-transaction-boundary-room"},"left":null,' +
  '"removed":null,"banned":null,"invitedByPrincipalId":null,' +
  '"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,' +
  '"onlineMemberCount":0},"event":{"applicationId":"ar-eye-hunter",' +
  '"workspaceId":"default","groupId":"transaction-boundary-room",' +
  '"eventId":"group-event:3e85b5e31f6a320e249e7fd18bf180c7ce3a15825453b7549a25897e91bc41c7",' +
  '"eventType":"group-created","snapshotVersion":1,' +
  '"causalRevision":{"groupRevision":1,"presenceRevision":0},' +
  '"occurredAtEpochMs":1785628800000,"actor":{"kind":"session",' +
  '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
  '"traceId":null,"requestId":"create-transaction-boundary-room","payload":{}}}}}';

describe('group-state AppInbox transaction result boundary', () => {
  it('persists the real durable result before exposing the committed snapshot', async () => {
    const harness = await createGroupStateTransactionBoundaryHarness();

    const created = await harness.handler.processGroupStateMutation(harness.context);
    if (!('status' in created) || created.status !== 'created') {
      throw new TypeError('createGroup must resolve to a created group-state write.');
    }

    const persisted = await harness.results.findByKey(harness.context.entry.key);
    expect(persisted?.status).toBe(EntityStatus.COMPLETED);
    expect(persisted?.resource).toBe(EXPECTED_CREATE_GROUP_DURABLE_JSON);
    expect(persisted?.resource).not.toContain('committedSnapshot');
    const rawDurableResult = JSON.parse(persisted!.resource) as Record<string, unknown>;
    expect(Object.keys(rawDurableResult)).toEqual(['status', 'result']);
    expect(Object.keys(rawDurableResult.result as Record<string, unknown>)).toEqual(['right']);
    expect(Object.keys((rawDurableResult.result as { right: Record<string, unknown> }).right)).toEqual(['snapshot', 'event']);
    expect(rawDurableResult).toEqual(created);
    expect(harness.transactionWriter.read(harness.context)).toEqual({
      state: 'transaction-finalized',
      status: EntityStatus.COMPLETED,
      result: created,
    });
    expect(harness.observedSnapshots).toHaveLength(1);
    expect(harness.observedSnapshots[0]).toEqual(created.result.right?.snapshot);
    expect(harness.readWakeCount()).toBe(1);
    expect(harness.outboxEntries.size).toBe(1);
  });

  it('records one formation mutation metric only after the commit succeeds', async () => {
    const harness = await createGroupStateTransactionBoundaryHarness();

    expect(harness.formationMutationEvents).toEqual([]);
    await harness.handler.processGroupStateMutation(harness.context);

    expect(harness.formationMutationEvents).toEqual([{ operation: 'createGroup', outcome: 'write' }]);
  });

  it('persists an inactive presence result once without active mutation effects', async () => {
    const actions: string[] = [];
    const writeMutation = vi.fn(async (_context, write) => {
      actions.push('inactive-transaction');
      return await write({} as never);
    });
    const writeMutationWithAfterCommitResult = vi.fn(async () => {
      throw new Error('Inactive presence must not enter the active mutation transaction');
    });
    const handler = new GroupStateInboxHandler({
      mutationService: {
        read: async () => {
          throw new Error('Inactive presence must not read group mutation state');
        },
        compute: () => {
          throw new Error('Inactive presence must not compute a group mutation');
        },
        validate: () => {
          throw new Error('Inactive presence must not validate a group mutation');
        },
        write: async () => {
          throw new Error('Inactive presence must not write group mutation state');
        },
      },
      sessionGenerationLifecycle: {
        read: async (identity) => ({
          identity,
          key: 'closed-lifecycle',
          entry: null,
          state: null,
        }),
        isObservedAtClosed: () => true,
        isGenerationClosed: () => true,
        computeClosed: () => {
          throw new Error('Presence connect must not compute a close state');
        },
        computeConnectGuard: () => {
          throw new Error('Inactive presence must not compute a connect guard');
        },
        write: async () => {
          throw new Error('Inactive presence must not write lifecycle state');
        },
      },
      snapshotObserver: {
        observeSnapshot: async () => {
          throw new Error('Inactive presence must not observe a snapshot');
        },
      },
      transactionWriter: { writeMutation, writeMutationWithAfterCommitResult },
      wakeQueue: () => actions.push('wake'),
    });
    const result = await handler.processGroupStateMutation(inactiveConnectContext());
    expect(JSON.stringify(result)).toBe('{"status":"inactive","sessionId":"inactive-session","generationId":"inactive-generation"}');
    expect(actions).toEqual(['inactive-transaction']);
    expect(writeMutation).toHaveBeenCalledOnce();
    expect(writeMutationWithAfterCommitResult).not.toHaveBeenCalled();
  });

  it('passes the exact committed snapshot object to observation only after commit', async () => {
    const committedSnapshot = { snapshot: 'exact-committed-object' };
    const durableResult = { status: 'ok', result: { right: { durable: true } } };
    const readResult = vi.fn().mockResolvedValue({ durableResult, committedSnapshot });
    vi.resetModules();
    vi.doMock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts', () => ({
      readGroupStateInboxResult: readResult,
    }));
    const { actions, handler, observed, writeMutationWithAfterCommitResult } = await createCommittedSnapshotObservationFixture();

    await expect(
      handler.processGroupStateMutation({
        enqueue: {
          authority: {
            authorityProof: null,
            descriptor: null,
            command: { operation: 'updateGroup', aggregateRef: {} },
            facts: {},
            causalToken: 'causal-token',
            queueResourceId: 'queue-resource',
          },
        },
        entry: { dequeueAudit: { attempts: 1 } },
      } as never),
    ).resolves.toBe(durableResult);
    expect(readResult).toHaveBeenCalledOnce();
    expect(writeMutationWithAfterCommitResult).toHaveBeenCalledOnce();
    expect(observed).toEqual([committedSnapshot]);
    expect(observed[0]).toBe(committedSnapshot);
    expect(actions).toEqual(['write', 'commit', 'observe', 'wake']);
    vi.doUnmock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts');
  });

  it('keeps the existing durable-only writer result and serialization unchanged', async () => {
    const harness = await createGroupStateTransactionBoundaryHarness();
    const durableResult = {
      status: 'legacy-compatible',
      result: { right: { value: 0, omitted: null } },
    } as const;

    const returned = await harness.transactionWriter.writeMutation(harness.context, async () => durableResult);
    const persisted = await harness.results.findByKey(harness.context.entry.key);

    expect(returned).toBe(durableResult);
    expect(persisted?.resource).toBe('{"status":"legacy-compatible","result":{"right":{"value":0,"omitted":null}}}');
    expect(Object.keys(JSON.parse(persisted!.resource) as Record<string, unknown>)).toEqual(['status', 'result']);
    expect(harness.transactionWriter.read(harness.context)).toEqual({
      state: 'transaction-finalized',
      status: EntityStatus.COMPLETED,
      result: durableResult,
    });
  });
});

interface CommittedSnapshotFixture {
  readonly actions: string[];
  readonly handler: GroupStateInboxHandler;
  readonly observed: unknown[];
  readonly writeMutationWithAfterCommitResult: ReturnType<typeof vi.fn>;
}

async function createCommittedSnapshotObservationFixture(): Promise<CommittedSnapshotFixture> {
  const { GroupStateInboxHandler: UncachedGroupStateInboxHandler } =
    await import('@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts');
  const actions: string[] = [];
  const observed: unknown[] = [];
  const writeMutationWithAfterCommitResult = vi.fn(async (_context, write) => {
    const result = await write({} as never);
    actions.push('commit');
    return result;
  });
  const handler = new UncachedGroupStateInboxHandler({
    mutationService: {
      read: async () => ({}),
      compute: () => ({ outcome: 'write', receipt: {} }),
      validate: () => undefined,
      write: async () => {
        actions.push('write');
        return {};
      },
    } as never,
    sessionGenerationLifecycle: {} as never,
    snapshotObserver: {
      observeSnapshot: async (snapshot: unknown) => {
        actions.push('observe');
        observed.push(snapshot);
        return snapshot;
      },
    } as never,
    transactionWriter: {
      writeMutation: async (_context, write) => await write({} as never),
      writeMutationWithAfterCommitResult,
    },
    wakeQueue: () => actions.push('wake'),
  });
  return { actions, handler, observed, writeMutationWithAfterCommitResult };
}

function inactiveConnectContext() {
  return {
    enqueue: {
      authority: {
        authorityProof: null,
        descriptor: null,
        command: {
          operation: 'connectPresence',
          aggregateRef: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'inactive-group',
          },
          commandId: 'inactive-command',
          requestId: 'inactive-request',
          sessionId: 'inactive-session',
          input: {
            principalId: 'owner',
            generationId: 'inactive-generation',
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 61_000,
            actorPrincipalId: 'owner',
            actorSessionId: 'inactive-session',
            reason: null,
            traceId: null,
          },
        },
        facts: {
          nowEpochMs: 2_000,
          expireAtEpochMs: 604_802_000,
          serviceId: 'server-1',
          eventId: 'event-1',
          commandHash: 'sha256:inactive',
          resolvedJoinCode: null,
          joinCodeVerifier: null,
          internalAuthority: 'none',
          formationDamping: 'legacy',
          authenticatedAuthority: { principalId: 'owner', sessionId: 'inactive-session' },
        },
        causalToken: 'causal-token',
        queueResourceId: 'inactive-queue-resource',
      },
    },
    entry: { dequeueAudit: { attempts: 1 } },
  } as never;
}
