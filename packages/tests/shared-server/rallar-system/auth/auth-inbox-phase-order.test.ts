import { Temporal } from '@js-temporal/polyfill';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { toAuthAppInboxType, toAuthIntentContextId } from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';
import { AuthInboxHandler } from '@shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts';
import type {
    AuthMutationCommand,
    AuthMutationIntent,
    AuthMutationRead,
    AuthMutationResult,
    IssueAuthSessionIntent
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { decodeAuthMutationIntent } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-intent.ts';

import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import type { AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxCompletionComputed, AppInboxCompletionFacts } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import type {
    AppInboxMutationTransactionResult,
    AppInboxMutationTransactionWriter
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { materializeAuthMutationIntent } from '@shared-server/rallar-system/auth/mutation/materialize-auth-mutation-intent.ts';

const decodeOrderCase = 'decodes before queue identity validation and exits before mutation phases on mismatch';

describe('auth inbox mutation phase order', () => {
    it('materializes worker facts before mutation phases', async () => {
        const actions: string[] = [];
        const write = createRecordingAuthTransaction(actions);
        const intent = createIssueSessionIntent();
        const { command } = await materializeAuthMutationIntent(intent, {
            credentialIssuer: createCredentialIssuer([]),
            nowEpochMs: () => 1_000
        });
        if (command.kind !== 'issue-session') {
            throw new Error('Expected an issue-session command');
        }
        const read: AuthMutationRead = {
            kind: 'issue-session',
            userByUsername: null,
            userByClientId: null,
            byToken: null,
            bySession: null,
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        };
        const result: AuthMutationResult = {
            requestId: command.requestId,
            kind: 'session-issued',
            ...command.session
        };
        const handler = new AuthInboxHandler({
            mutationService: createMutationService({ actions, read }),
            credentialIssuer: createCredentialIssuer(actions),
            transactionWriter: new RecordingTransactionWriter(actions, write.transaction),
            nowEpochMs: () => {
                actions.push('clock');
                return 1_000;
            }
        });

        await expect(handler.processAuthMutation(intent, createContext(intent))).resolves.toEqual(result);
        expect(actions).toEqual([
            'clock',
            'facts',
            'read',
            'completion-facts',
            'transaction',
            'write'
        ]);
        expect(write.statementCount()).toBe(2);
    });

    it('rejects an expired-row revision overflow before opening the mutation transaction', async () => {
        const actions: string[] = [];
        const intent = createIssueSessionIntent();
        const { command } = await materializeAuthMutationIntent(intent, {
            credentialIssuer: createCredentialIssuer([]),
            nowEpochMs: () => 1_000
        });
        if (command.kind !== 'issue-session') {
            throw new Error('Expected an issue-session command');
        }
        const read: AuthMutationRead = {
            kind: 'issue-session',
            userByUsername: null,
            userByClientId: null,
            byToken: null,
            bySession: null,
            expiredByTokenEntry: null,
            expiredBySessionEntry: {
                key: `session=${encodeURIComponent(command.session.sessionId)}`,
                value: '{}',
                revision: Number.MAX_SAFE_INTEGER,
                expireAtTimestamp: 500,
                updatedTimestamp: '1970-01-01T00:00:00.000Z'
            }
        };
        const handler = new AuthInboxHandler({
            mutationService: createMutationService({ actions, read }),
            credentialIssuer: createCredentialIssuer(actions),
            transactionWriter: new RecordingTransactionWriter(actions, {} as PSqlSql),
            nowEpochMs: () => 1_000
        });

        await expect(handler.processAuthMutation(intent, createContext(intent))).rejects.toThrow(
            new Error(`Invalid runtime state upsert expected revision: ${Number.MAX_SAFE_INTEGER}`)
        );
        // The invalid guard must fail before either owned persistence port is entered.
        expect(actions).not.toContain('transaction');
    });
});

describe('auth inbox routing rejection', () => {
    it(decodeOrderCase, async () => {
        const actions: string[] = [];
        const transaction = {} as PSqlSql;
        const intent = createIssueSessionIntent();
        const context = createContext(intent, 'wrong-context');
        const handler = new AuthInboxHandler({
            mutationService: createUnreachableMutationService(actions),
            credentialIssuer: createCredentialIssuer(actions),
            transactionWriter: new RecordingTransactionWriter(actions, transaction),
            nowEpochMs: () => {
                actions.push('unexpected-clock');
                return 1_000;
            }
        });

        expect(() => decodeAuthMutationIntent({})).toThrow(
            'Auth mutation intent version is invalid'
        );
        await expect(handler.processAuthMutation(intent, context)).rejects.toThrow(
            'Auth AppInbox command identity differs from queue key'
        );
        expect(actions).toEqual([]);
    });
});

function createIssueSessionIntent(): IssueAuthSessionIntent {
    return {
        version: 1,
        kind: 'issue-session',
        requestId: 'handler-session-request',
        authority: {
            kind: 'static-client',
            clientId: 'client-1',
            normalizedUsername: 'alice'
        },
        clientId: 'client-1',
        username: 'alice',
        ttlMs: 1_000
    };
}

interface MutationServiceRecording {
    readonly actions: string[];
    readonly read: AuthMutationRead;
}

function createMutationService(
    input: MutationServiceRecording
): Pick<AuthMutationService, 'serviceId' | 'read'> {
    return {
        serviceId: 'auth-test-service',
        read: async () => {
            input.actions.push('read');
            return input.read;
        }
    };
}

function createUnreachableMutationService(
    actions: string[]
): Pick<AuthMutationService, 'serviceId' | 'read'> {
    const unreachable = (): never => {
        actions.push('unexpected-mutation-phase');
        throw new Error('Mutation phase must not run');
    };
    return {
        serviceId: 'auth-test-service',
        read: async () => unreachable()
    };
}

function createRecordingAuthTransaction(actions: string[]): {
    readonly transaction: PSqlSql;
    statementCount(): number;
} {
    let statements = 0;
    const transaction = (async <Result>(_strings: TemplateStringsArray): Promise<Result> => {
        if (statements === 0) {
            actions.push('write');
        }
        statements += 1;
        return [{ revision: 0 }] as Result;
    }) as PSqlSql;
    transaction.begin = async () => {
        throw new Error('Auth writes must use the caller transaction');
    };
    return {
        transaction,
        statementCount: () => statements
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
        }
    };
}

class RecordingTransactionWriter implements AppInboxMutationTransactionWriter {
    private readonly actions: string[];
    private readonly transaction: PSqlSql;

    constructor(actions: string[], transaction: PSqlSql) {
        this.actions = actions;
        this.transaction = transaction;
    }

    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts {
        this.actions.push('completion-facts');
        return { entry: context.entry, completedAtEpochMs: 1_010 };
    }

    async writeMutation<Result>(
        _context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result> {
        this.actions.push('transaction');
        expect(computed.encodedResult).toEqual(computed.durableResult);
        expect(computed.reservationFinish).toMatchObject({
            expectedAttempts: 1,
            status: EntityStatus.COMPLETED,
            completedAt: new Date(1_010)
        });
        expect(computed.resultReplacement).toBeDefined();
        await write(this.transaction);
        return computed.durableResult;
    }

    async writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        _context: AppInboxExecutionMetadata,
        _computed: AppInboxCompletionComputed<DurableResult>,
        _write: (transaction: PSqlSql) => Promise<AfterCommitResult>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
        throw new Error('After-commit transaction must not run');
    }
}

function createContext(
    intent: AuthMutationIntent,
    contextId: string = toAuthIntentContextId(intent)
): AppInboxExecutionMetadata {
    const enqueue = decodeAppInboxEnqueue({
        type: toAuthAppInboxType(intent),
        topicId: toAuthAppInboxType(intent),
        resourceId: intent.requestId,
        contextId,
        data: intent
    });
    const entry: ResourceEntry = {
        key: toAppQueueKey({
            topicId: requireQueueIdentity(enqueue.topicId, 'topicId'),
            resourceId: requireQueueIdentity(enqueue.resourceId, 'resourceId'),
            contextId: requireQueueIdentity(enqueue.contextId, 'contextId')
        }),
        resource: JSON.stringify(enqueue),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'auth-test-service',
            createdTs: Temporal.PlainDateTime.from('2026-08-07T12:00:00'),
            expiryTs: Temporal.Instant.from('2026-08-07T13:00:00Z')
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 }
    };
    return {
        enqueue,
        message: newALUntargetedMessage(
            'auth-test-service',
            newALRoute(entry.key.topicId, entry.key.contextId, entry.key.resourceId),
            enqueue.type,
            enqueue
        ),
        entry
    };
}

function requireQueueIdentity(value: string | undefined, field: string): string {
    if (value === undefined || value.length === 0) {
        throw new TypeError(`Auth handler test ${field} is required`);
    }
    return value;
}
