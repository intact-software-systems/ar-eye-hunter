import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validatePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { createGroupStateRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
  groupStateMaintenanceRequestId,
  type GroupMaintenanceSemanticCommand,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { findDirectResourceOutboxEvidence } from './direct-resource-outbox-evidence.ts';
import { createPostgresSql } from './postgres-topology-concurrency-fixtures.ts';

const task8PostScenarioIt =
  process.env.RALLAR_POSTGRES_INTEGRATION === '1' && process.env.RALLAR_TASK8_REPORT_PATH
    ? it
    : it.skip;

describe('Postgres Task 8 runtime evidence', () => {
  task8PostScenarioIt(
    'binds live maintenance and final topology receipts to Postgres state',
    async () => {
      const reportPath = readEnv('RALLAR_TASK8_REPORT_PATH');
      if (!reportPath) throw new Error('RALLAR_TASK8_REPORT_PATH is required');
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
        resultsByName?: Record<
          string,
          Array<{
            actual?: { body?: { receipt?: Record<string, unknown> } };
          }>
        >;
        outputs?: Record<string, unknown>;
      };
      const receipt = report.resultsByName?.putFinalTopologyConfig?.[0]?.actual?.body?.receipt;
      if (!receipt) throw new Error('Final topology receipt is absent from the report');
      const outboxIds = receipt.outboxIds;
      const groupRef = receipt.groupRef;
      const ownerClientId = report.outputs?.ownerClientId;
      const reusedSessionId = report.outputs?.reusedSessionId;
      const expiryProbeSessionId = report.outputs?.expiryProbeSessionId;
      const expiredPresenceAtEpochMs = report.outputs?.expiredPresenceAtEpochMs;
      const expandedRecipe = JSON.parse(
        await readFile(path.join(path.dirname(reportPath), 'expanded-recipe.json'), 'utf8'),
      ) as {
        recipe?: {
          variables?: Record<string, unknown>;
          steps?: Array<{
            name?: unknown;
            request?: { body?: Record<string, unknown> };
          }>;
        };
      };
      const runId = expandedRecipe.recipe?.variables?.runId;
      const expiryProbeGenerationTemplate = expandedRecipe.recipe?.steps?.find(
        (step) => step.name === 'connectExpiredPresenceProbe',
      )?.request?.body?.generationId;
      const reusedGenerationOneTemplate = expandedRecipe.recipe?.steps?.find(
        (step) => step.name === 'connectReusedSessionGenerationOne',
      )?.request?.body?.generationId;
      if (
        !Array.isArray(outboxIds) ||
        outboxIds.length !== 1 ||
        typeof outboxIds[0] !== 'string' ||
        outboxIds[0].length === 0 ||
        !isGroupRefRecord(groupRef) ||
        typeof ownerClientId !== 'string' ||
        ownerClientId.length === 0 ||
        typeof reusedSessionId !== 'string' ||
        reusedSessionId.length === 0 ||
        typeof expiryProbeSessionId !== 'string' ||
        expiryProbeSessionId.length === 0 ||
        typeof expiredPresenceAtEpochMs !== 'number' ||
        !Number.isSafeInteger(expiredPresenceAtEpochMs) ||
        expiredPresenceAtEpochMs <= 0 ||
        typeof runId !== 'string' ||
        runId.length === 0 ||
        typeof expiryProbeGenerationTemplate !== 'string' ||
        typeof reusedGenerationOneTemplate !== 'string'
      ) {
        throw new Error('Scenario receipt or presence identity is invalid');
      }
      const expiryProbeGenerationId = expiryProbeGenerationTemplate.replaceAll('{runId}', runId);
      const reusedGenerationOneId = reusedGenerationOneTemplate.replaceAll('{runId}', runId);

      const sql = await createSql(requireDatabaseUrl());
      try {
        const runtime = new PSqlRuntimeStateRepository(sql);
        const logicalOutboxId = outboxIds[0];
        const physicalOutboxId = toAppQueueKey({
          topicId: '',
          resourceId: logicalOutboxId,
          contextId: '',
        }).resourceId;
        const entries = await findDirectResourceOutboxEvidence(sql, [physicalOutboxId]);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        if (!entry) throw new Error('Final topology outbox entry is absent from Postgres');
        const message: unknown = JSON.parse(entry.resource);
        validatePersistedALMessage(message);
        expect(entry.resourceId).toBe(physicalOutboxId);
        expect(message.id.msgId).toBe(logicalOutboxId);
        expect(entry.resource).toContain(receipt.commandId);
        expect(await new GroupTopologyConfigRepository(runtime).findConfig(groupRef)).toMatchObject(
          {
            version: receipt.acceptedVersion,
            requestId: receipt.requestId,
            config: receipt.acceptedConfig,
          },
        );
        const groupRepository = createGroupStateRepository(runtime);
        expect(
          await groupRepository.findPresenceEntry({
            ...groupRef,
            sessionId: reusedSessionId,
          }),
        ).toMatchObject({
          value: {
            sessionId: reusedSessionId,
            generationId: expect.stringMatching(/^generation-2-/u),
            status: 'active',
            disconnectedAtEpochMs: null,
          },
        });
        await expect(
          groupRepository.findPresenceEntry({
            ...groupRef,
            sessionId: expiryProbeSessionId,
          }),
        ).resolves.toBeUndefined();
        const expiryEvents = (await groupRepository.listEvents(groupRef)).filter(
          (event) => event.eventType === 'session-disconnected' && event.reason === 'expired',
        );
        expect(expiryEvents).toHaveLength(1);
        const expiryEvent = expiryEvents[0];
        if (!expiryEvent) throw new Error('Expiry event is absent from Postgres');
        expect(expiryEvent).toMatchObject({
          ...groupRef,
          eventType: 'session-disconnected',
          reason: 'expired',
          traceId: null,
          payload: {},
          actor: {
            kind: 'service',
            serviceId: expect.stringMatching(/\S/u),
          },
        });
        const expirySemanticCommand: GroupMaintenanceSemanticCommand = {
          operation: 'disconnectPresence',
          aggregateRef: groupRef,
          sessionId: expiryProbeSessionId,
          input: {
            principalId: ownerClientId,
            generationId: expiryProbeGenerationId,
            generationVersion: expiredPresenceAtEpochMs,
            observedExpiresAtEpochMs: expiredPresenceAtEpochMs,
            disconnectedAtEpochMs: expiryEvent.occurredAtEpochMs,
            lastHeartbeatAtEpochMs: expiredPresenceAtEpochMs,
            expiresAtEpochMs: expiredPresenceAtEpochMs,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: 'expired',
            traceId: null,
          },
        };
        expect(expiryEvent.requestId).toBe(
          groupStateMaintenanceRequestId('expiry', expirySemanticCommand),
        );
        const reusedGenerationOneCommand: GroupMaintenanceSemanticCommand = {
          ...expirySemanticCommand,
          sessionId: reusedSessionId,
          input: {
            ...expirySemanticCommand.input,
            generationId: reusedGenerationOneId,
          },
        };
        expect(expiryEvent.requestId).not.toBe(
          groupStateMaintenanceRequestId('expiry', reusedGenerationOneCommand),
        );
      } finally {
        await sql.end();
      }
    },
    30_000,
  );
});

function isGroupRefRecord(value: unknown): value is GroupRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['applicationId', 'workspaceId', 'groupId'].every(
    (key) => typeof record[key] === 'string' && record[key].length > 0,
  );
}

function readEnv(key: string): string | undefined {
  return process.env[key];
}

async function createSql(databaseUrl: string) {
  return await createPostgresSql(databaseUrl);
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
  }
  return databaseUrl;
}
