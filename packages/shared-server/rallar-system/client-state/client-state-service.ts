import type { ClientSession } from '@shared/api/client-types.ts';
import {
  ClientStateRepository,
  createTransactionBoundClientStateRepository,
} from './persistence/client-state-repository.ts';
import { toClientSessionExpiryCandidate } from '../repositories/session-expiry.ts';
import { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import { computeClientMutation } from './mutation/compute/compute-client-mutation.ts';
import { readClientMutation } from './mutation/read/read-client-mutation.ts';
import { validateClientMutation } from './mutation/result-validation/validate-client-mutation.ts';
import { writeClientMutation } from './mutation/write/write-client-mutation.ts';
import {
  type ClientStateService,
  type ClientStateServiceDependencies,
} from './client-state-service-contracts.ts';
import { createTimedClientStateService } from './client-state-service-timing.ts';
// prettier-ignore
import {
  createWsSessionGenerationLifecycleService,
} from '../services/ws-session-generation-lifecycle.ts';

export function createClientStateService(
  dependencies: ClientStateServiceDependencies,
): ClientStateService {
  const runtimeRepository = dependencies.runtimeRepository;
  const authSessionRepository = new AuthSessionRepository(runtimeRepository);
  const repositoryFor = (runtime: typeof runtimeRepository) =>
    new ClientStateRepository(runtime, {
      events: dependencies.createClientStateEventStore?.(runtime),
    });
  const service: ClientStateService = {
    sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtimeRepository),
    listSnapshots: async (scope) => await repositoryFor(runtimeRepository).listSnapshots(scope),
    readSnapshot: async (ref) => await repositoryFor(runtimeRepository).readSnapshot(ref),
    readPresenceSnapshot: async (ref) =>
      await repositoryFor(runtimeRepository).readPresenceSnapshot(ref),
    listEvents: async (ref) => await repositoryFor(runtimeRepository).listEvents(ref),
    listRecentEvents: async (ref, query) =>
      await repositoryFor(runtimeRepository).listRecentEvents(ref, query),
    listEventPage: async (ref, query) =>
      await repositoryFor(runtimeRepository).listEventPage(ref, query),
    read: async (command) =>
      await readClientMutation(repositoryFor(runtimeRepository), authSessionRepository, command),
    compute: (command, read) => computeClientMutation({ command, read }),
    validate: (command, read, computed) => validateClientMutation({ command, read, computed }),
    write: async (transaction, computed) =>
      await writeClientMutation(
        transaction,
        createTransactionBoundClientStateRepository(transaction),
        computed,
      ),
    listExpiredSessionCandidates: async (atEpochMs) =>
      (await repositoryFor(runtimeRepository).listAllSessions())
        .filter(isExpiredActiveSession(atEpochMs))
        .map(toClientSessionExpiryCandidate),
    findSessionBySessionId: async (sessionId) =>
      await findClientSessionBySessionId(repositoryFor(runtimeRepository), sessionId),
    readIssuedAuthSession: async (sessionId) =>
      await authSessionRepository.findBySessionId(sessionId),
    observeSnapshot: async (snapshot) => snapshot,
  };

  return createTimedClientStateService({
    service,
    timing: dependencies.timing,
    serviceId: dependencies.serviceId,
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
  sessionId: string,
): Promise<ClientSession | undefined> {
  const sessions = await repository.listAllSessions();
  return (
    sessions.find(
      (session) =>
        session.sessionId === sessionId &&
        session.status === 'active' &&
        session.disconnectedAtEpochMs === null,
    ) ?? sessions.find((session) => session.sessionId === sessionId)
  );
}
