import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { describe, expect, it } from 'vitest';

import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AuthInboxHandler } from '@shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts';
import {
  toAuthAppInboxType,
  toAuthCommandContextId,
} from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';
import type { AuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import type {
  AuthMutationCommand,
  AuthMutationComputed,
  AuthMutationRead,
  AuthMutationResult,
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { AppInboxMessageContext } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type {
  AppInboxMutationTransactionResult,
  AppInboxMutationTransactionWriter,
} from '@shared-server/rallar-system/services/app-inbox-transaction-writer.ts';

const decodeOrderCase =
  'decodes before queue identity validation and exits before mutation phases on mismatch';

describe('auth inbox mutation phase order', () => {
  it('runs decode, read, facts, compute, validate, and transaction write in order', async () => {
    const actions: string[] = [];
    const transaction = {} as PSqlTransactionSql;
    const command = await createIssueSessionCommand();
    const read: AuthMutationRead = {
      kind: 'issue-session',
      userByUsername: null,
      userByClientId: null,
      byToken: null,
      bySession: null,
      expiredByTokenEntry: null,
      expiredBySessionEntry: null,
    };
    const result: AuthMutationResult = {
      requestId: command.requestId,
      kind: 'session-issued',
      ...command.session,
    };
    const computed: AuthMutationComputed = {
      command,
      read,
      result,
      sessions: [{ session: command.session }],
      agentTickets: [],
      logoutOutbox: null,
      outcome: 'write',
    };
    const written: Array<readonly [PSqlTransactionSql, AuthMutationComputed]> = [];
    const handler = new AuthInboxHandler({
      mutationService: createMutationService({ actions, read, computed, result, written }),
      credentialIssuer: createCredentialIssuer(actions),
      transactionWriter: new RecordingTransactionWriter(actions, transaction),
    });

    await expect(handler.processAuthMutation(command, createContext(command))).resolves.toBe(
      result,
    );
    expect(actions).toEqual(['read', 'facts', 'compute', 'validate', 'transaction', 'write']);
    expect(written).toEqual([[transaction, computed]]);
  });
});

describe('auth inbox routing rejection', () => {
  it(decodeOrderCase, async () => {
    const actions: string[] = [];
    const transaction = {} as PSqlTransactionSql;
    const command = await createIssueSessionCommand();
    const context = createContext(command, 'wrong-context');
    const handler = new AuthInboxHandler({
      mutationService: createUnreachableMutationService(actions),
      credentialIssuer: createCredentialIssuer(actions),
      transactionWriter: new RecordingTransactionWriter(actions, transaction),
    });

    await expect(handler.processAuthMutation({}, context)).rejects.toThrow(
      'Auth mutation command version is invalid',
    );
    await expect(handler.processAuthMutation(command, context)).rejects.toThrow(
      'Auth AppInbox command identity differs from queue key',
    );
    expect(actions).toEqual([]);
  });
});

async function createIssueSessionCommand(): Promise<
  Extract<
    AuthMutationCommand,
    {
      kind: 'issue-session';
    }
  >
> {
  return {
    version: 1,
    kind: 'issue-session',
    requestId: 'handler-session-request',
    capturedAtEpochMs: 1_000,
    authority: {
      kind: 'static-client',
      clientId: 'client-1',
      normalizedUsername: 'alice',
    },
    session: {
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessTokenDigest: await hashAuthSecret('handler-access-token'),
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: 2_000,
    },
  };
}

interface MutationServiceRecording {
  readonly actions: string[];
  readonly read: AuthMutationRead;
  readonly computed: AuthMutationComputed;
  readonly result: AuthMutationResult;
  readonly written: Array<readonly [PSqlTransactionSql, AuthMutationComputed]>;
}

function createMutationService(input: MutationServiceRecording): AuthMutationService {
  return {
    read: async () => {
      input.actions.push('read');
      return input.read;
    },
    compute: () => {
      input.actions.push('compute');
      return input.computed;
    },
    validate: () => {
      input.actions.push('validate');
    },
    write: async (transaction, candidate) => {
      input.actions.push('write');
      input.written.push([transaction, candidate]);
      return input.result;
    },
  };
}

function createUnreachableMutationService(actions: string[]): AuthMutationService {
  const unreachable = (): never => {
    actions.push('unexpected-mutation-phase');
    throw new Error('Mutation phase must not run');
  };
  return {
    read: async () => unreachable(),
    compute: unreachable,
    validate: unreachable,
    write: async () => unreachable(),
  };
}

function createCredentialIssuer(actions: string[]): AuthCredentialIssuer {
  return {
    issueAccessToken: async () => {
      actions.push('facts');
      return 'handler-access-token';
    },
    issueWebSocketTicket: async () => {
      throw new Error('WebSocket ticket issuance must not run');
    },
    issueAgentTicket: async () => {
      throw new Error('Agent ticket issuance must not run');
    },
  };
}

class RecordingTransactionWriter implements AppInboxMutationTransactionWriter {
  private readonly actions: string[];
  private readonly transaction: PSqlTransactionSql;

  constructor(
    actions: string[],
    transaction: PSqlTransactionSql,
  ) {
    this.actions = actions;
    this.transaction = transaction;
  }

  async writeMutation<Result>(
    _context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<Result>,
  ): Promise<Result> {
    this.actions.push('transaction');
    return await write(this.transaction);
  }

  async writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
    _context: AppInboxMessageContext,
    _write: (
      transaction: PSqlTransactionSql,
    ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>,
  ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
    throw new Error('After-commit transaction must not run');
  }
}

function createContext(
  command: AuthMutationCommand,
  contextId: string = toAuthCommandContextId(command),
): AppInboxMessageContext {
  const enqueue = {
    type: toAuthAppInboxType(command),
    topicId: toAuthAppInboxType(command),
    resourceId: command.requestId,
    contextId,
    data: command,
  };
  const entry: ResourceEntry = {
    key: toAppQueueKey({
      topicId: enqueue.topicId,
      resourceId: enqueue.resourceId,
      contextId: enqueue.contextId,
    }),
    resource: JSON.stringify(enqueue),
    typeId: EnqueuedType.APP_INBOX,
    audit: {
      date: Temporal.PlainTime.from('12:00:00'),
      createdBy: 'auth-test-service',
      createdTs: Temporal.PlainDateTime.from('2026-08-07T12:00:00'),
      expiryTs: Temporal.Instant.from('2026-08-07T13:00:00Z'),
    },
    status: EntityStatus.RESERVED,
    dequeueAudit: { attempts: 1 },
  };
  return { enqueue, message: { id: { ts: 1_000 } } as never, entry };
}
