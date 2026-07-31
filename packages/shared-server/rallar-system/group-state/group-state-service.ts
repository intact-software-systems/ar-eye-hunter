import type {
  GroupMutationCommand,
  GroupMutationComputedWrite,
  GroupMutationFacts,
} from '../services/group-state-mutations.ts';
import {
  computeGroupMutation,
  validateGroupMutation,
  validateGroupMutationCommand,
} from '../services/group-state-mutations.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import { readGroupMutation } from '../services/group-state-mutation-read.ts';
import { writeGroupMutation } from '../services/group-state-guarded-batch.ts';
import { createWsSessionGenerationLifecycleService } from '../services/ws-session-generation-lifecycle.ts';
import { readGroupSessionCleanupCandidates } from '../services/group-session-cleanup.ts';
import { type RallarTimingSink, timeRallarAsync } from '../services/timing.ts';
import { hashMutationCommand, type JsonWireValue } from '../services/mutation-command-identity.ts';
import { sha256CanonicalJson } from '../services/group-state-crypto.ts';
import {
  prepareGroupMutation,
  type GroupMutationAuthorityDependencies,
  GroupMutationAuthorizationError,
  verifyPreparedGroupMutationAuthority,
} from './group-mutation-authority.ts';
import { toExpiryCommand, toSessionCleanupCommand } from './group-presence-mutation-command.ts';
import {
  GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
  type GroupMutationDescriptor,
  type GroupMutationPreparation,
  type GroupStateRuntime,
  type GroupStateService,
  type GroupStateServiceDependencies,
  type GroupStateMutationCommand,
} from './group-state-service-contracts.ts';

export class GroupMutationIdempotencyConflictError extends Error {
  readonly status = 409;
  readonly code = 'group-mutation-idempotency-conflict';

  constructor(
    readonly commandId: string,
    readonly existingCommandHash: string,
    readonly receivedCommandHash: string,
  ) {
    super(`Group mutation command differs for request ${commandId}`);
    this.name = 'GroupMutationIdempotencyConflictError';
  }
}

export function createGroupStateRuntime(
  dependencies: GroupStateServiceDependencies,
): GroupStateRuntime {
  if (
    !dependencies.authSessionRepository ||
    typeof dependencies.authSessionRepository.findBySessionId !== 'function'
  ) {
    throw new GroupMutationAuthorizationError(
      'An auth session repository is required for group mutations.',
    );
  }
  const runtime = dependencies.runtimeRepository;
  const now = dependencies.now ?? (() => Date.now());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const repositoryFor: GroupStateRepositoryFactory = (target) =>
    new GroupStateRepository(target, {
      events: dependencies.createGroupStateEventStore?.(target),
    });
  const owners: GroupStateRuntimeOwners = {
    dependencies,
    repositoryFor,
    authorityDependencies: createAuthorityDependencies(dependencies, repositoryFor, now, randomId),
    prepareInternalMutation: createInternalMutationPreparer(dependencies),
  };
  const service: GroupStateService = {
    sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtime),
    ...createPreparationOperations(owners),
    ...createQueryOperations(owners),
    ...createMutationOperations(owners),
  };
  return {
    service: withGroupStateServiceTiming(service, dependencies.timing, dependencies.serviceId),
  };
}

type GroupStateRepositoryFactory = (
  target: GroupStateServiceDependencies['runtimeRepository'],
) => GroupStateRepository;

type InternalMutationPreparer = (
  command: GroupMutationCommand,
  authority: Exclude<GroupMutationFacts['internalAuthority'], 'none'>,
  atEpochMs: number,
) => Promise<GroupMutationPreparation>;

interface GroupStateRuntimeOwners {
  readonly dependencies: GroupStateServiceDependencies;
  readonly repositoryFor: GroupStateRepositoryFactory;
  readonly authorityDependencies: GroupMutationAuthorityDependencies;
  readonly prepareInternalMutation: InternalMutationPreparer;
}

