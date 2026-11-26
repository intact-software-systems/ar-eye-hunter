import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import { assertGroupGuestPermission } from './mutation/membership/assert-group-guest-permission.ts';
import { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import { PartyRepository } from '../parties/persistence/party-repository.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { computeMutationCommandDigest, decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { createWsSessionGenerationLifecycleService } from '../websocket/ws-session-generation-lifecycle.ts';
import {
    authorizeGroupMutation,
    captureAppInboxGroupMutationIngress,
    captureGroupMutationIngress,
    GroupMutationAuthorizationError,
    requireGroupMutationAuthorityProof,
    toGroupMutationEventId,
    verifyLiveGroupMutationSession,
    type GroupMutationAuthorityDependencies
} from './group-mutation-authority.ts';
import { toExpiryCommand, toSessionCleanupCommand } from './group-presence-mutation-command.ts';
import {
    type GroupMutationIngress,
    type GroupStateMutationCommand,
    type GroupStateRuntime,
    type GroupStateService,
    type GroupStateServiceDependencies
} from './group-state-service-contracts.ts';
import { createTimedGroupStateService } from './group-state-service-timing.ts';
import { GroupMoveRepository } from './move/group-move-repository.ts';
import { GroupMoveService } from './move/group-move-service.ts';
import { assertGroupMutationAuthority } from './mutation/command-validation/assert-group-mutation-authority.ts';
import { assertGroupMutationCommand } from './mutation/command-validation/assert-group-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationIngressFacts,
    GroupMutationRead,
    GroupMutationSnapshotRead
} from './mutation/group-mutation-contracts.ts';
import { readGroupGuestTransportRows } from './mutation/membership/group-guest-transport-lifecycle.ts';
import { computeGroupMutation } from './mutation/orchestration/compute-group-mutation.ts';
import { readsAcceptedLayoutRow, readsGroupLayoutRows } from './mutation/read/group-mutation-read-scope.ts';
import { readGroupMutation, readGroupMutationWithSnapshot } from './mutation/read/read-group-mutation.ts';
import { validateGroupMutation } from './mutation/state-validation/validate-group-mutation.ts';
import { writeGroupMutation } from './mutation/write/write-group-mutation.ts';
import { GroupConnectTriggerLatchRepository } from './persistence/group-connect-trigger-latch-repository.ts';
import { GroupStateRepository } from './persistence/group-state-repository.ts';
import type { GroupStateMutationExactAuthSession } from './persistence/read-exact-group-state-mutation.ts';
import {
    readGroupSessionTopicSubscriptions,
    readGroupTopicSubscriptionAuthority
} from './persistence/subscription/read-group-topic-subscriptions.ts';
import { readGroupSessionCleanupCandidates } from './presence/group-session-cleanup.ts';
import { GroupQuickJoinService } from './quick-join/group-quick-join-service.ts';
import { GroupRetentionService } from './retention/group-retention-service.ts';
import { verifyPausedGroupAdmission } from './retention/verify-paused-group-admission.ts';
import { isGroupSessionViewAudienceCommand } from './schedule/compute-group-session-view-publication.ts';
import { GroupSessionDirectory } from './schedule/group-session-directory.ts';
import { readGroupSessionViewAudience } from './schedule/read-group-session-view-audience.ts';

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
    const runtime = dependencies.runtimeRepository;
    const now = dependencies.now ?? (() => Date.now());
    const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    const repository = new GroupStateRepository(runtime, dependencies.groupStateEventStore);
    const authSessions = new AuthSessionPersistence(runtime);
    const owners: GroupStateRuntimeOwners = {
        dependencies,
        repository,
        authSessions,
        authorityDependencies: createAuthorityDependencies({ dependencies, authSessions, now, randomId }),
        captureInternalMutationIngress: createInternalMutationIngressCapture(dependencies)
    };
    const ingressOperations = createIngressCaptureOperations(owners);
    const mutationOperations = createMutationOperations(owners);
    const mutationConfig = {
        serviceId: dependencies.serviceId,
        finishedRetentionMs: dependencies.finishedRetentionMs,
        now
    };
    const service: GroupStateService = {
        sessionDirectory: new GroupSessionDirectory({ repository, now }),
        move: new GroupMoveService({
            groups: repository,
            moves: new GroupMoveRepository(runtime, now),
            parties: new PartyRepository(runtime, now),
            authSessions,
            mutations: {
                captureMutationIngress: ingressOperations.captureMutationIngress,
                read: mutationOperations.read
            }
        }, mutationConfig),
        sessionGenerationLifecycle: createWsSessionGenerationLifecycleService(runtime),
        quickJoin: new GroupQuickJoinService(
            { repository, authSessions },
            {
                ...mutationConfig,
                capacity: dependencies.capacity ?? { defaultMaxMembers: null }
            }
        ),
        retention: new GroupRetentionService({
            runtime,
            repository,
            groupOwnedAppData: dependencies.groupOwnedAppData ?? { read: async () => [] }
        }, mutationConfig),
        ...ingressOperations,
        ...createQueryOperations(owners),
        ...mutationOperations
    };
    return {
        service: createTimedGroupStateService({
            service,
            timing: dependencies.timing,
            serviceId: dependencies.serviceId
        })
    };
}

