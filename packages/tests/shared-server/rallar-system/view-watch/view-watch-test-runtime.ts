import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { GroupSessionDeadlineService } from '@shared-server/rallar-system/group-state/schedule/group-session-deadline-service.ts';
import { GroupSessionViewWatch } from '@shared-server/rallar-system/group-state/schedule/group-session-view-watch.ts';
import { TournamentRepository } from '@shared-server/rallar-system/tournaments/tournament-repository.ts';
import { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import { TournamentViewWatch } from '@shared-server/rallar-system/tournaments/tournament-view-watch.ts';
import type { ViewWatchCommand } from '@shared-server/rallar-system/view-watch/view-watch-command.ts';
import { ViewWatchRepository } from '@shared-server/rallar-system/view-watch/view-watch-repository.ts';
import { ViewWatchService } from '@shared-server/rallar-system/view-watch/view-watch-service.ts';
import type { ViewWatchResult } from '@shared/api/views/view-watch.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createTestGroup } from '../../../create-test-group.ts';
import type { ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { PartyServiceFixture } from '../parties/party-service-fixture.ts';

export const scope = { applicationId: 'game', workspaceId: 'default' };
export const ref = { ...scope, groupId: 'unlisted-schedule' };
export const sessionWatchResource = { ...scope, family: 'session-preview' as const, resourceId: ref.groupId };

export interface ViewWatchTestRuntime {
    readonly party: PartyServiceFixture;
    readonly repository: ViewWatchRepository;
    readonly service: ViewWatchService;
    readonly deadlines: GroupSessionDeadlineService;
    readonly tournaments: TournamentRepository;
    readonly tournamentService: TournamentService;
    run(command: ViewWatchCommand): Promise<ViewWatchResult>;
}

export async function createViewWatchTestRuntime(storage: ResourceInboxTestStorage): Promise<ViewWatchTestRuntime> {
    const party = new PartyServiceFixture(storage, 2);
    await party.seedAccounts();
    const current = (await party.clients.findSessionEntry({ ...scope, principalId: 'bob', clientInstanceId: 'browser-bob', sessionId: 'session-bob' }))!;
    await party.clients.updateSession({ ...current.value, transport: 'ws', connectionId: 'generation-bob' }, current.entry.revision);
    await party.groups.putGroup(createTestGroup({
        ...ref,
        maxMembers: 2,
        metadata: {
            rallarRetention: { mode: 'temporary', reconnectGraceMs: 600000, emptyPresenceFingerprint: null },
            rallarSessionSchedule: { revision: 1, startsAtEpochMs: party.clock.now + 3600000, cancelledAtEpochMs: null }
        }
    }));
    const repository = new ViewWatchRepository(party.runtime);
    const service = new ViewWatchService({
        appInbox: party.queue.inbox,
        repository,
        clients: party.clients,
        authorizers: { 'session-preview': new GroupSessionViewWatch(party.groups), tournament: new TournamentViewWatch(party.runtime) },
        nowEpochMs: () => party.clock.now
    });
    const deadlines = new GroupSessionDeadlineService({
        appInbox: party.queue.inbox,
        groups: party.groups,
        runtime: party.runtime,
        nowEpochMs: () => party.clock.now,
        serviceId: 'watch-test',
        retentionMs: 60000
    });
    const tournaments = new TournamentRepository(party.runtime);
    const tournamentService = new TournamentService({ repository: tournaments, sessions: new AuthSessionPersistence(party.runtime), groups: party.groups }, {
        profiles: [{ scope, rulesId: 'watch-native', noShowGraceMs: 60000, gameLifecycleTopic: 'app:test:native' }],
        nowEpochMs: () => party.clock.now,
        createId: () => crypto.randomUUID(),
        serviceId: 'watch-test',
        finishedRetentionMs: 60000
    });
    party.queue.inbox.start();
    return {
        party,
        repository,
        service,
        deadlines,
        tournaments,
        tournamentService,
        async run(command) {
            const admission = await service.mutate.enqueue({ command, traceId: 'watch-test' });
            await party.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const result = await admission.right!.wait();
            if (result.left !== undefined) {
                throw result.left;
            }
            return result.right!;
        }
    };
}

export function viewWatchCommand(test: ViewWatchTestRuntime, requestId: string, expectedRegistrationId: string | null): ViewWatchCommand {
    const session = test.party.sessions.find((session) => session.clientId === 'bob')!;
    return {
        scope,
        family: 'session-preview',
        principalId: 'bob',
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        requestId,
        request: { resourceId: ref.groupId, connectionGenerationId: 'generation-bob', expectedRegistrationId }
    };
}