function createAuthorityDependencies(
  dependencies: GroupStateServiceDependencies,
  repositoryFor: GroupStateRepositoryFactory,
  now: () => number,
  randomId: () => string,
): GroupMutationAuthorityDependencies {
  return {
    authSessionRepository: dependencies.authSessionRepository,
    now,
    randomId,
    serviceId: dependencies.serviceId,
    readCausalRevision: async (ref) =>
      await repositoryFor(dependencies.runtimeRepository).readCausalRevision(ref),
  };
}

function createInternalMutationPreparer(
  dependencies: GroupStateServiceDependencies,
): InternalMutationPreparer {
  return async (command, internalAuthority, atEpochMs) => {
    validateGroupMutationCommand(command);
    const commandHash = await hashMutationCommand(command as JsonWireValue);
    const facts: Omit<GroupMutationFacts, 'attemptCount'> = {
      nowEpochMs: atEpochMs,
      expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
      serviceId: dependencies.serviceId,
      eventId: `group-event:${commandHash.slice('sha256:'.length)}`,
      commandHash,
      resolvedJoinCode: null,
      joinCodeVerifier: null,
      internalAuthority,
      authenticatedAuthority: null,
    };
    const causalToken = await sha256CanonicalJson({ command, facts });
    return {
      authorityProof: null,
      descriptor: null,
      command,
      facts,
      causalToken,
      queueResourceId: `g-${causalToken.slice('sha256:'.length, 34)}`,
    };
  };
}

function createPreparationOperations(
  owners: GroupStateRuntimeOwners,
): Pick<
  GroupStateService,
  'prepareMutation' | 'prepareExpiredPresenceMutations' | 'prepareSessionCleanupMutations'
> {
  const { dependencies, repositoryFor, authorityDependencies, prepareInternalMutation } = owners;
  const runtime = dependencies.runtimeRepository;
  return {
    prepareMutation: async (descriptor, authority) =>
      await prepareGroupMutation(authorityDependencies, descriptor, authority),
    prepareExpiredPresenceMutations: async (atEpochMs) => {
      const candidates = (await repositoryFor(runtime).listAllPresenceSessions()).filter(
        (session) =>
          session.disconnectedAtEpochMs === null && session.expiresAtEpochMs <= atEpochMs,
      );
      return await Promise.all(
        candidates.map((session) =>
          prepareInternalMutation(toExpiryCommand(session, atEpochMs), 'expiry', atEpochMs),
        ),
      );
    },
    prepareSessionCleanupMutations: async (input) => {
      const candidates = await readGroupSessionCleanupCandidates(
        repositoryFor(runtime),
        dependencies.authSessionRepository,
        input,
      );
      return await Promise.all(
        candidates.map((session) =>
          prepareInternalMutation(
            toSessionCleanupCommand(session, input.disconnectedAtEpochMs),
            'session-cleanup',
            input.disconnectedAtEpochMs,
          ),
        ),
      );
    },
  };
}

function createQueryOperations(
  owners: GroupStateRuntimeOwners,
): Pick<
  GroupStateService,
  | 'listSnapshots'
  | 'listSnapshotsPage'
  | 'readSnapshot'
  | 'readStateRevision'
  | 'readCausalRevision'
  | 'readIssuedAuthSession'
  | 'listEvents'
  | 'listRecentEvents'
  | 'listEventPage'
  | 'observeSnapshot'
> {
  const { dependencies, repositoryFor } = owners;
  const runtime = dependencies.runtimeRepository;
  return {
    listSnapshots: async (scope) => await repositoryFor(runtime).listSnapshots(scope),
    listSnapshotsPage: async (scope, options) =>
      await repositoryFor(runtime).listSnapshotsPage(scope, options),
    readSnapshot: async (ref) => await repositoryFor(runtime).readSnapshot(ref),
    readStateRevision: async (ref) => await repositoryFor(runtime).readStateRevision(ref),
    readCausalRevision: async (ref) => await repositoryFor(runtime).readCausalRevision(ref),
    readIssuedAuthSession: async (sessionId) =>
      await dependencies.authSessionRepository.findBySessionId(sessionId),
    listEvents: async (ref) => await repositoryFor(runtime).listEvents(ref),
    listRecentEvents: async (ref, query) =>
      await repositoryFor(runtime).listRecentEvents(ref, query),
    listEventPage: async (ref, query) => await repositoryFor(runtime).listEventPage(ref, query),
    observeSnapshot: (snapshot) => Promise.resolve(snapshot),
  };
}

