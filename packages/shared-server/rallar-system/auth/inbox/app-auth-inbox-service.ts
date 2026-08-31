import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    AgentSessionTicketResponse,
    AuthSession,
    LoginResponse,
    LogoutResponse,
    RegisterRequest,
    RegisterResponse,
    WebSocketTicketResponse
} from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { validateAppInboxCommandIdentity } from '../../app-inbox/app-inbox-command-identity.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxType,
    type AppInboxEnqueueInput
} from '../../app-inbox/app-inbox-contracts.ts';
import {
    classifyAppInboxError,
    type AppInboxErrorClassification
} from '../../app-inbox/app-inbox-error-classification.ts';
import { toUnexpectedAppInboxFailure, type AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import type { AppInboxCommandClient } from '../../app-inbox/client/app-inbox-command-client.ts';
import { createAppInboxClientRuntime } from '../../app-inbox/client/create-app-inbox-client-runtime.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import type { AuthMutationService } from '../auth-mutation-service.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import { constantTimeAuthDigestEqual } from '../credentials/constant-time-auth-digest-equal.ts';
import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type { LoginClientData } from '../login/authenticate-auth-user.ts';
import { verifyAuthUserPassword } from '../login/authenticate-auth-user.ts';
import { prepareAuthUserRegistrationVerifier } from '../login/prepare-auth-user-registration.ts';
import type {
    AuthMutationIntent,
    AuthMutationPublicResult,
    AuthMutationResult,
    AuthSessionAuthority,
    ConsumeAuthAgentTicketIntent,
    ConsumeAuthWsTicketIntent,
    IssueAuthAgentTicketsIntent,
    IssueAuthSessionIntent,
    IssueAuthWsTicketIntent,
    LogoutAuthSessionIntent,
    RegisterAuthUserIntent
} from '../mutation/auth-mutation-contracts.ts';
import { decodeAuthMutationIntent } from '../mutation/decode-auth-mutation-intent.ts';
import { decodeAuthMutationResult } from '../mutation/decode-auth-mutation-result.ts';
import { toAuthMutationPublicResult } from '../mutation/to-auth-mutation-public-result.ts';
import type { IssuedAuthSession } from '../persistence/auth-session-types.ts';
import type { PersistedAuthUser } from '../persistence/persisted-auth-user.ts';
import {
    AUTH_STATE_APP_INBOX_TOPIC,
    toAuthAppInboxType,
    toAuthCredentialContextId,
    toAuthIntentContextId,
    toAuthIntentSenderId,
    toAuthSessionContextId,
    toAuthUsernameContextId
} from './auth-app-inbox-routing.ts';
import { AuthInboxHandler } from './auth-inbox-handler.ts';

interface AuthInboxRepository {
    findAllByTopicAndResourceId(
        topicId: string,
        resourceId: string
    ): Promise<readonly ResourceEntry[]>;
    writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry>;
}

const AUTH_TYPES = [
    AppInboxType.AUTH_USER_REGISTER,
    AppInboxType.AUTH_SESSION_ISSUE,
    AppInboxType.AUTH_SESSION_LOGOUT,
    AppInboxType.AUTH_WS_TICKET_ISSUE,
    AppInboxType.AUTH_WS_TICKET_CONSUME,
    AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
    AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME
] as const;

export namespace AppAuthInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository & AuthInboxRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly authMutationService: AuthMutationService;
        readonly credentialIssuer: AuthCredentialIssuer;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
        readonly authFactNowEpochMs?: () => number;
    }

    export interface RequestIdentity {
        readonly requestId: string;
    }
}

export class AppAuthInboxService {
    private readonly commandClient: AppInboxCommandClient;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly authInboxHandler: AuthInboxHandler;
    private readonly authInboxRepository: AuthInboxRepository;
    private readonly authFactNowEpochMs: () => number;

    public readonly authMutationService: AuthMutationService;
    public readonly credentialIssuer: AuthCredentialIssuer;

