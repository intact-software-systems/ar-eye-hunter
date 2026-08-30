import { sha256CanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue, hashMutationCommand } from '../protocol/json-wire-identity.ts';
import { createWsSessionGenerationLifecycleService } from '../websocket/ws-session-generation-lifecycle.ts';
import {
    authorizeGroupMutation,
    GroupMutationAuthorizationError,
    prepareAppInboxGroupMutation,
    prepareGroupMutation,
    verifyPreparedGroupMutationAuthority,
    type GroupMutationAuthorityDependencies
} from './group-mutation-authority.ts';
import { toExpiryCommand, toSessionCleanupCommand } from './group-presence-mutation-command.ts';
import {
    GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
    type GroupMutationPreparation,
    type GroupStateMutationCommand,
    type GroupStateRuntime,
    type GroupStateService,
    type GroupStateServiceDependencies
} from './group-state-service-contracts.ts';
import { createTimedGroupStateService } from './group-state-service-timing.ts';
import { assertGroupMutationAuthority } from './mutation/command-validation/assert-group-mutation-authority.ts';
import { validateGroupMutationCommand } from './mutation/command-validation/validate-group-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from './mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from './mutation/orchestration/compute-group-mutation.ts';
import { readsAcceptedLayoutRow, readsGroupLayoutRows } from './mutation/read/group-mutation-read-scope.ts';
import { readGroupMutation } from './mutation/read/read-group-mutation.ts';
import { assertGroupMutation } from './mutation/state-validation/assert-group-mutation.ts';
import { writeGroupMutation } from './mutation/write/write-group-mutation.ts';
import { GroupConnectTriggerLatchRepository } from './persistence/group-connect-trigger-latch-repository.ts';
import { GroupStateRepository } from './persistence/group-state-repository.ts';
import { readGroupSessionCleanupCandidates } from './presence/group-session-cleanup.ts';

export class GroupMutationIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'group-mutation-idempotency-conflict';

    readonly commandId: string;
    readonly existingCommandHash: string;
    readonly receivedCommandHash: string;

    constructor(commandId: string, existingCommandHash: string, receivedCommandHash: string) {
        super(`Group mutation command differs for request ${commandId}`);
        this.commandId = commandId;
        this.existingCommandHash = existingCommandHash;
        this.receivedCommandHash = receivedCommandHash;
        this.name = 'GroupMutationIdempotencyConflictError';
    }
}

export function createGroupStateRuntime(
    dependencies: GroupStateServiceDependencies
): GroupStateRuntime {
    if (
        !dependencies.authSessionRepository ||
        typeof dependencies.authSessionRepository.findBySessionId !== 'function'
    ) {
        throw new GroupMutationAuthorizationError(
            'An auth session repository is required for group mutations.'
        );
    }
    const runtime = dependencies.runtimeRepository;
    const now = dependencies.now ?? (() => Date.now());
    const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    const repositoryFor: GroupStateRepositoryFactory = (target) =>
        new GroupStateRepository(target, dependencies.groupStateEventStore);
    const owners: GroupStateRuntimeOwners = {
        dependencies,
        repositoryFor,
        authorityDependencies: createAuthorityDependencies({ dependencies, repositoryFor, now, randomId }),
        prepareInternalMutation: createInternalMutationPreparer(dependencies)
    };
    const service: GroupStateService = {
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtime),
        ...createPreparationOperations(owners),
        ...createQueryOperations(owners),
        ...createMutationOperations(owners)
    };
    return {
        service: createTimedGroupStateService({
            service,
            timing: dependencies.timing,
            serviceId: dependencies.serviceId
        })
    };
}

type GroupStateRepositoryFactory = (
    target: GroupStateServiceDependencies['runtimeRepository']
) => GroupStateRepository;

type InternalMutationPreparer = (
    command: GroupMutationCommand,
    authority: Exclude<GroupMutationFacts['internalAuthority'], 'none'>,
    atEpochMs: number
) => Promise<GroupMutationPreparation>;

interface GroupStateRuntimeOwners {
    readonly dependencies: GroupStateServiceDependencies;
    readonly repositoryFor: GroupStateRepositoryFactory;
    readonly authorityDependencies: GroupMutationAuthorityDependencies;
    readonly prepareInternalMutation: InternalMutationPreparer;
}

