import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { FriendsRepository } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { MatchmakingCommand } from '@shared-server/rallar-system/matchmaking/matchmaking-command.ts';
import { MatchmakingRepository } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { MatchmakingService } from '@shared-server/rallar-system/matchmaking/matchmaking-service.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { PartyCommand } from '@shared-server/rallar-system/parties/party-command.ts';
import { PartyService } from '@shared-server/rallar-system/parties/party-service.ts';
import { PartyRepository } from '@shared-server/rallar-system/parties/persistence/party-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import type { MatchmakingRequest } from '@shared/api/matchmaking/matchmaking-request.ts';
import type { PartyRequest } from '@shared/api/parties/party-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { expect } from 'vitest';
import type { ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createSqlServerAppInbox, type SqlServerAppInboxTestRuntime } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';

export const ref = { applicationId: 'game', workspaceId: 'default', partyId: 'party-one' };
export const policy = { maxMembers: 2, maxInvitations: 16, invitationLifetimeMs: 600000 };

export async function createRuntime(storage: ResourceInboxTestStorage, players: number = 2) {
    const fixture = new PartyServiceFixture(storage, players);
    await fixture.seedAccounts();
    fixture.queue.inbox.start();
    return fixture;
}

class PartyServiceFixture {
    readonly clock = { now: Date.now() };
    readonly timing: RallarTimingEvent[] = [];
    readonly runtime: PSqlRuntimeStateRepository;
    readonly queue: SqlServerAppInboxTestRuntime;
    readonly auth: AuthSessionRepository;
    readonly parties: PartyRepository;
    readonly matchmaking: MatchmakingRepository;
    readonly profiles: FriendsRepository;
    readonly clients: ClientStateRepository;
    readonly groups: GroupStateRepository;
    readonly sessions: readonly IssuedAuthSession[];
    readonly service: PartyService;
    readonly matchService: MatchmakingService;

