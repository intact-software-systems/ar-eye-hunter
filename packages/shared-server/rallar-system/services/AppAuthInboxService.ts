import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '../../postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import type { RallarTimingSink } from './timing.ts';
import {
    AppInboxService,
    type AppInboxServiceOptions,
} from './AppInboxService.ts';
import {
    AppInboxType,
    type AppInboxMessageContext,
} from './app-inbox-contracts.ts';
import {
    type AppInboxFailure,
    toTerminalAppInboxFailure,
} from './app-inbox-failure.ts';
import { toAppInboxErrorCode } from './app-inbox-error-classification.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    type AuthMutationCommand,
    type AuthMutationPublicResult,
    type AuthMutationResult,
    type AuthMutationService,
    type IssueAuthSessionCommand,
    captureAuthMutationFacts,
    decodeAuthMutationResult,
    decodeAuthMutationCommand,
} from './auth-state-mutations.ts';
import type { AuthCredentialIssuer } from './auth-credential-issuer.ts';
import {
    hashAuthSecret,
    type IssuedAuthSession,
} from '../repositories/AuthSessionRepository.ts';
import { toAppQueueKey } from './app-inbox-queue-key.ts';
import type {
    AgentSessionTicketResponse,
    ConsumeAgentSessionTicketResponse,
    LoginResponse,
    LogoutResponse,
    RegisterResponse,
    WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import type { AuthUser } from '../repositories/AuthUserRepository.ts';

export const AUTH_STATE_APP_INBOX_TOPIC = 'app-inbox.auth-state';

type AuthRequestFacts = Readonly<{
    requestId: string;
    capturedAtEpochMs: number;
}>;

const AUTH_TYPES = [
    AppInboxType.AUTH_USER_REGISTER,
    AppInboxType.AUTH_SESSION_ISSUE,
    AppInboxType.AUTH_SESSION_LOGOUT,
    AppInboxType.AUTH_WS_TICKET_ISSUE,
    AppInboxType.AUTH_WS_TICKET_CONSUME,
    AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
    AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
] as const;

export class AppAuthInboxService extends AppInboxService {
    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        database: PSqlSql,
        public readonly authMutationService: AuthMutationService,
        public readonly credentialIssuer: AuthCredentialIssuer,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            database,
            serviceId,
            AUTH_STATE_APP_INBOX_TOPIC,
            timing,
            options,
        );
        for (const type of AUTH_TYPES) {
            this.onStateMessage<unknown>(
                type,
                async (data, context) => await this.processCommand(data, context),
            );
        }
    }

    async processAuthCommandUntilCompletion<R extends AuthMutationPublicResult>(
        command: AuthMutationCommand,
    ): Promise<Either<AppInboxFailure, R>> {
        const decoded = decodeAuthMutationCommand(command);
        let persisted: Either<AppInboxFailure, AuthMutationResult>;
        try {
            persisted = await super.processEntryUntilCompletionResult<
                AuthMutationCommand,
                AuthMutationResult
            >({
                type: toAuthAppInboxType(decoded),
                topicId: AUTH_STATE_APP_INBOX_TOPIC,
                resourceId: decoded.requestId,
                contextId: toAuthCommandContextId(decoded),
                senderId: toAuthCommandSenderId(decoded),
                data: decoded,
            });
        } catch (error) {
            return Either.ofLeft(toTerminalAppInboxFailure(
                error,
                toAppInboxErrorCode(error),
            ));
        }
        if (persisted.left !== undefined) return Either.ofLeft(persisted.left);
        if (persisted.right === undefined) throw new Error('Auth AppInbox result is missing');
        return Either.ofRight(
            await this.toPublicResult(
                decoded,
                decodeAuthMutationResult(persisted.right),
            ) as R,
        );
    }

    async registerUser(
        input: AuthRequestFacts & Readonly<{ user: AuthUser }>,
    ): Promise<Either<AppInboxFailure, RegisterResponse>> {
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'register-user',
            ...input,
        });
    }

    async issueSession(
        input: AuthRequestFacts & Readonly<{
            clientId: string;
            username: string;
            sessionId: string;
            expiresAtEpochMs: number;
            authority: IssueAuthSessionCommand['authority'];
        }>,
    ): Promise<Either<AppInboxFailure, LoginResponse>> {
        const accessToken = await this.credentialIssuer.issueAccessToken(input.sessionId);
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'issue-session',
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            authority: input.authority,
            session: {
                clientId: input.clientId,
                username: input.username,
                sessionId: input.sessionId,
                accessTokenDigest: await hashAuthSecret(accessToken),
                issuedAtEpochMs: input.capturedAtEpochMs,
                expiresAtEpochMs: input.expiresAtEpochMs,
            },
        });
    }

    async logoutSession(
        input: AuthRequestFacts & Readonly<{ session: IssuedAuthSession }>,
    ): Promise<Either<AppInboxFailure, LogoutResponse>> {
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'logout-session',
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            expected: {
                clientId: input.session.clientId,
                username: input.session.username,
                sessionId: input.session.sessionId,
                accessTokenDigest: await hashAuthSecret(input.session.accessToken),
                issuedAtEpochMs: input.session.issuedAtEpochMs,
                expiresAtEpochMs: input.session.expiresAtEpochMs,
            },
        });
    }

    async issueWebSocketTicket(
        input: AuthRequestFacts & Readonly<{
            session: IssuedAuthSession;
            expiresAtEpochMs: number;
        }>,
    ): Promise<Either<AppInboxFailure, WebSocketTicketResponse>> {
        const ticket = await this.credentialIssuer.issueWebSocketTicket(
            input.requestId,
            input.session.sessionId,
        );
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'issue-ws-ticket',
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            ticketRecord: {
                ticketDigest: await hashAuthSecret(ticket),
                accessTokenDigest: await hashAuthSecret(input.session.accessToken),
                sessionId: input.session.sessionId,
                clientId: input.session.clientId,
                issuedAtEpochMs: input.capturedAtEpochMs,
                expiresAtEpochMs: input.expiresAtEpochMs,
            },
        });
    }

    async consumeWebSocketTicket(
        input: AuthRequestFacts & Readonly<{
            ticket: string;
            expectedSessionId: string;
        }>,
    ): Promise<Either<AppInboxFailure, IssuedAuthSession>> {
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'consume-ws-ticket',
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            ticketDigest: await hashAuthSecret(input.ticket),
            expectedSessionId: input.expectedSessionId,
        });
    }

    async issueAgentSessionTickets(
        input: AuthRequestFacts & Readonly<{
            session: IssuedAuthSession;
            sessionExpiresAtEpochMs: number;
            ticketExpiresAtEpochMs: number;
            agents: readonly Readonly<{ agentId: string; sessionId: string }>[];
        }>,
    ): Promise<Either<AppInboxFailure, AgentSessionTicketResponse>> {
        const tickets = await Promise.all(input.agents.map(async (agent) => {
            const accessToken = await this.credentialIssuer.issueAccessToken(agent.sessionId);
            const ticket = await this.credentialIssuer.issueAgentTicket(
                input.requestId,
                agent.agentId,
                agent.sessionId,
            );
            return {
                agentId: agent.agentId,
                sessionId: agent.sessionId,
                accessTokenDigest: await hashAuthSecret(accessToken),
                ticketDigest: await hashAuthSecret(ticket),
                clientId: input.session.clientId,
                username: input.session.username,
                issuedAtEpochMs: input.capturedAtEpochMs,
                sessionExpiresAtEpochMs: input.sessionExpiresAtEpochMs,
                ticketExpiresAtEpochMs: input.ticketExpiresAtEpochMs,
            };
        }));
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'issue-agent-tickets',
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            authority: {
                clientId: input.session.clientId,
                username: input.session.username,
                sessionId: input.session.sessionId,
                accessTokenDigest: await hashAuthSecret(input.session.accessToken),
                issuedAtEpochMs: input.session.issuedAtEpochMs,
                expiresAtEpochMs: input.session.expiresAtEpochMs,
            },
            tickets,
        });
    }

    async consumeAgentSessionTicket(
        input: AuthRequestFacts & Readonly<{ ticket: string }>,
    ): Promise<Either<AppInboxFailure, ConsumeAgentSessionTicketResponse>> {
        return await this.processAuthCommandUntilCompletion({
            version: 1,
            kind: 'consume-agent-ticket',
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            ticketDigest: await hashAuthSecret(input.ticket),
        });
    }

    private async processCommand(
        input: unknown,
        context: AppInboxMessageContext,
    ): Promise<AuthMutationResult> {
        const command = decodeAuthMutationCommand(input);
        const expectedKey = toAppQueueKey({
            topicId: AUTH_STATE_APP_INBOX_TOPIC,
            resourceId: command.requestId,
            contextId: toAuthCommandContextId(command),
        });
        if (
            toAuthAppInboxType(command) !== context.enqueue.type ||
            expectedKey.resourceId !== context.entry.key.resourceId ||
            expectedKey.contextId !== context.entry.key.contextId
        ) throw new TypeError('Auth AppInbox command identity differs from queue key');
        const read = await this.authMutationService.read(command);
        const facts = await captureAuthMutationFacts(command, this.credentialIssuer);
        const computed = this.authMutationService.compute(command, read, facts);
        this.authMutationService.validate(command, read, computed);
        return await this.writeMutation(
            context,
            async (transaction) =>
                await this.authMutationService.write(transaction, computed),
        );
    }

    private async toPublicResult(
        command: AuthMutationCommand,
        result: AuthMutationResult,
    ): Promise<AuthMutationPublicResult> {
        switch (command.kind) {
            case 'register-user':
                if (!('registeredAtEpochMs' in result)) {
                    throw new Error('Auth registration result kind differs');
                }
                return result;
            case 'logout-session':
                if (!('loggedOut' in result)) {
                    throw new Error('Auth logout result kind differs');
                }
                return result;
            case 'issue-session': {
                const receipt = requireResultKind(result, 'session-issued');
                const accessToken = await this.resolveAccessToken(
                    receipt.sessionId,
                    receipt.accessTokenDigest,
                );
                return {
                    clientId: receipt.clientId,
                    username: receipt.username,
                    accessToken,
                    sessionId: receipt.sessionId,
                    expiresAtEpochMs: receipt.expiresAtEpochMs,
                };
            }
            case 'issue-ws-ticket': {
                const receipt = requireResultKind(result, 'ws-ticket-issued');
                const ticket = await this.credentialIssuer.issueWebSocketTicket(
                    command.requestId,
                    receipt.sessionId,
                );
                await requireCredentialDigest(ticket, receipt.ticketDigest);
                return {
                    ticket,
                    sessionId: receipt.sessionId,
                    expiresAtEpochMs: receipt.expiresAtEpochMs,
                };
            }
            case 'consume-ws-ticket':
            case 'consume-agent-ticket': {
                const receipt = requireResultKind(
                    result,
                    command.kind === 'consume-ws-ticket'
                        ? 'ws-ticket-consumed'
                        : 'agent-ticket-consumed',
                );
                const accessToken = await this.resolveAccessToken(
                    receipt.sessionId,
                    receipt.accessTokenDigest,
                );
                return {
                    clientId: receipt.clientId,
                    username: receipt.username,
                    accessToken,
                    sessionId: receipt.sessionId,
                    issuedAtEpochMs: receipt.issuedAtEpochMs,
                    expiresAtEpochMs: receipt.expiresAtEpochMs,
                };
            }
            case 'issue-agent-tickets': {
                const receipt = requireResultKind(result, 'agent-tickets-issued');
                const bySession = new Map(
                    command.tickets.map((ticket) => [ticket.sessionId, ticket]),
                );
                return {
                    tickets: await Promise.all(receipt.tickets.map(async (ticket) => {
                        const identity = bySession.get(ticket.sessionId);
                        if (!identity || identity.agentId !== ticket.agentId) {
                            throw new Error('Auth agent ticket result identity differs');
                        }
                        const plaintext = await this.credentialIssuer.issueAgentTicket(
                            command.requestId,
                            ticket.agentId,
                            ticket.sessionId,
                        );
                        await requireCredentialDigest(plaintext, ticket.ticketDigest);
                        return {
                            agentId: ticket.agentId,
                            ticket: plaintext,
                            sessionId: ticket.sessionId,
                            expiresAtEpochMs: ticket.expiresAtEpochMs,
                        };
                    })),
                };
            }
        }
    }

    private async resolveAccessToken(
        sessionId: string,
        expectedDigest: string,
    ): Promise<string> {
        const derived = await this.credentialIssuer.issueAccessToken(sessionId);
        if (await hashAuthSecret(derived) === expectedDigest) return derived;
        throw new Error('Auth AppInbox result credential digest differs');
    }
}