interface CreateAuthorityDependenciesInput {
    readonly dependencies: GroupStateServiceDependencies;
    readonly repositoryFor: GroupStateRepositoryFactory;
    readonly now: () => number;
    readonly randomId: () => string;
}

function createAuthorityDependencies(
    { dependencies, repositoryFor, now, randomId }: CreateAuthorityDependenciesInput
): GroupMutationAuthorityDependencies {
    return {
        authSessionRepository: dependencies.authSessionRepository,
        now,
        randomId,
        serviceId: dependencies.serviceId,
        capacity: dependencies.capacity,
        readCausalRevision: async (ref) => await repositoryFor(dependencies.runtimeRepository).readCausalRevision(ref)
    };
}

function createInternalMutationPreparer(
    dependencies: GroupStateServiceDependencies
): InternalMutationPreparer {
    return async (command, internalAuthority, atEpochMs) => {
        validateGroupMutationCommand(command);
        const commandHash = await hashMutationCommand(
            decodeJsonWireValue(command, 'Internal group mutation command')
        );
        const facts: Omit<GroupMutationFacts, 'attemptCount'> = {
            nowEpochMs: atEpochMs,
            expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
            serviceId: dependencies.serviceId,
            eventId: `group-event:${commandHash.slice('sha256:'.length)}`,
            commandHash,
            resolvedJoinCode: null,
            joinCodeVerifier: null,
            internalAuthority,
            ...(dependencies.capacity ? { capacity: dependencies.capacity } : {}),
            authenticatedAuthority: null
        };
        // Run the capability matrix at prepare time: a command a mode cannot
        // execute fails at the call site, never as a poison row the queue
        // retries into a terminal failure. attemptCount is a placeholder the
        // matrix never reads.
        assertGroupMutationAuthority(command, { ...facts, attemptCount: 1 });
        const causalToken = await sha256CanonicalJson({ command, facts });
        return {
            authorityProof: null,
            descriptor: null,
            command,
            facts,
            causalToken,
            queueResourceId: `g-${causalToken.slice('sha256:'.length, 34)}`
        };
    };
}

function createPreparationOperations(
    owners: GroupStateRuntimeOwners
): Pick<
    GroupStateService,
    | 'authorizeMutation'
    | 'prepareMutation'
    | 'prepareAppInboxMutation'
    | 'prepareExpiredPresenceMutations'
    | 'prepareSessionCleanupMutations'
    | 'prepareFormationCriterionMutation'
    | 'prepareFormationAutomationMutation'
    | 'prepareTopologyPublicationMutation'
    | 'prepareActivationStatusMutation'
> {
    const { dependencies, repositoryFor, authorityDependencies, prepareInternalMutation } = owners;
    const runtime = dependencies.runtimeRepository;
    return {
        authorizeMutation: async (descriptor, authority) =>
            await authorizeGroupMutation(authorityDependencies, descriptor, authority),
        prepareMutation: async (descriptor, authority) =>
            await prepareGroupMutation(authorityDependencies, descriptor, authority),
        prepareAppInboxMutation: async (descriptor, authority) =>
            await prepareAppInboxGroupMutation(authorityDependencies, descriptor, authority),
        prepareExpiredPresenceMutations: async (atEpochMs) => {
            const candidates = (await repositoryFor(runtime).listAllPresenceSessions()).filter(
                (session) => session.disconnectedAtEpochMs === null && session.expiresAtEpochMs <= atEpochMs
            );
            return await Promise.all(
                candidates.map((session) =>
                    prepareInternalMutation(toExpiryCommand(session, atEpochMs), 'expiry', atEpochMs)
                )
            );
        },
        prepareFormationCriterionMutation: async (command, atEpochMs) =>
            await prepareInternalMutation(command, 'formation-criterion', atEpochMs),
        prepareFormationAutomationMutation: async (command, atEpochMs) =>
            await prepareInternalMutation(command, 'formation-automation', atEpochMs),
        prepareTopologyPublicationMutation: async (command, atEpochMs) =>
            await prepareInternalMutation(command, 'topology-publication', atEpochMs),
        prepareActivationStatusMutation: async (command, atEpochMs) =>
            await prepareInternalMutation(command, 'activation-status', atEpochMs),
        prepareSessionCleanupMutations: async (input) => {
            const candidates = await readGroupSessionCleanupCandidates(
                repositoryFor(runtime),
                dependencies.authSessionRepository,
                input
            );
            return await Promise.all(
                candidates.map((session) =>
                    prepareInternalMutation(
                        toSessionCleanupCommand(session, input.disconnectedAtEpochMs),
                        'session-cleanup',
                        input.disconnectedAtEpochMs
                    )
                )
            );
        }
    };
}