type InternalMutationIngressCapture = (
    command: GroupMutationCommand,
    authority: Exclude<GroupMutationFacts['internalAuthority'], 'none'>,
    atEpochMs: number
) => GroupMutationIngress;

interface GroupStateRuntimeOwners {
    readonly dependencies: GroupStateServiceDependencies;
    readonly repository: GroupStateRepository;
    /** The live-session rows the batch read selects live in the same store, so one persistence reads both. */
    readonly authSessions: AuthSessionPersistence;
    readonly authorityDependencies: GroupMutationAuthorityDependencies;
    readonly captureInternalMutationIngress: InternalMutationIngressCapture;
}

interface CreateAuthorityDependenciesInput {
    readonly dependencies: GroupStateServiceDependencies;
    readonly authSessions: AuthSessionPersistence;
    readonly now: () => number;
    readonly randomId: () => string;
}

function createAuthorityDependencies(
    { dependencies, authSessions, now, randomId }: CreateAuthorityDependenciesInput
): GroupMutationAuthorityDependencies {
    return {
        authSessions,
        now,
        randomId,
        serviceId: dependencies.serviceId,
        finishedRetentionMs: dependencies.finishedRetentionMs,
        capacity: dependencies.capacity
    };
}

function createInternalMutationIngressCapture(
    dependencies: GroupStateServiceDependencies
): InternalMutationIngressCapture {
    return (command, internalAuthority, atEpochMs) => {
        assertGroupMutationCommand(command);
        const commandHash = computeMutationCommandDigest(
            decodeJsonWireValue(command, 'Internal group mutation command')
        );
        const facts: GroupMutationIngressFacts = {
            nowEpochMs: atEpochMs,
            expireAtEpochMs: atEpochMs + dependencies.finishedRetentionMs,
            serviceId: dependencies.serviceId,
            eventId: toGroupMutationEventId(commandHash, atEpochMs),
            commandHash,
            resolvedJoinCode: null,
            joinCodeVerifier: null,
            internalAuthority,
            capacity: { defaultMaxMembers: dependencies.capacity?.defaultMaxMembers ?? null },
            authenticatedAuthority: null
        };
        // Run the capability matrix during ingress capture: a command a mode cannot
        // execute fails at the call site, never as a poison row the queue
        // retries into a terminal failure.
        assertGroupMutationAuthority(command, facts);
        const causalToken = computeSha256CanonicalJson({ command, facts });
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

function createIngressCaptureOperations(
    owners: GroupStateRuntimeOwners
): Pick<
    GroupStateService,
    | 'authorizeMutation'
    | 'captureMutationIngress'
    | 'captureAppInboxMutationIngress'
    | 'captureExpiredPresenceMutationIngresses'
    | 'captureSessionCleanupMutationIngresses'
    | 'captureFormationCriterionMutationIngress'
    | 'captureFormationAutomationMutationIngress'
    | 'captureTopologyPublicationMutationIngress'
    | 'captureTimelineDeadlineMutationIngress'
    | 'captureGuestMembershipMutationIngress'
    | 'captureActivationStatusMutationIngress'
> {
    const { repository, authorityDependencies, captureInternalMutationIngress } = owners;
    return {
        authorizeMutation: async (descriptor, authority) =>
            await authorizeGroupMutation(authorityDependencies, descriptor, authority),
        captureMutationIngress: async (descriptor, authority) =>
            await captureGroupMutationIngress(authorityDependencies, descriptor, authority),
        captureAppInboxMutationIngress: async (descriptor, authority) =>
            await captureAppInboxGroupMutationIngress(authorityDependencies, descriptor, authority),
        captureExpiredPresenceMutationIngresses: async (atEpochMs) => {
            const candidates = (await repository.listAllPresenceSessions()).filter(
                (session) => session.disconnectedAtEpochMs === null && session.expiresAtEpochMs <= atEpochMs
            );
            return candidates.map((session) =>
                captureInternalMutationIngress(toExpiryCommand(session, atEpochMs), 'expiry', atEpochMs)
            );
        },
        captureFormationCriterionMutationIngress: async (command, atEpochMs) =>
            captureInternalMutationIngress(command, 'formation-criterion', atEpochMs),
        captureFormationAutomationMutationIngress: async (command, atEpochMs) =>
            captureInternalMutationIngress(command, 'formation-automation', atEpochMs),
        captureTopologyPublicationMutationIngress: async (command, atEpochMs) =>
            captureInternalMutationIngress(command, 'topology-publication', atEpochMs),
        captureGuestMembershipMutationIngress: async (command, atEpochMs) =>
            captureInternalMutationIngress(
                command,
                command.operation === 'createGroup' ? 'temporary-room-creation' : command.operation === 'removeGroupMember' ? 'guest-expiry' : 'guest-redemption',
                atEpochMs
            ),
        captureTimelineDeadlineMutationIngress: async (command, atEpochMs) =>
            captureInternalMutationIngress(command, 'timeline-deadline', atEpochMs),
        captureActivationStatusMutationIngress: async (command, atEpochMs) =>
            captureInternalMutationIngress(command, 'activation-status', atEpochMs),
        captureSessionCleanupMutationIngresses: async (input) => {
            const candidates = await readGroupSessionCleanupCandidates(repository, input);
            return candidates.map((session) =>
                captureInternalMutationIngress(
                    toSessionCleanupCommand(session, input.disconnectedAtEpochMs),
                    'session-cleanup',
                    input.disconnectedAtEpochMs
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
    | 'readGroupSessionTopicSubscriptions'
    | 'readGroupTopicSubscriptionAuthority'
    | 'readIssuedAuthSession'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listEventPage'
    | 'observeSnapshot'
> {
    const { dependencies, repository, authorityDependencies } = owners;
    const runtime = dependencies.runtimeRepository;
    return {
        listSnapshots: async (scope) => await repository.listSnapshots(scope),
        listSnapshotsPage: async (scope, options) => await repository.listSnapshotsPage(scope, options),
        readSnapshot: async (ref) => await repository.readSnapshot(ref),
        readCausalRevision: async (ref) => await repository.readCausalRevision(ref),
        readGroupSessionTopicSubscriptions: async (ref, sessionId) =>
            await readGroupSessionTopicSubscriptions(runtime, {
                ref,
                sessionId,
                observedAtEpochMs: authorityDependencies.now()
            }),
        readGroupTopicSubscriptionAuthority: async (snapshot, topicId) =>
            await readGroupTopicSubscriptionAuthority(runtime, {
                snapshot,
                topicId,
                observedAtEpochMs: authorityDependencies.now()
            }),
        readIssuedAuthSession: async (sessionId) => await owners.authSessions.findBySessionId(sessionId),
        listEvents: async (ref) => await repository.listEvents(ref),
        listRecentEvents: async (ref, query) => await repository.listRecentEvents(ref, query),
        listEventPage: async (ref, query) => await repository.listEventPage(ref, query),
        observeSnapshot: (snapshot) => Promise.resolve(snapshot)
    };
}

function createMutationOperations(
    owners: GroupStateRuntimeOwners
): Pick<GroupStateService, 'read' | 'readWithSnapshot' | 'compute' | 'validate' | 'write'> {
    return {
        read: async (ingress) => await readGroupMutationAttempt(owners, ingress),
        readWithSnapshot: async (ingress) => await readGroupMutationAttemptWithSnapshot(owners, ingress),
        compute: (ingress, read) => computeGroupMutation({ command: ingress.command, read, facts: ingress.facts }),
        validate: (ingress, read, computed) =>
            validateGroupMutation({
                command: ingress.command,
                read,
                facts: ingress.facts,
                computed
            }),
        write: async (transaction, computed) => await writeGroupMutation(transaction, computed)
    };
}

export function createGroupStateService(
    dependencies: GroupStateServiceDependencies
): GroupStateService {
    return createGroupStateRuntime(dependencies).service;
}

async function readGroupMutationAttempt(
    owners: GroupStateRuntimeOwners,
    ingress: GroupStateMutationCommand
): Promise<GroupMutationRead> {
    const { read, authSession } = await readGroupMutation(
        {
            repository: owners.repository,
            command: ingress.command,
            authSessionId: resolveGroupMutationAuthSessionId(ingress),
            lobbyDefault: ingress.facts.lobbyDefault !== undefined
        }
    );
    await verifyGroupMutationAttemptSession({ owners, ingress, authSession, read });
    return await readGroupMutationFences(owners, ingress, read);
}

async function readGroupMutationAttemptWithSnapshot(
    owners: GroupStateRuntimeOwners,
    ingress: GroupStateMutationCommand
): Promise<GroupMutationSnapshotRead> {
    const { read, currentSnapshot, authSession } = await readGroupMutationWithSnapshot(
        {
            repository: owners.repository,
            command: ingress.command,
            authSessionId: resolveGroupMutationAuthSessionId(ingress),
            lobbyDefault: ingress.facts.lobbyDefault !== undefined
        }
    );
    await verifyGroupMutationAttemptSession({ owners, ingress, authSession, read });
    return { read: await readGroupMutationFences(owners, ingress, read), currentSnapshot };
}

/** The session an authenticated attempt re-checks; internal authority carries none and must name none. */
function resolveGroupMutationAuthSessionId(ingress: GroupStateMutationCommand): string | null {
    if (ingress.facts.internalAuthority === 'none') {
        return requireGroupMutationAuthorityProof(ingress).sessionId;
    }
    if (
        ingress.authorityProof !== null ||
        ingress.descriptor !== null ||
        ingress.facts.authenticatedAuthority !== null
    ) {
        throw new GroupMutationAuthorizationError(
            'Internal group mutation authority is malformed.'
        );
    }
    return null;
}

interface VerifyGroupMutationAttemptSessionInput {
    readonly owners: GroupStateRuntimeOwners;
    readonly ingress: GroupStateMutationCommand;
    readonly authSession: GroupStateMutationExactAuthSession;
    readonly read: GroupMutationRead;
}

/** An exact read carried the session row; a sequential read re-checks it with its own read. */
async function verifyGroupMutationAttemptSession(
    { owners, ingress, authSession, read }: VerifyGroupMutationAttemptSessionInput
): Promise<void> {
    if (ingress.facts.internalAuthority !== 'none') {
        return;
    }
    const proof = requireGroupMutationAuthorityProof(ingress);
    const session = authSession.status === 'unread'
        ? await owners.authorityDependencies.authSessions.findBySessionId(proof.sessionId)
        : authSession.session;
    const now = ingress.facts.attemptAtEpochMs;
    verifyLiveGroupMutationSession(proof, session, now);
    assertGroupGuestPermission({ command: ingress.command, read, session, now });
}

async function readGroupMutationFences(
    owners: GroupStateRuntimeOwners,
    ingress: GroupStateMutationCommand,
    initialRead: GroupMutationRead
): Promise<GroupMutationRead> {
    const { dependencies } = owners;
    const runtime = dependencies.runtimeRepository;
    const command = ingress.command;
    await verifyPausedGroupAdmission(owners.repository, ingress, initialRead);
    const connectTriggerLatch = command.operation === 'connectGroup' && command.input.connectTriggerGeneration !== null
        ? await new GroupConnectTriggerLatchRepository(runtime).read({
            groupRef: command.aggregateRef,
            formationEpoch: command.input.expectedFormationEpoch,
            triggerGeneration: command.input.connectTriggerGeneration
        })
        : null;
    const sessionViewAudience = initialRead.idempotency === null && initialRead.group !== null &&
            readGroupSessionSchedule(initialRead.group.value.metadata) !== null &&
            isGroupSessionViewAudienceCommand(command)
        ? await readGroupSessionViewAudience(runtime, command.aggregateRef, ingress.facts.attemptAtEpochMs)
        : null;
    const guestTransportRows = await readGroupGuestTransportRows(owners.authSessions, command, initialRead);
    const read = { ...initialRead, connectTriggerLatch, sessionViewAudience, guestTransportRows };
    if (!readsGroupLayoutRows(ingress.command)) {
        return read;
    }
    // Read after the group row so the fence's staleness window ends
    // close to compute; the write transaction re-asserts the planned
    // row's revision, so a replan landing after this read conflicts
    // instead of committing against a stale plan. The accepted row
    // is read only by the commands that can promote.
    const [plannedLayoutRow, acceptedLayoutRow] = await Promise.all([
        dependencies.readPlannedLayoutRow(ingress.command.aggregateRef),
        readsAcceptedLayoutRow(ingress.command)
            ? dependencies.readAcceptedLayoutRow(ingress.command.aggregateRef)
            : null
    ]);
    return { ...read, plannedLayoutRow, acceptedLayoutRow };
}