export function toAuthAppInboxType(command: AuthMutationCommand): AppInboxType {
    switch (command.kind) {
        case 'register-user':
            return AppInboxType.AUTH_USER_REGISTER;
        case 'issue-session':
            return AppInboxType.AUTH_SESSION_ISSUE;
        case 'logout-session':
            return AppInboxType.AUTH_SESSION_LOGOUT;
        case 'issue-ws-ticket':
            return AppInboxType.AUTH_WS_TICKET_ISSUE;
        case 'consume-ws-ticket':
            return AppInboxType.AUTH_WS_TICKET_CONSUME;
        case 'issue-agent-tickets':
            return AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE;
        case 'consume-agent-ticket':
            return AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME;
    }
}

function toAuthCommandContextId(command: AuthMutationCommand): string {
    switch (command.kind) {
        case 'register-user':
            return command.user.normalizedUsername;
        case 'issue-session':
            return command.session.sessionId;
        case 'logout-session':
            return command.expected.sessionId;
        case 'issue-ws-ticket':
            return command.ticketRecord.sessionId;
        case 'consume-ws-ticket':
            return command.expectedSessionId;
        case 'issue-agent-tickets':
            return command.tickets.map((ticket) => ticket.sessionId).join(',');
        case 'consume-agent-ticket':
            return command.ticketDigest;
    }
}

function toAuthCommandSenderId(command: AuthMutationCommand): string {
    switch (command.kind) {
        case 'register-user':
            return command.user.clientId;
        case 'issue-session':
            return command.session.clientId;
        case 'logout-session':
            return command.expected.clientId;
        case 'issue-ws-ticket':
            return command.ticketRecord.clientId;
        case 'issue-agent-tickets':
            return command.authority.clientId;
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            return command.ticketDigest;
    }
}

function requireResultKind<K extends Extract<AuthMutationResult, { kind: string }>['kind']>(
    result: AuthMutationResult,
    kind: K,
): Extract<AuthMutationResult, { kind: K }> {
    if (typeof result !== 'object' || result === null || !('kind' in result) ||
        result.kind !== kind) {
        throw new Error(`Auth AppInbox result kind differs: ${kind}`);
    }
    return result as Extract<AuthMutationResult, { kind: K }>;
}

async function requireCredentialDigest(plaintext: string, expectedDigest: string): Promise<void> {
    if (await hashAuthSecret(plaintext) !== expectedDigest) {
        throw new Error('Auth AppInbox result credential digest differs');
    }
}