    constructor(storage: ResourceInboxTestStorage, players: number) {
        this.runtime = new PSqlRuntimeStateRepository(storage.sql);
        this.queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => this.clock.now });
        this.auth = new AuthSessionRepository(this.runtime);
        this.parties = new PartyRepository(this.runtime, () => this.clock.now);
        this.matchmaking = new MatchmakingRepository(this.runtime);
        this.profiles = new FriendsRepository(this.runtime);
        this.clients = new ClientStateRepository(this.runtime, new PSqlClientStateEventRepository(storage.sql));
        this.groups = new GroupStateRepository(this.runtime, new PSqlGroupStateEventRepository(storage.sql));
        this.sessions = ['alice', 'bob', 'carol', 'dan'].slice(0, players).map((principalId) => ({
            clientId: principalId,
            username: principalId,
            sessionId: `session-${principalId}`,
            accessToken: `test-only-${principalId}`,
            issuedAtEpochMs: this.clock.now - 1000,
            expiresAtEpochMs: this.clock.now + 60000
        }));
        this.service = this.createPartyService(players);
        this.matchService = this.createMatchmakingService(players);
    }

    private createPartyService(players: number): PartyService {
        return new PartyService({
            appInbox: this.queue.inbox,
            parties: this.parties,
            matchmaking: this.matchmaking,
            profiles: this.profiles,
            authSessions: this.auth,
            clients: this.clients,
            nowEpochMs: () => this.clock.now,
            timing: (event) => this.timing.push(event)
        }, { serviceId: 'party-test', defaultPolicy: { ...policy, maxMembers: players }, policiesByApplication: {}, finishedRetentionMs: 60000 });
    }

    private createMatchmakingService(players: number): MatchmakingService {
        return new MatchmakingService({
            appInbox: this.queue.inbox,
            repository: this.matchmaking,
            parties: this.parties,
            clients: this.clients,
            authSessions: this.auth,
            groups: this.groups,
            nowEpochMs: () => this.clock.now,
            timing: undefined
        }, {
            serviceId: 'party-test',
            finishedRetentionMs: 60000,
            policiesByApplication: {},
            defaultPolicy: { players, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 }
        });
    }

    async seedAccounts(): Promise<void> {
        for (const session of this.sessions) {
            await this.auth.putSession(session);
            const principalId = session.clientId;
            await this.seedClientIdentity(principalId);
            await this.seedClientSession(session);
            await this.runtime.upsert(
                'friends:profiles',
                `principal=${principalId}`,
                JSON.stringify({
                    principalId,
                    shareOnline: false,
                    contacts: ['alice', 'bob'].includes(principalId) ? [{ principalId: principalId === 'alice' ? 'bob' : 'alice', status: 'friend' }] : [],
                    invitations: []
                }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
        }
    }

    private async seedClientIdentity(principalId: string): Promise<void> {
        const audit = {
            atEpochMs: this.clock.now - 1000,
            actor: { kind: 'service' as const, serviceId: 'party-test' },
            reason: null,
            traceId: null,
            requestId: null
        };
        const principal: ClientPrincipal = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: this.clock.now - 1000,
            status: 'active',
            disabled: null,
            deleted: null
        };
        await this.clients.insertPrincipal(principal);
        await this.clients.insertInstance({
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId,
            clientInstanceId: `browser-${principalId}`,
            platform: 'web',
            deviceLabel: null,
            appVersion: null,
            userAgent: null,
            capabilities: [],
            registered: audit,
            updated: audit,
            status: 'active',
            revoked: null
        });
    }

    private async seedClientSession(session: IssuedAuthSession): Promise<void> {
        const principalId = session.clientId;
        const presence: ClientSession = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId,
            clientInstanceId: `browser-${principalId}`,
            sessionId: session.sessionId,
            generationId: `generation-${principalId}`,
            generationVersion: 1,
            presenceState: 'online',
            transport: 'http',
            connectionId: null,
            authenticatedAtEpochMs: session.issuedAtEpochMs,
            connectedAtEpochMs: session.issuedAtEpochMs,
            lastHeartbeatAtEpochMs: session.issuedAtEpochMs,
            expiresAtEpochMs: session.expiresAtEpochMs,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        };
        await this.clients.insertSession(presence);
    }

    command(principalId: string, requestId: string, request: PartyRequest): PartyCommand {
        const session = this.sessions.find((candidate) => candidate.clientId === principalId)!;
        return {
            principalId,
            sessionId: session.sessionId,
            sessionIssuedAtEpochMs: session.issuedAtEpochMs,
            sessionExpiresAtEpochMs: session.expiresAtEpochMs,
            requestId,
            request,
            capturedAtEpochMs: null,
            policy: null
        };
    }
    matchCommand(principalId: string, requestId: string, request: MatchmakingRequest): MatchmakingCommand {
        const session = this.sessions.find((candidate) => candidate.clientId === principalId)!;
        return {
            scope: { applicationId: ref.applicationId, workspaceId: ref.workspaceId },
            principalId,
            sessionId: session.sessionId,
            sessionIssuedAtEpochMs: session.issuedAtEpochMs,
            sessionExpiresAtEpochMs: session.expiresAtEpochMs,
            requestId,
            request,
            capturedAtEpochMs: null,
            policy: null,
            serviceId: null
        };
    }

    runMatch(input: MatchmakingCommand) {
        return runPartyFixtureCommand(this.queue, this.matchService.mutate, input);
    }

    run(input: PartyCommand) {
        return runPartyFixtureCommand(this.queue, this.service.mutate, input);
    }
}

async function runPartyFixtureCommand<Command extends { readonly requestId: string; }, Result>(
    queue: SqlServerAppInboxTestRuntime,
    operation: RallarServerAppInbox.Operation<Command, Result>,
    input: Command
): Promise<Result | undefined> {
    const enqueued = await operation.enqueue({ command: input, traceId: input.requestId });
    expect(enqueued.left).toBeUndefined();
    await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
    const result = await enqueued.right!.wait();
    expect(result.left).toBeUndefined();
    return result.right;
}
