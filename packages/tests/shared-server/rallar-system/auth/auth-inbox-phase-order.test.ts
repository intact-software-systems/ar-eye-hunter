import { Temporal } from '@js-temporal/polyfill';
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
    AuthMutationComputed,
    AuthMutationIntent,
    AuthMutationRead,
    AuthMutationResult
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { decodeAuthMutationIntent } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-intent.ts';
import type { AuthMutationValidationIssue } from '@shared-server/rallar-system/auth/mutation/validate/auth-mutation-validation.ts';

import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import type {
    AppInboxExecutionMetadata,
    AppInboxMessageContext
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import type {
    AppInboxCompletionComputed,
    AppInboxCompletionFacts
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { readAuthMutationAttempt } from '@shared-server/rallar-system/auth/mutation/read-auth-mutation-attempt.ts';

const decodeOrderCase = 'decodes before queue identity validation and exits before mutation phases on mismatch';

describe('auth inbox mutation phase order', () => {
    it('reads worker facts and authoritative state before mutation computation', async () => {
        const actions: string[] = [];
        const transaction = {} as PSqlSql;
        const intent = createIssueSessionIntent();
        const read: AuthMutationRead = {
            kind: 'issue-session',
            userByUsername: null,
            userByClientId: null,
            byToken: null,
            bySession: null,
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        };
        const command = (
            await readAuthMutationAttempt(intent, {
                credentialIssuer: createCredentialIssuer([]),
                mutationService: {
                    serviceId: 'auth-service',
                    read: async () => read
                },
                nowEpochMs: () => 1_000
            })
        ).command as Extract<AuthMutationCommand, { kind: 'issue-session'; }>;
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
            outcome: 'write',
            persistence: { operations: [], logoutOutbox: null }
        };
        const written: Array<readonly [PSqlSql, AuthMutationComputed]> = [];
        const handler = new AuthInboxHandler({
            mutationService: createMutationService({
                actions,
                read,
                computed,
                result,
                written,
                validationIssues: []
            }),
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
            'completion',
            'compute',
            'assert',
            'validate',
            'transaction',
            'write'
        ]);
        expect(written).toEqual([[transaction, computed]]);
    });

    it('throws the first validation cause before transaction entry', async () => {
        const actions: string[] = [];
        const read: AuthMutationRead = {
            kind: 'issue-session',
            userByUsername: null,
            userByClientId: null,
            byToken: null,
            bySession: null,
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        };
        const result = { requestId: 'handler-session-request' } as AuthMutationResult;
        const computed = {
            command: {} as AuthMutationCommand,
            read,
            result,
            sessions: [],
            agentTickets: [],
            logoutOutbox: null,
            outcome: 'write',
            persistence: { operations: [], logoutOutbox: null }
        } as const;
        const rejection = new AuthMutationRejectedError('Auth policy rejected', 403);
        const handler = new AuthInboxHandler({
            mutationService: createMutationService({
                actions,
                read,
                computed,
                result,
                written: [],
                validationIssues: [{
                    path: 'command.authority',
                    message: rejection.message,
                    cause: rejection
                }]
            }),
            credentialIssuer: createCredentialIssuer(actions),
            transactionWriter: new RecordingTransactionWriter(actions, {} as PSqlSql),
            nowEpochMs: () => {
                actions.push('clock');
                return 1_000;
            }
        });

        await expect(
            handler.processAuthMutation(createIssueSessionIntent(), createContext(createIssueSessionIntent()))
        ).rejects.toBe(rejection);
        expect(actions).toEqual([
            'clock',
            'facts',
            'read',
            'completion',
            'compute',
            'assert',
            'validate'
        ]);
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
    readonly written: Array<readonly [PSqlSql, AuthMutationComputed]>;
    readonly validationIssues: readonly AuthMutationValidationIssue[];
}

function createMutationService(input: MutationServiceRecording): AuthMutationService {
    return {
        serviceId: 'auth-service',
        read: async () => {
            input.actions.push('read');
            return input.read;
        },
        compute: () => {
            input.actions.push('compute');
            return input.computed;
        },
        assertComputed: () => {
            input.actions.push('assert');
        },
        validate: () => {
            input.actions.push('validate');
            return input.validationIssues;
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
        serviceId: 'auth-service',
        read: async () => unreachable(),
        compute: unreachable,
        assertComputed: unreachable,
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
    private readonly transaction: PSqlSql;

    constructor(actions: string[], transaction: PSqlSql) {
        this.actions = actions;
        this.transaction = transaction;
    }

    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts {
        this.actions.push('completion');
        return { entry: context.entry, completedAtEpochMs: context.message.id.ts };
    }

    async writeComputedMutation<Result>(
        _context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result> {
        this.actions.push('transaction');
        await write(this.transaction);
        return computed.durableResult;
    }
}

function createContext(
    intent: AuthMutationIntent,
    contextId: string = toAuthIntentContextId(intent)
): AppInboxMessageContext<AuthMutationResult> {
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
        message: { id: { ts: 1_000 } } as never,
        entry,
        encodeResult: (result) => encodeAppInboxResult(result, 'Auth handler test result')
    };
}

function requireQueueIdentity(value: string | undefined, field: string): string {
    if (value === undefined || value.length === 0) {
        throw new TypeError(`Auth handler test ${field} is required`);
    }
    return value;
}