    constructor(dependencies: AppAuthInboxService.Dependencies, config: AppAuthInboxService.Config) {
        this.commandClient = createAppInboxClientRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resourceInboxRepository: dependencies.resourceInboxRepository,
            resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
            serviceId: config.serviceId,
            defaultTopicId: AUTH_STATE_APP_INBOX_TOPIC,
            timing: config.timing,
            options: config.options,
            wakeOwningQueue: config.wakeOwningQueue
        }).commandClient;
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resultRepository: dependencies.resourceInboxResultsRepository,
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            options: config.options
        });
        this.handlers = handlerRuntime.registry;
        this.authMutationService = dependencies.authMutationService;
        this.credentialIssuer = dependencies.credentialIssuer;
        this.authInboxRepository = dependencies.resourceInboxRepository;
        this.authFactNowEpochMs = config.authFactNowEpochMs ?? Date.now;
        this.authInboxHandler = new AuthInboxHandler({
            mutationService: dependencies.authMutationService,
            credentialIssuer: dependencies.credentialIssuer,
            transactionWriter: handlerRuntime.transactionWriter,
            nowEpochMs: this.authFactNowEpochMs
        });
        for (const type of AUTH_TYPES) {
            this.handlers.registerHandler({
                type,
                decodeCommand: decodeAuthMutationIntent,
                encodeResult: (result) => encodeAppInboxResult(result, 'Auth AppInbox result'),
                handle: async (command, context) => await this.authInboxHandler.processAuthMutation(command, context)
            });
        }
        this.handlers.assertRegistrationComplete(AUTH_TYPES);
    }

    async processAuthIntentUntilCompletion(
        intent: RegisterAuthUserIntent
    ): Promise<Either<AppInboxFailure, RegisterResponse>>;
    async processAuthIntentUntilCompletion(
        intent: IssueAuthSessionIntent
    ): Promise<Either<AppInboxFailure, LoginResponse>>;
    async processAuthIntentUntilCompletion(
        intent: LogoutAuthSessionIntent
    ): Promise<Either<AppInboxFailure, LogoutResponse>>;
    async processAuthIntentUntilCompletion(
        intent: IssueAuthWsTicketIntent
    ): Promise<Either<AppInboxFailure, WebSocketTicketResponse>>;
    async processAuthIntentUntilCompletion(
        intent: ConsumeAuthWsTicketIntent
    ): Promise<Either<AppInboxFailure, IssuedAuthSession>>;
    async processAuthIntentUntilCompletion(
        intent: IssueAuthAgentTicketsIntent
    ): Promise<Either<AppInboxFailure, AgentSessionTicketResponse>>;
    async processAuthIntentUntilCompletion(
        intent: ConsumeAuthAgentTicketIntent
    ): Promise<Either<AppInboxFailure, AuthSession>>;
    async processAuthIntentUntilCompletion(
        intent: AuthMutationIntent
    ): Promise<Either<AppInboxFailure, AuthMutationPublicResult>>;
    async processAuthIntentUntilCompletion(
        intent: AuthMutationIntent
    ): Promise<Either<AppInboxFailure, AuthMutationPublicResult>> {
        const decoded = decodeAuthMutationIntent(intent);
        let persisted: Either<AppInboxFailure, AuthMutationResult>;
        try {
            persisted = await this.commandClient.enqueueAndWaitForResult<AuthMutationResult>(
                {
                    type: toAuthAppInboxType(decoded),
                    topicId: toAuthAppInboxType(decoded),
                    resourceId: decoded.requestId,
                    contextId: toAuthIntentContextId(decoded),
                    senderId: toAuthIntentSenderId(decoded),
                    data: encodeAppInboxCommand(decoded, 'Auth AppInbox command')
                },
                decodeAuthMutationResult
            );
        }
        catch (error) {
            return Either.ofLeft(toAuthBoundaryFailure(classifyAppInboxError(error)));
        }
        if (persisted.left !== undefined) {
            return Either.ofLeft(persisted.left);
        }
        if (persisted.right === undefined) {
            throw new Error('Auth AppInbox result is missing');
        }
        return Either.ofRight(
            await toAuthMutationPublicResult(decoded, persisted.right, this.credentialIssuer)
        );
    }

    async registerUser(
        input:
            & AppAuthInboxService.RequestIdentity
            & Readonly<{
                request: RegisterRequest;
                staticClients?: readonly LoginClientData[];
            }>
    ): Promise<Either<AppInboxFailure, RegisterResponse>> {
        const normalizedUsername = readNormalizedUsername(input.request.username);
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_USER_REGISTER,
                requestId: input.requestId,
                contextId: toAuthUsernameContextId('register-user', normalizedUsername),
                senderId: normalizedUsername
            },
            async () => {
                const registration = await prepareAuthUserRegistrationVerifier(
                    input.request,
                    {
                        passwordSaltSeed: `auth-registration:${input.requestId}:${normalizedUsername}`
                    },
                    input.staticClients
                );
                return {
                    version: 1,
                    kind: 'register-user',
                    requestId: input.requestId,
                    registration
                };
            },
            async (intent) =>
                intent.kind === 'register-user' &&
                intent.registration.normalizedUsername === normalizedUsername &&
                intent.registration.username === input.request.username.trim() &&
                intent.registration.displayName ===
                    readRegistrationDisplayName(input.request.displayName) &&
                (await verifyAuthUserPassword(input.request.password, intent.registration))
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'register-user')
        );
    }

    async issueSession(
        input:
            & AppAuthInboxService.RequestIdentity
            & Readonly<{
                clientId: string;
                username: string;
                ttlMs: number;
                authority: AuthSessionAuthority;
            }>
    ): Promise<Either<AppInboxFailure, LoginResponse>> {
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_SESSION_ISSUE,
                requestId: input.requestId,
                contextId: toAuthUsernameContextId('issue-session', input.authority.normalizedUsername),
                senderId: input.clientId
            },
            async () => ({
                version: 1,
                kind: 'issue-session',
                requestId: input.requestId,
                authority: input.authority,
                clientId: input.clientId,
                username: input.username,
                ttlMs: input.ttlMs
            }),
            (intent) =>
                intent.kind === 'issue-session' &&
                intent.clientId === input.clientId &&
                intent.username === input.username &&
                intent.authority.kind === input.authority.kind &&
                intent.authority.clientId === input.authority.clientId &&
                intent.authority.normalizedUsername === input.authority.normalizedUsername &&
                (intent.authority.kind !== 'registered-user' ||
                    input.authority.kind !== 'registered-user' ||
                    intent.authority.userRevision === input.authority.userRevision) &&
                intent.ttlMs === input.ttlMs
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'issue-session')
        );
    }

    async logoutSession(
        input: AppAuthInboxService.RequestIdentity & Readonly<{ session: IssuedAuthSession; }>
    ): Promise<Either<AppInboxFailure, LogoutResponse>> {
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_SESSION_LOGOUT,
                requestId: input.requestId,
                contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
                senderId: input.session.clientId
            },
            async () => ({
                version: 1,
                kind: 'logout-session',
                requestId: input.requestId,
                expected: {
                    clientId: input.session.clientId,
                    username: input.session.username,
                    sessionId: input.session.sessionId,
                    accessTokenDigest: await hashAuthSecret(input.session.accessToken),
                    issuedAtEpochMs: input.session.issuedAtEpochMs,
                    expiresAtEpochMs: input.session.expiresAtEpochMs
                }
            }),
            async (intent) =>
                intent.kind === 'logout-session' &&
                intent.expected.clientId === input.session.clientId &&
                intent.expected.sessionId === input.session.sessionId &&
                constantTimeAuthDigestEqual(
                    intent.expected.accessTokenDigest,
                    await hashAuthSecret(input.session.accessToken)
                )
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'logout-session')
        );
    }

    async replayLogoutSessionWithCredentialProof(
        input: Readonly<{
            requestId: string;
            clientId: string;
            accessToken: string;
        }>
    ): Promise<Either<AppInboxFailure, LogoutResponse> | null> {
        const presentedDigest = await hashAuthSecret(input.accessToken);
        const physicalRequestId = toAppQueueKey({
            topicId: AppInboxType.AUTH_SESSION_LOGOUT,
            resourceId: input.requestId,
            contextId: ''
        }).resourceId;
        const entries = await this.authInboxRepository.findAllByTopicAndResourceId(
            AppInboxType.AUTH_SESSION_LOGOUT,
            physicalRequestId
        );
        const matchingIntents: LogoutAuthSessionIntent[] = [];
        for (const entry of entries) {
            const intent = readAuthReplayIntent(entry, AppInboxType.AUTH_SESSION_LOGOUT);
            if (intent === null) {
                constantTimeAuthDigestEqual(presentedDigest, '0'.repeat(43));
                continue;
            }
            const proofMatches = constantTimeAuthDigestEqual(
                presentedDigest,
                intent?.kind === 'logout-session' ? intent.expected.accessTokenDigest : '0'.repeat(43)
            );
            if (
                proofMatches &&
                intent?.kind === 'logout-session' &&
                intent.expected.clientId === input.clientId
            ) {
                matchingIntents.push(intent);
            }
        }
        if (matchingIntents.length !== 1) {
            return null;
        }
        return await this.processAuthIntentUntilCompletion(matchingIntents[0]);
    }

    async issueWebSocketTicket(
        input:
            & AppAuthInboxService.RequestIdentity
            & Readonly<{
                session: IssuedAuthSession;
                ttlMs: number;
            }>
    ): Promise<Either<AppInboxFailure, WebSocketTicketResponse>> {
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_WS_TICKET_ISSUE,
                requestId: input.requestId,
                contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
                senderId: input.session.clientId
            },
            async () => ({
                version: 1,
                kind: 'issue-ws-ticket',
                requestId: input.requestId,
                authority: {
                    clientId: input.session.clientId,
                    username: input.session.username,
                    sessionId: input.session.sessionId,
                    accessTokenDigest: await hashAuthSecret(input.session.accessToken),
                    issuedAtEpochMs: input.session.issuedAtEpochMs,
                    expiresAtEpochMs: input.session.expiresAtEpochMs
                },
                ttlMs: input.ttlMs
            }),
            async (intent) =>
                intent.kind === 'issue-ws-ticket' &&
                intent.authority.clientId === input.session.clientId &&
                intent.authority.sessionId === input.session.sessionId &&
                intent.ttlMs === input.ttlMs &&
                constantTimeAuthDigestEqual(
                    intent.authority.accessTokenDigest,
                    await hashAuthSecret(input.session.accessToken)
                )
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'issue-ws-ticket')
        );
    }

    async consumeWebSocketTicket(
        input:
            & AppAuthInboxService.RequestIdentity
            & Readonly<{
                ticket: string;
                expectedSessionId: string;
            }>
    ): Promise<Either<AppInboxFailure, IssuedAuthSession>> {
        const ticketDigest = await hashAuthSecret(input.ticket);
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_WS_TICKET_CONSUME,
                requestId: input.requestId,
                contextId: toAuthCredentialContextId(ticketDigest),
                senderId: ticketDigest
            },
            async () => ({
                version: 1,
                kind: 'consume-ws-ticket',
                requestId: input.requestId,
                ticketDigest,
                expectedSessionId: input.expectedSessionId
            }),
            (intent) =>
                intent.kind === 'consume-ws-ticket' &&
                intent.ticketDigest === ticketDigest &&
                intent.expectedSessionId === input.expectedSessionId
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'consume-ws-ticket')
        );
    }

    async issueAgentSessionTickets(
        input:
            & AppAuthInboxService.RequestIdentity
            & Readonly<{
                session: IssuedAuthSession;
                ticketTtlMs: number;
                agents: readonly Readonly<{ agentId: string; }>[];
            }>
    ): Promise<Either<AppInboxFailure, AgentSessionTicketResponse>> {
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
                requestId: input.requestId,
                contextId: toAuthSessionContextId(input.session.clientId, input.session.sessionId),
                senderId: input.session.clientId
            },
            async () => ({
                version: 1,
                kind: 'issue-agent-tickets',
                requestId: input.requestId,
                authority: {
                    clientId: input.session.clientId,
                    username: input.session.username,
                    sessionId: input.session.sessionId,
                    accessTokenDigest: await hashAuthSecret(input.session.accessToken),
                    issuedAtEpochMs: input.session.issuedAtEpochMs,
                    expiresAtEpochMs: input.session.expiresAtEpochMs
                },
                ticketTtlMs: input.ticketTtlMs,
                agentIds: input.agents.map((agent) => agent.agentId)
            }),
            async (intent) =>
                intent.kind === 'issue-agent-tickets' &&
                intent.agentIds.join('\u0000') ===
                    input.agents.map((agent) => agent.agentId).join('\u0000') &&
                intent.ticketTtlMs === input.ticketTtlMs &&
                constantTimeAuthDigestEqual(
                    intent.authority.accessTokenDigest,
                    await hashAuthSecret(input.session.accessToken)
                )
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'issue-agent-tickets')
        );
    }

    async consumeAgentSessionTicket(
        input: AppAuthInboxService.RequestIdentity & Readonly<{ ticket: string; }>
    ): Promise<Either<AppInboxFailure, AuthSession>> {
        const ticketDigest = await hashAuthSecret(input.ticket);
        const physicalRequestId = toAppQueueKey({
            topicId: AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
            resourceId: input.requestId,
            contextId: ''
        }).resourceId;
        const entries = await this.authInboxRepository.findAllByTopicAndResourceId(
            AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
            physicalRequestId
        );
        const matchingIntents: ConsumeAuthAgentTicketIntent[] = [];
        for (const entry of entries) {
            const intent = readAuthReplayIntent(entry, AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME);
            const expectedDigest = intent?.kind === 'consume-agent-ticket' ? intent.ticketDigest : '0'.repeat(43);
            if (
                constantTimeAuthDigestEqual(ticketDigest, expectedDigest) &&
                intent?.kind === 'consume-agent-ticket'
            ) {
                matchingIntents.push(intent);
            }
        }
        if (matchingIntents.length === 1) {
            return await this.processAuthIntentUntilCompletion(matchingIntents[0]);
        }
        const reserved = await this.reserveAuthIntent(
            {
                type: AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
                requestId: input.requestId,
                contextId: toAuthCredentialContextId(ticketDigest),
                senderId: ticketDigest
            },
            async () => ({
                version: 1,
                kind: 'consume-agent-ticket',
                requestId: input.requestId,
                ticketDigest
            }),
            (intent) => intent.kind === 'consume-agent-ticket' && intent.ticketDigest === ticketDigest
        );
        if (reserved.left !== undefined) {
            return Either.ofLeft(reserved.left);
        }
        return await this.processAuthIntentUntilCompletion(
            requireReservedIntent(reserved, 'consume-agent-ticket')
        );
    }

    private async reserveAuthIntent<I extends AuthMutationIntent>(
        reservation: AuthCommandReservation,
        materialize: () => Promise<I>,
        matches: (intent: AuthMutationIntent) => boolean | Promise<boolean>
    ): Promise<Either<AppInboxFailure, I>> {
        try {
            const placeholder = toAuthInboxEntry({
                type: reservation.type,
                topicId: reservation.type,
                resourceId: reservation.requestId,
                contextId: reservation.contextId,
                senderId: reservation.senderId,
                data: null
            });
            const entry = await this.authInboxRepository.writeMaterializedIfAbsentOrReplaceExpired(
                placeholder,
                async () => toAuthInboxEntry(toAuthIntentEnqueue(decodeAuthMutationIntent(await materialize())))
            );
            const intent = readAuthReplayIntent(entry, reservation.type);
            if (!intent || !(await matches(intent))) {
                throw new AppInboxIdempotencyConflictError(
                    reservation.requestId,
                    'existing-auth-command',
                    'received-auth-intent'
                );
            }
            return Either.ofRight(intent as I);
        }
        catch (error) {
            return Either.ofLeft(toAuthBoundaryFailure(classifyAppInboxError(error)));
        }
    }
}

