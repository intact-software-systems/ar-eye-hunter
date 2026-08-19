import {
  AppInboxReservationConflictError,
  AppInboxType,
  createAppInboxRetryExhaustionHandler,
  createAppInboxRetryExhaustionRecoveryHandler,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
  DequeueResourceEntryController,
  type ResourceInboxRetryExhaustion,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type Key, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';

const NOW_EPOCH_MS = Date.parse('2026-07-22T12:00:00.000Z');

import {
  createAtomicHarness,
  createResilience,
  toExhaustion,
  toPersistedAppInboxResource,
  toRecovery,
} from './app-inbox-transaction-test-runtime.ts';

describe('AppInbox retry exhaustion', () => {
  it('persists attempt-20 diagnostics and FAILED completion in one transaction', async () => {
    const harness = createAtomicHarness({ attempts: 20 });
    const telemetry: ResourceInboxRetryExhaustion[] = [];
    const releaseEntries = vi.fn();
    const onRetryExhausted = createAppInboxRetryExhaustionHandler({
      database: harness.database.sql,
    });
    let reserved = false;
    const controller = DequeueResourceEntryController.toDequeuer<Key>(
      {
        isAnyEntryToLock: async () => true,
        reserveEntries: async () => {
          if (reserved) return new Map();
          reserved = true;
          return new Map([[harness.entry.key, harness.entry]]);
        },
        reserveTimeoutEntries: async () => new Map(),
        reserveOverdueRetryEntries: async () => new Map(),
        reserveRetryExhaustionFinalizations: async () => new Map(),
        releaseEntries,
      },
      () => new Set([EnqueuedType.APP_INBOX]),
      () => 1,
      20,
      1,
      createResilience(),
      {
        nowEpochMs: () => NOW_EPOCH_MS,
        jitterUnit: () => 0.5,
        onRetryExhausted,
        onRetryExhaustionTelemetry: (event) => {
          if (event.failure.source === 'processing') {
            telemetry.push(event as ResourceInboxRetryExhaustion);
          }
        },
      },
    );

    await controller.dequeueForCompute(async () => {
      throw Object.assign(new Error('conditional write lost secret=password-123'), {
        code: 'runtime-state-write-conflict',
      });
    });

    expect(releaseEntries).not.toHaveBeenCalled();
    expect(harness.database.beginCalls).toBe(1);
    expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
      EntityStatus.FAILED,
    );
    const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
    expect(stored?.status).toBe(EntityStatus.FAILED);
    expect(JSON.parse(stored!.resource)).toEqual({
      type: 'app-inbox-retry-exhausted',
      status: 503,
      message: 'AppInbox processing exhausted its retry budget',
      issues: null,
      denial: null,
      retry: {
        kind: 'exhausted',
        attempts: 20,
        lane: 'NEW',
        queueAgeMs: expect.any(Number),
        dueAgeMs: expect.any(Number),
      },
      commandIdentity: {
        contextId: harness.entry.key.contextId,
        resourceId: harness.entry.key.resourceId,
        topicId: harness.entry.key.topicId,
        operation: AppInboxType.GROUP_CREATE,
        operationSource: 'command',
      },
      selectedLane: 'NEW',
      processingAttempts: 20,
      reservationAttempt: 20,
      lastError: {
        source: 'processing',
        code: 'runtime-state-write-conflict',
        message: 'AppInbox processing encountered a retryable conflict',
      },
      queueAgeMs: expect.any(Number),
      dueAgeMs: expect.any(Number),
      exhaustedAtEpochMs: NOW_EPOCH_MS,
    });
    expect(telemetry).toEqual([
      expect.objectContaining({
        processingAttempts: 20,
        reservationAttempt: 20,
        lane: 'NEW',
        classification: 'retryable',
        exhausted: true,
        queueAgeMs: expect.any(Number),
        dueAgeMs: expect.any(Number),
      }),
    ]);
    expect(stored?.resource).not.toContain('password-123');
  });

  it.each(
    [
      {
        name: 'corrupt outer JSON',
        resource: '{"secret":"outer-password"',
        operationSource: 'corrupt',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
      {
        name: 'corrupt nested command JSON',
        resource: JSON.stringify({
          payload: {
            typeId: AppInboxType.GROUP_CREATE,
            resource: '{"secret":"nested-password"',
          },
        }),
        operationSource: 'corrupt',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
      {
        name: 'missing outer dispatch type',
        resource: toPersistedAppInboxResource({
          nestedType: AppInboxType.GROUP_CREATE,
        }),
        operationSource: 'corrupt',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
      {
        name: 'known outer and nested operation mismatch',
        resource: toPersistedAppInboxResource({
          outerType: AppInboxType.GROUP_UPDATE,
          nestedType: AppInboxType.GROUP_CREATE,
        }),
        operationSource: 'corrupt',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
      {
        name: 'missing nested command type',
        resource: toPersistedAppInboxResource({
          outerType: AppInboxType.GROUP_CREATE,
        }),
        operationSource: 'corrupt',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
      {
        name: 'durable queue topic mismatch',
        resource: toPersistedAppInboxResource({
          outerType: AppInboxType.GROUP_CREATE,
          nestedType: AppInboxType.GROUP_CREATE,
        }),
        topicId: 'app-inbox.client-state',
        operationSource: 'corrupt',
        operation: 'APP_INBOX_CLIENT_OPERATION_UNAVAILABLE',
      },
      {
        name: 'valid outer nested and topic agreement',
        resource: toPersistedAppInboxResource({
          outerType: AppInboxType.GROUP_CREATE,
          nestedType: AppInboxType.GROUP_CREATE,
        }),
        operationSource: 'command',
        operation: AppInboxType.GROUP_CREATE,
      },
      {
        name: 'valid topology config outer nested and topic agreement',
        resource: toPersistedAppInboxResource({
          outerType: AppInboxType.TOPOLOGY_CONFIG_PUT,
          nestedType: AppInboxType.TOPOLOGY_CONFIG_PUT,
        }),
        operationSource: 'command',
        operation: AppInboxType.TOPOLOGY_CONFIG_PUT,
      },
      {
        name: 'unknown removed outer dispatch type',
        resource: toPersistedAppInboxResource({
          outerType: 'REMOVED_GROUP_OPERATION_password',
          nestedType: AppInboxType.GROUP_CREATE,
        }),
        operationSource: 'unavailable',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
      {
        name: 'unknown removed nested command type',
        resource: toPersistedAppInboxResource({
          outerType: AppInboxType.GROUP_CREATE,
          nestedType: 'REMOVED_GROUP_OPERATION_password',
        }),
        operationSource: 'unavailable',
        operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
      },
    ].flatMap((testCase) => [
      { ...testCase, lane: 'initial' as const, attempts: 20 },
      { ...testCase, lane: 'recovery' as const, attempts: 21 },
    ]),
  )(
    'atomically finalizes $lane exhaustion with $name',
    async ({ resource, operationSource, operation, topicId, lane, attempts }) => {
      const harness = createAtomicHarness({
        attempts,
        entryResource: resource,
        entryTopicId: topicId,
      });
      const domainHandler = vi.fn();
      harness.service.onStateMessage(AppInboxType.GROUP_CREATE, domainHandler);
      if (lane === 'initial') {
        await createAppInboxRetryExhaustionHandler({
          database: harness.database.sql,
        })(toExhaustion(harness.entry));
      } else {
        await createAppInboxRetryExhaustionRecoveryHandler({
          database: harness.database.sql,
        })(toRecovery(harness.entry, attempts));
      }

      const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
      expect(harness.database.beginCalls).toBe(1);
      expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
        EntityStatus.FAILED,
      );
      expect(
        harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.dequeueAudit.attempts,
      ).toBe(attempts);
      expect(stored?.status).toBe(EntityStatus.FAILED);
      expect(JSON.parse(stored!.resource)).toMatchObject({
        commandIdentity: {
          operation,
          operationSource,
        },
        processingAttempts: 20,
        reservationAttempt: attempts,
      });
      expect(stored?.resource).not.toContain('password');
      expect(domainHandler).not.toHaveBeenCalled();
    },
  );

  it('rolls back a lost recovery reservation and finalizes its successor', async () => {
    const harness = createAtomicHarness({ attempts: 21, loseReservation: true });
    const recover = createAppInboxRetryExhaustionRecoveryHandler({
      database: harness.database.sql,
    });

    await expect(recover(toRecovery(harness.entry, 21))).rejects.toBeInstanceOf(
      AppInboxReservationConflictError,
    );
    expect(harness.database.state.results.size).toBe(0);
    expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
      EntityStatus.RESERVED,
    );

    const attempt22 = harness.database.reclaimFinalization();
    harness.database.loseReservation = false;
    await recover(toRecovery(attempt22, 22));

    const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
    expect(harness.database.beginCalls).toBe(2);
    expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(
      EntityStatus.FAILED,
    );
    expect(JSON.parse(stored!.resource)).toMatchObject({
      selectedLane: 'FINALIZATION',
      processingAttempts: 20,
      reservationAttempt: 22,
      finalizedAtEpochMs: NOW_EPOCH_MS,
      lastError: {
        source: 'finalization-recovery',
        code: 'app-inbox-finalization-recovery',
      },
    });
  });
});
