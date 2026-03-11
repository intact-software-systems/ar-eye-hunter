import type { AuthSession } from '@shared/api/api-config.ts';
import {
    isRuntimeStateTransactionalRepositoryLike,
    type RuntimeStateRepositoryLike,
} from './RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from './RuntimeStateJsonStore.ts';

const AUTH_SESSIONS_BY_TOKEN_NAMESPACE = 'auth-sessions:by-token';
const AUTH_SESSIONS_BY_SESSION_NAMESPACE = 'auth-sessions:by-session';
const WS_AUTH_TICKETS_NAMESPACE = 'auth-sessions:ws-tickets';

export type IssuedAuthSession =
    & AuthSession
    & Readonly<{
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type IssuedWebSocketTicket = Readonly<{
    ticket: string;
    sessionId: string;
    clientId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export class AuthSessionRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putSession(session: IssuedAuthSession): Promise<void> {
        await this.putValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(session.accessToken),
            session,
            session.expiresAtEpochMs,
        );
        await this.putValue(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(session.sessionId),
            session,
            session.expiresAtEpochMs,
        );
    }

    async findByAccessToken(
        accessToken: string,
    ): Promise<IssuedAuthSession | undefined> {
        return await this.getValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessToken),
        );
    }

    async findBySessionId(
        sessionId: string,
    ): Promise<IssuedAuthSession | undefined> {
        return await this.getValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(sessionId),
        );
    }

    async deleteSession(session: IssuedAuthSession): Promise<void> {
        await this.deleteValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(session.accessToken),
        );
        await this.deleteValue(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(session.sessionId),
        );
    }

    async putWebSocketTicket(ticket: IssuedWebSocketTicket): Promise<void> {
        await this.putValue(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticket.ticket),
            ticket,
            ticket.expiresAtEpochMs,
        );
    }

    async consumeWebSocketTicket(
        ticket: string,
    ): Promise<IssuedAuthSession | undefined> {
        const ticketKey = this.ticketKey(ticket);

        if (isRuntimeStateTransactionalRepositoryLike(this.repository)) {
            return await this.repository.begin(async (repository) => {
                await repository.lockKey(WS_AUTH_TICKETS_NAMESPACE, ticketKey);
                return await new AuthSessionRepository(repository)
                    .consumeWebSocketTicketByKey(ticketKey);
            });
        }

        return await this.consumeWebSocketTicketByKey(ticketKey);
    }

    private async consumeWebSocketTicketByKey(
        ticketKey: string,
    ): Promise<IssuedAuthSession | undefined> {
        const issuedTicket = await this.getValue<IssuedWebSocketTicket>(
            WS_AUTH_TICKETS_NAMESPACE,
            ticketKey,
        );

        if (!issuedTicket) {
            return undefined;
        }

        await this.deleteValue(WS_AUTH_TICKETS_NAMESPACE, ticketKey);

        const session = await this.findBySessionId(issuedTicket.sessionId);
        if (!session || session.clientId !== issuedTicket.clientId) {
            return undefined;
        }

        return session;
    }

    private tokenKey(accessToken: string): string {
        return this.idKey('token', accessToken);
    }

    private sessionKey(sessionId: string): string {
        return this.idKey('session', sessionId);
    }

    private ticketKey(ticket: string): string {
        return this.idKey('ticket', ticket);
    }
}