function toAuthBoundaryFailure(
    classification: AppInboxErrorClassification
): AppInboxFailure {
    return classification.kind === 'terminal'
        ? classification.result
        : toUnexpectedAppInboxFailure();
}

interface AuthCommandReservation {
    readonly type: AppInboxType;
    readonly requestId: string;
    readonly contextId: string;
    readonly senderId: string;
}

function toAuthIntentEnqueue(intent: AuthMutationIntent): AppInboxEnqueueInput {
    return {
        type: toAuthAppInboxType(intent),
        topicId: toAuthAppInboxType(intent),
        resourceId: intent.requestId,
        contextId: toAuthIntentContextId(intent),
        senderId: toAuthIntentSenderId(intent),
        data: encodeAppInboxCommand(intent, 'Auth AppInbox command')
    };
}

function toAuthInboxEntry(enqueue: AppInboxEnqueueInput): ResourceEntry {
    if (!enqueue.topicId || !enqueue.contextId || !enqueue.resourceId) {
        throw new TypeError('Auth AppInbox queue identity is incomplete');
    }
    const key = toAppQueueKey({
        topicId: enqueue.topicId,
        contextId: enqueue.contextId,
        resourceId: enqueue.resourceId
    });
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUntargetedMessage(
            toAppQueueCreatedBy('auth-fact-reservation'),
            newALRoute(key.topicId, key.contextId, key.resourceId),
            enqueue.type,
            enqueue
        ),
        'APP_INBOX'
    );
}

