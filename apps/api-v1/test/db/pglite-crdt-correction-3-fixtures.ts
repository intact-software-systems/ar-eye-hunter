import assert from 'node:assert/strict';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/services/crdt-mutations.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import type { CrdtMutationActor } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { readPGliteDatabaseEpochMs } from './pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1',
  },
};

export function withCompetingWrite(
  database: PSqlSql,
  now: number,
  afterCompetingWrite: () => void,
): PSqlSql {
  let compete = true;
  const wrapped =
    ((parts: TemplateStringsArray | readonly unknown[], ...values: unknown[]) =>
      database(parts as never, ...values)) as PSqlSql;
  wrapped.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>) => {
    if (compete) {
      compete = false;
      const repository = new PSqlCrdtMutationRepository(
        database,
        () => Promise.resolve(true),
        [{ documentType: 'checklist', rollout: 'production' }],
      );
      const service = createCrdtMutationService({
        repository,
        createWriter: (transaction) =>
          new PSqlCrdtMutationRepository(
            transaction,
            () => Promise.resolve(true),
            [{ documentType: 'checklist', rollout: 'production' }],
          ),
        serviceId: 'server-2',
      });
      const command = await appendCommand({ now, commandId: 'competitor', updateId: 'competitor-update', actor: {
        actorId: 'client-2',
        principalId: 'principal-2',
        sessionId: 'session-2',
        serverId: 'server-2',
      } });
      const computed = service.compute(command, await service.read(command));
      assert.equal(computed.outcome, 'write');
      await database.begin(async (transaction) => {
        await new PSqlCrdtMutationRepository(
          transaction,
          () => Promise.resolve(true),
          [{ documentType: 'checklist', rollout: 'production' }],
        ).writeMutation(computed as never);
      });
      afterCompetingWrite();
    }
    return await database.begin(write);
  };
  return wrapped;
}

export interface AppendCommandInput {
  readonly now: number;
  readonly commandId: string;
  readonly updateId: string;
  readonly actor?: CrdtMutationActor;
}

export async function appendCommand(input: AppendCommandInput) {
  const {
    now,
    commandId,
    updateId,
    actor = {
      actorId: 'client-1',
      principalId: 'principal-1',
      sessionId: 'session-1',
      serverId: 'server-1',
    },
  } = input;
  return await createCrdtMutationCommand({
    operation: 'append',
    commandId,
    actor,
    capturedAtEpochMs: now,
    expireAtEpochMs: now + 60_000,
    document: DOCUMENT,
    responseAudience: {
      kind: 'room',
      senderSessionId: actor.sessionId,
      topicId: 'room.crdt',
      contextId: 'group-1',
    },
    authorizationScope: 'room',
    update: update(updateId, now - 1_000),
  });
}

export function update(updateId: string, createdAtEpochMs: number): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId,
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs,
    payload: {
      kind: 'batch',
      operations: [{
        kind: 'register.set',
        path: ['title'],
        policy: 'lww',
        value: updateId,
      }],
    },
  };
}

export async function queueNow(sql: PSqlSql): Promise<number> {
  return await readPGliteDatabaseEpochMs(sql as never) + 12 * 60 * 60 * 1_000;
}
