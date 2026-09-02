import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import { toClientSessionExpiryCandidate } from '../presence/session-expiry.ts';
import { createWsSessionGenerationLifecycleService } from '../websocket/ws-session-generation-lifecycle.ts';
import { type ClientStateService, type ClientStateServiceDependencies } from './client-state-service-contracts.ts';
import { createTimedClientStateService } from './client-state-service-timing.ts';
import { computeClientMutation } from './mutation/compute/compute-client-mutation.ts';
import { readClientMutation } from './mutation/read-client-mutation.ts';
import { validateClientMutation } from './mutation/result-validation/validate-client-mutation.ts';
import { writeClientMutation } from './mutation/write-client-mutation.ts';
import {
    ClientStateRepository,
    createTransactionBoundClientStateRepository
} from './persistence/client-state-repository.ts';

export function createClientStateService(
    dependencies: ClientStateServiceDependencies
): ClientStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const authSessionRepository = new AuthSessionRepository(runtimeRepository);
    const repository = new ClientStateRepository(runtimeRepository, dependencies.clientStateEventStore);
    const service: ClientStateService = {
        mutationTiming: { sink: dependencies.timing, serviceId: dependencies.serviceId },
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtimeRepository),
        listSnapshots: async (scope) => await repository.listSnapshots(scope),
        readSnapshot: async (ref) => await repository.readSnapshot(ref),
        readPresenceSnapshot: async (ref) => await repository.readPresenceSnapshot(ref),
        listEvents: async (ref) => await repository.listEvents(ref),
        listRecentEvents: async (ref, query) => await repository.listRecentEvents(ref, query),
        listEventPage: async (ref, query) => await repository.listEventPage(ref, query),
        read: async (command) => await readClientMutation(repository, authSessionRepository, command),
        compute: (command, read) => computeClientMutation({ command, read }),
        validate: (command, read, computed) => validateClientMutation({ command, read, computed }),
        write: async (transaction, computed) =>
            await writeClientMutation(
                transaction,
                createTransactionBoundClientStateRepository(transaction),
                computed
            ),
        listExpiredSessionCandidates: async (atEpochMs) =>
            (await repository.listAllSessions())
                .filter(isExpiredActiveSession(atEpochMs))
                .map(toClientSessionExpiryCandidate),
        findSessionBySessionId: async (sessionId) => await findClientSessionBySessionId(repository, sessionId),
        readIssuedAuthSession: async (sessionId) => await authSessionRepository.findBySessionId(sessionId),
        observeSnapshot: async (snapshot) => snapshot
    };

    return createTimedClientStateService({
        service,
        timing: dependencies.timing,
        serviceId: dependencies.serviceId
    });
}

export type ClientStateServiceFactory = typeof createClientStateService;

function isExpiredActiveSession(atEpochMs: number): (session: ClientSession) => boolean {
    return (session) =>
        session.status === 'active' &&
        session.disconnectedAtEpochMs === null &&
        session.expiresAtEpochMs <= atEpochMs;
}

async function findClientSessionBySessionId(
    repository: ClientStateRepository,
    sessionId: string
): Promise<ClientSession | undefined> {
    const sessions = await repository.listAllSessions();
    return (
        sessions.find(
            (session) =>
                session.sessionId === sessionId &&
                session.status === 'active' &&
                session.disconnectedAtEpochMs === null
        ) ?? sessions.find((session) => session.sessionId === sessionId)
    );
}
