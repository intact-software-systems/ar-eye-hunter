import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { toAuthAppInboxType, toAuthIntentContextId } from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';
import { AuthInboxHandler } from '@shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts';
import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationIntent,
    AuthMutationRead,
    AuthMutationResult
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';

import { materializeAuthMutationIntent } from '@shared-server/rallar-system/auth/mutation/materialize-auth-mutation-intent.ts';
import type { AppInboxMessageContext } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type {
    AppInboxMutationTransactionResult,
    AppInboxMutationTransactionWriter
} from '@shared-server/rallar-system/services/app-inbox-transaction-writer.ts';

const decodeOrderCase = 'decodes before queue identity validation and exits before mutation phases on mismatch';

describe('auth inbox mutation phase order', () => {
    it('materializes worker facts before mutation phases', async () => {
        const actions: string[] = [];
        const transaction = {} as PSqlTransactionSql;
        const intent = createIssueSessionIntent();
        const command = (
            await materializeAuthMutationIntent(intent, {
                credentialIssuer: createCredentialIssuer([]),
                nowEpochMs: () => 1_000
            })
        ).command as Extract<AuthMutationCommand, { kind: 'issue-session'; }>;
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
        const computed: AuthMutationComputed = {
            command,
            read,
            result,
            sessions: [{ session: command.session }],
            agentTickets: [],
            logoutOutbox: null,
            outcome: 'write'
        };
        const written: Array<readonly [PSqlTransactionSql, AuthMutationComputed]> = [];
        const handler = new AuthInboxHandler({
            mutationService: createMutationService({ actions, read, computed, result, written }),
            credentialIssuer: createCredentialIssuer(actions),
            transactionWriter: new RecordingTransactionWriter(actions, transaction),
            nowEpochMs: () => {
                actions.push('clock');
                return 1_000;
            }
        });

        await expect(handler.processAuthMutation(intent, createContext(intent))).resolves.toBe(result);
        expect(actions).toEqual([
            'clock',
            'facts',
            'read',
            'compute',
            'validate',
            'transaction',
            'write'
        ]);
        expect(written).toEqual([[transaction, computed]]);
    });
});

describe('auth inbox routing rejection', () => {
    it(decodeOrderCase, async () => {
        const actions: string[] = [];
        const transaction = {} as PSqlTransactionSql;
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

        await expect(handler.processAuthMutation({}, context)).rejects.toThrow(
            'Auth mutation intent version is invalid'
        );
        await expect(handler.processAuthMutation(intent, context)).rejects.toThrow(
            'Auth AppInbox command identity differs from queue key'
        );
        expect(actions).toEqual([]);
    });
});

function createIssueSessionIntent(): Extract<AuthMutationIntent, { kind: 'issue-session'; }> {
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
        }
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
        write: async () => unreachable()
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
    private readonly transaction: PSqlTransactionSql;

    constructor(actions: string[], transaction: PSqlTransactionSql) {
        this.actions = actions;
        this.transaction = transaction;
    }

    async writeMutation<Result>(
        _context: AppInboxMessageContext,
        write: (transaction: PSqlTransactionSql) => Promise<Result>
    ): Promise<Result> {
        this.actions.push('transaction');
        return await write(this.transaction);
    }

    async writeMutationWithAfterCommitResult<DurableResult, AfterCommitResult>(
        _context: AppInboxMessageContext,
        _write: (
            transaction: PSqlTransactionSql
        ) => Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>>
    ): Promise<AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>> {
        throw new Error('After-commit transaction must not run');
    }
}

function createContext(
    intent: AuthMutationIntent,
    contextId: string = toAuthIntentContextId(intent)
): AppInboxMessageContext {
    const enqueue = {
        type: toAuthAppInboxType(intent),
        topicId: toAuthAppInboxType(intent),
        resourceId: intent.requestId,
        contextId,
        data: intent
    };
    const entry: ResourceEntry = {
        key: toAppQueueKey({
            topicId: enqueue.topicId,
            resourceId: enqueue.resourceId,
            contextId: enqueue.contextId
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
    return { enqueue, message: { id: { ts: 1_000 } } as never, entry };
}
