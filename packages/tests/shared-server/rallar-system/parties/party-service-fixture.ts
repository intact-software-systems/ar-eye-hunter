import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
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
import { createSqlServerAppInbox } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';

export const ref = { applicationId: 'game', workspaceId: 'default', partyId: 'party-one' };
export const policy = { maxMembers: 2, maxInvitations: 16, invitationLifetimeMs: 600000 };

export async function createRuntime(storage: ResourceInboxTestStorage, players: number = 2) {
    const clock = { now: Date.now() };
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => clock.now });
    const auth = new AuthSessionRepository(runtime);
    const parties = new PartyRepository(runtime, () => clock.now);
    const matchmaking = new MatchmakingRepository(runtime);
    const profiles = new FriendsRepository(runtime);
    const clients = new ClientStateRepository(runtime, new PSqlClientStateEventRepository(storage.sql));
    const sessions = ['alice', 'bob', 'carol', 'dan'].slice(0, players).map((principalId) => ({
        clientId: principalId,
        username: principalId,
        sessionId: `session-${principalId}`,
        accessToken: `test-only-${principalId}`,
        issuedAtEpochMs: clock.now - 1000,
        expiresAtEpochMs: clock.now + 60000
    }));
    for (const session of sessions) {
        await auth.putSession(session);
        const principalId = session.clientId;
        const audit = {
            atEpochMs: clock.now - 1000,
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
            lastSeenAtEpochMs: clock.now - 1000,
            status: 'active',
            disabled: null,
            deleted: null
        };
        await clients.insertPrincipal(principal);
        await clients.insertInstance({
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
        await clients.insertSession(presence);
        await runtime.upsert(
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
    const timing: RallarTimingEvent[] = [];
    const service = new PartyService({
        appInbox: queue.inbox,
        parties,
        matchmaking,
        profiles,
        authSessions: auth,
        clients,
        nowEpochMs: () => clock.now,
        timing: (event) => timing.push(event)
    }, { defaultPolicy: { ...policy, maxMembers: players }, policiesByApplication: {}, finishedRetentionMs: 60000 });
    const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(storage.sql));
    const matchService = new MatchmakingService({
        appInbox: queue.inbox,
        repository: matchmaking,
        parties,
        clients,
        authSessions: auth,
        groups,
        nowEpochMs: () => clock.now,
        timing: undefined
    }, {
        serviceId: 'party-test',
        finishedRetentionMs: 60000,
        policiesByApplication: {},
        defaultPolicy: { players, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 }
    });
    queue.inbox.start();
    function command(principalId: string, requestId: string, request: PartyRequest): PartyCommand {
        const session = sessions.find((candidate) => candidate.clientId === principalId)!;
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
    function matchCommand(principalId: string, requestId: string, request: MatchmakingRequest): MatchmakingCommand {
        const session = sessions.find((candidate) => candidate.clientId === principalId)!;
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
    async function runMatch(input: MatchmakingCommand) {
        const enqueued = await matchService.mutate.enqueue({ command: input, traceId: input.requestId });
        expect(enqueued.left).toBeUndefined();
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        const result = await enqueued.right!.wait();
        expect(result.left).toBeUndefined();
        return result.right;
    }
    async function run(input: PartyCommand) {
        const enqueued = await service.mutate.enqueue({ command: input, traceId: input.requestId });
        expect(enqueued.left).toBeUndefined();
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        const result = await enqueued.right!.wait();
        expect(result.left).toBeUndefined();
        return result.right;
    }
    return {
        clock,
        runtime,
        queue,
        auth,
        parties,
        matchmaking,
        matchService,
        matchCommand,
        runMatch,
        groups,
        profiles,
        clients,
        sessions,
        service,
        command,
        run,
        timing
    };
}