function createQueryOperations(
    owners: GroupStateRuntimeOwners
): Pick<
    GroupStateService,
    | 'listSnapshots'
    | 'listSnapshotsPage'
    | 'readSnapshot'
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
        listSnapshotsPage: async (scope, options) => await repositoryFor(runtime).listSnapshotsPage(scope, options),
        readSnapshot: async (ref) => await repositoryFor(runtime).readSnapshot(ref),
        readCausalRevision: async (ref) => await repositoryFor(runtime).readCausalRevision(ref),
        readIssuedAuthSession: async (sessionId) => await dependencies.authSessionRepository.findBySessionId(sessionId),
        listEvents: async (ref) => await repositoryFor(runtime).listEvents(ref),
        listRecentEvents: async (ref, query) => await repositoryFor(runtime).listRecentEvents(ref, query),
        listEventPage: async (ref, query) => await repositoryFor(runtime).listEventPage(ref, query),
        observeSnapshot: (snapshot) => Promise.resolve(snapshot)
    };
}

function createMutationOperations(
    owners: GroupStateRuntimeOwners
): Pick<GroupStateService, 'read' | 'compute' | 'validate' | 'write'> {
    return {
        read: async (prepared) => await readPreparedGroupMutation(owners, prepared),
        compute: (prepared, read) => computeGroupMutation({ command: prepared.command, read, facts: prepared.facts }),
        validate: (prepared, read, computed) => {
            assertGroupMutation({
                command: prepared.command,
                read,
                facts: prepared.facts,
                computed
            });
            if (computed.outcome === 'idempotency-conflict') {
                throw new GroupMutationIdempotencyConflictError(
                    prepared.command.commandId,
                    computed.existingCommandHash,
                    computed.receivedCommandHash
                );
            }
        },
        write: async (transaction, computed) => await writeGroupMutation(transaction, computed)
    };
}

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies
): GroupStateService {
    return createGroupStateRuntime(dependencies).service;
}

async function readPreparedGroupMutation(
    owners: GroupStateRuntimeOwners,
    prepared: GroupStateMutationCommand
): Promise<GroupMutationRead> {
    const { dependencies, repositoryFor, authorityDependencies } = owners;
    const runtime = dependencies.runtimeRepository;
    if (prepared.facts.internalAuthority !== 'none') {
        if (
            prepared.authorityProof !== null ||
            prepared.descriptor !== null ||
            prepared.facts.authenticatedAuthority !== null
        ) {
            throw new GroupMutationAuthorizationError(
                'Internal group mutation authority is malformed.'
            );
        }
    }
    else {
        await verifyPreparedGroupMutationAuthority(authorityDependencies, prepared);
    }
    const initialRead = await readGroupMutation(repositoryFor(runtime), prepared.command);
    const command = prepared.command;
    const connectTriggerLatch = command.operation === 'connectGroup' && command.input.connectTriggerGeneration !== null
        ? await new GroupConnectTriggerLatchRepository(runtime).read({
            groupRef: command.aggregateRef,
            formationEpoch: command.input.expectedFormationEpoch,
            triggerGeneration: command.input.connectTriggerGeneration
        })
        : null;
    const read = { ...initialRead, connectTriggerLatch };
    if (!readsGroupLayoutRows(prepared.command)) {
        return read;
    }
    // Read after the group row so the fence's staleness window ends
    // close to compute; the write transaction re-asserts the planned
    // row's revision, so a replan landing after this read conflicts
    // instead of committing against a stale plan. The accepted row
    // is read only by the commands that can promote.
    const [plannedLayoutRow, acceptedLayoutRow] = await Promise.all([
        dependencies.readPlannedLayoutRow(prepared.command.aggregateRef),
        readsAcceptedLayoutRow(prepared.command)
            ? dependencies.readAcceptedLayoutRow(prepared.command.aggregateRef)
            : null
    ]);
    return { ...read, plannedLayoutRow, acceptedLayoutRow };
}