function createMutationOperations(
  owners: GroupStateRuntimeOwners,
): Pick<GroupStateService, 'read' | 'compute' | 'validate' | 'write'> {
  const { dependencies, repositoryFor, authorityDependencies } = owners;
  const runtime = dependencies.runtimeRepository;
  return {
    read: async (prepared) => {
      if (prepared.facts.internalAuthority !== 'none') {
        if (
          prepared.authorityProof !== null ||
          prepared.descriptor !== null ||
          prepared.facts.authenticatedAuthority !== null
        ) {
          throw new GroupMutationAuthorizationError(
            'Internal group mutation authority is malformed.',
          );
        }
        return await readGroupMutation(repositoryFor(runtime), prepared.command);
      }
      await verifyPreparedGroupMutationAuthority(authorityDependencies, prepared);
      return await readGroupMutation(repositoryFor(runtime), prepared.command);
    },
    compute: (prepared, read) =>
      computeGroupMutation({ command: prepared.command, read, facts: prepared.facts }),
    validate: (prepared, read, computed) => {
      validateGroupMutation({
        command: prepared.command,
        read,
        facts: prepared.facts,
        computed,
      });
      if (computed.outcome === 'idempotency-conflict') {
        throw new GroupMutationIdempotencyConflictError(
          prepared.command.commandId,
          computed.existingCommandHash,
          computed.receivedCommandHash,
        );
      }
    },
    write: async (transaction, computed) => await writeGroupMutation(transaction, computed),
  };
}

export function createGroupStateService(
  dependencies: GroupStateServiceDependencies,
): GroupStateService {
  return createGroupStateRuntime(dependencies).service;
}

function withGroupStateServiceTiming(
  service: GroupStateService,
  timing: RallarTimingSink | undefined,
  serviceId: string,
): GroupStateService {
  if (!timing) return service;
  const timed = <T>(
    operation: string,
    details: Record<string, unknown>,
    action: () => Promise<T>,
  ) =>
    timeRallarAsync(
      timing,
      {
        component: 'group-state-service',
        operation,
        serviceId,
        requestId: typeof details.requestId === 'string' ? details.requestId : undefined,
        applicationId:
          typeof details.applicationId === 'string' ? details.applicationId : undefined,
        workspaceId: typeof details.workspaceId === 'string' ? details.workspaceId : undefined,
        groupId: typeof details.groupId === 'string' ? details.groupId : undefined,
        principalId:
          typeof details.principalId === 'string'
            ? details.principalId
            : typeof details.actorPrincipalId === 'string'
              ? details.actorPrincipalId
              : typeof details.createdByPrincipalId === 'string'
                ? details.createdByPrincipalId
                : undefined,
        sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
      },
      action,
    );
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'compute' || property === 'validate') return value.bind(target);
      return (...args: unknown[]) => {
        const first = args[0];
        const phaseCommand =
          first &&
          typeof first === 'object' &&
          'command' in first &&
          first.command &&
          typeof first.command === 'object'
            ? (first.command as GroupMutationCommand)
            : undefined;
        const scope =
          phaseCommand?.aggregateRef ??
          (first && typeof first === 'object'
            ? (first as GroupMutationDescriptor['scope'])
            : undefined);
        const request = args.findLast((candidate) =>
          Boolean(candidate && typeof candidate === 'object' && 'requestId' in candidate),
        );
        const requestRecord =
          request && typeof request === 'object' ? (request as Record<string, unknown>) : {};
        return timed(
          String(property),
          {
            ...(scope ?? {}),
            requestId: phaseCommand?.requestId ?? undefined,
            groupId:
              phaseCommand?.aggregateRef.groupId ??
              (typeof args[1] === 'string' ? args[1] : requestRecord.groupId),
            sessionId: typeof args[2] === 'string' ? args[2] : undefined,
            ...requestRecord,
          },
          () => value.apply(target, args),
        );
      };
    },
  });
}

void (null as GroupStateMutationCommand | null);
void (null as GroupMutationComputedWrite | null);