function requireReservedIntent<K extends AuthMutationIntent['kind']>(
    reserved: Either<AppInboxFailure, AuthMutationIntent>,
    kind: K
): Extract<AuthMutationIntent, { kind: K; }> {
    if (reserved.right?.kind !== kind) {
        throw new Error(`Reserved auth intent kind differs: ${kind}`);
    }
    return reserved.right as Extract<AuthMutationIntent, { kind: K; }>;
}

function readNormalizedUsername(username: string): string {
    return username.trim().toLowerCase();
}

function readRegistrationDisplayName(displayName: string | undefined): string | null {
    return displayName?.trim() || null;
}

function readAuthReplayIntent(
    entry: ResourceEntry,
    operation: AppInboxType
): AuthMutationIntent | null {
    const validation = validateAppInboxCommandIdentity(entry);
    if (!validation.valid || validation.identity.operation !== operation) {
        return null;
    }
    try {
        const intent = decodeAuthMutationIntent(validation.command.data);
        const expectedKey = toAppQueueKey({
            topicId: toAuthAppInboxType(intent),
            resourceId: intent.requestId,
            contextId: toAuthIntentContextId(intent)
        });
        return expectedKey.topicId === entry.key.topicId &&
                expectedKey.resourceId === entry.key.resourceId &&
                expectedKey.contextId === entry.key.contextId
            ? intent
            : null;
    }
    catch {
        return null;
    }
}
