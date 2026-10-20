import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { GroupStateRepositoryReads } from '../../group-state/persistence/group-state-repository-reads.ts';
import { readGroupVisibility } from '../../group-state/policy/group-snapshot-visibility-policy.ts';
import type { GroupStateCurrentSnapshotCache } from '../../group-state/snapshot/group-state-current-snapshot-cache.ts';
import { StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import { timeClientStateReadPhase, type ClientStateMutationTiming } from '../client-state-service-timing.ts';
import { ClientStateRepository } from '../persistence/client-state-repository.ts';
import { ClientMutationRejectedError } from '../validation/client-mutation-rejection.ts';
import type { ClientMutationCommand, ClientMutationRead } from './client-mutation-contracts.ts';
import { resolveClientMutationAudienceReadScope } from './resolve-client-mutation-audience-read-scope.ts';

interface ClientMutationTargetRefs {
    readonly instanceRef: {
        readonly applicationId: string;
        readonly workspaceId: string;
        readonly principalId: string;
        readonly clientInstanceId: string;
    } | null;
    readonly sessionRef: {
        readonly applicationId: string;
        readonly workspaceId: string;
        readonly principalId: string;
        readonly clientInstanceId: string;
        readonly sessionId: string;
    } | null;
}

interface ClientMutationAudienceRead {
    readonly audienceGroupSnapshots: readonly GroupSnapshot[];
    readonly audienceClientSnapshots: readonly ClientSnapshot[];
}

export interface ReadClientMutationInput {
    readonly repository: ClientStateRepository;
    readonly groupRepository: GroupStateRepositoryReads;
    readonly authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>;
    readonly command: ClientMutationCommand;
    readonly audienceObservedAtEpochMs: number;
    readonly timing?: ClientStateMutationTiming;
    readonly currentGroupSnapshots?: Pick<GroupStateCurrentSnapshotCache, 'readSnapshot'>;
}

type ClientMutationStateRead = Pick<
    ClientMutationRead,
    'authoritySession' | 'idempotency' | 'principal' | 'instance' | 'session' | 'expiredSessionEntry' | 'snapshot'
>;

const EMPTY_AUDIENCE_READ: ClientMutationAudienceRead = {
    audienceGroupSnapshots: [],
    audienceClientSnapshots: []
};

export async function readClientMutation(
    input: ReadClientMutationInput
): Promise<ClientMutationRead> {
    const { repository, command, audienceObservedAtEpochMs, timing } = input;
    const state = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-state' },
        () => readClientMutationState(input)
    );
    const receiptEvent = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-receipt' },
        () => readReceiptEvent(repository, command, state.idempotency ?? undefined)
    );
    const audienceScope = resolveClientMutationAudienceReadScope(command, state);
    const audience = audienceScope === 'principal-audience'
        ? await readPrincipalAudience(input)
        : EMPTY_AUDIENCE_READ;

    return { ...state, receiptEvent, audienceObservedAtEpochMs, ...audience };
}

async function readClientMutationState(
    input: ReadClientMutationInput
): Promise<ClientMutationStateRead> {
    const { repository, authSessionRepository, command } = input;
    const targets = toClientMutationTargetRefs(command);
    const [authoritySession, idempotency, principalSnapshot, instance, sessionRead] = await Promise.all([
        readAuthoritySession(authSessionRepository, command),
        readIdempotency(repository, command),
        repository.readPrincipalSnapshot(command.aggregateRef),
        targets.instanceRef ? repository.findInstanceEntry(targets.instanceRef) : undefined,
        targets.sessionRef
            ? repository.readSessionEntry(targets.sessionRef)
            : { value: undefined, expiredEntry: undefined }
    ]);

    assertPrincipalSnapshotRevision(principalSnapshot);
    return {
        authoritySession: authoritySession ?? null,
        idempotency: idempotency ?? null,
        principal: principalSnapshot?.principal ?? null,
        instance: instance ?? null,
        session: sessionRead.value ?? null,
        expiredSessionEntry: sessionRead.expiredEntry ?? null,
        snapshot: principalSnapshot?.snapshot ?? null
    };
}

async function readPrincipalAudience(
    input: Omit<ReadClientMutationInput, 'authSessionRepository'>
): Promise<ClientMutationAudienceRead> {
    const { repository, groupRepository, command, audienceObservedAtEpochMs, timing } = input;
    const scope = {
        applicationId: command.aggregateRef.applicationId,
        workspaceId: command.aggregateRef.workspaceId
    };
    const audienceGroupSnapshots = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-audience-groups' },
        () =>
            groupRepository.listSnapshotsForPrincipal(
                scope,
                command.aggregateRef.principalId,
                input.currentGroupSnapshots
            )
    );
    const coGroupPrincipalIds = new Set<string>();
    for (const snapshot of audienceGroupSnapshots) {
        if (
            readGroupVisibility({
                snapshot,
                actor: { principalId: command.aggregateRef.principalId },
                nowEpochMs: audienceObservedAtEpochMs
            }) !== 'full'
        ) {
            continue;
        }
        for (const member of snapshot.members) {
            if (
                member.principalId !== command.aggregateRef.principalId &&
                readGroupVisibility({
                        snapshot,
                        actor: { principalId: member.principalId },
                        nowEpochMs: audienceObservedAtEpochMs
                    }) === 'full'
            ) {
                coGroupPrincipalIds.add(member.principalId);
            }
        }
    }
    const audienceClientSnapshots = await timeClientStateReadPhase(
        { timing, command, operation: 'mutation.read-audience-clients' },
        () =>
            repository.readSnapshotsForPrincipals(
                [...coGroupPrincipalIds].map((principalId) => ({ ...scope, principalId }))
            )
    );
    return { audienceGroupSnapshots, audienceClientSnapshots };
}

function toClientMutationTargetRefs(command: ClientMutationCommand): ClientMutationTargetRefs {
    const instanceRef = 'clientInstanceId' in command
        ? { ...command.aggregateRef, clientInstanceId: command.clientInstanceId }
        : null;
    return {
        instanceRef,
        sessionRef: instanceRef && 'sessionId' in command
            ? { ...instanceRef, sessionId: command.sessionId }
            : null
    };
}

function readAuthoritySession(
    authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>,
    command: ClientMutationCommand
) {
    return command.authority.kind === 'issued-session'
        ? authSessionRepository.findBySessionId(command.authority.sessionId)
        : undefined;
}

function readIdempotency(repository: ClientStateRepository, command: ClientMutationCommand) {
    return command.requestId === null
        ? undefined
        : repository.findIdempotentClientMutationReceiptEntry(command.aggregateRef, command.requestId);
}

function assertPrincipalSnapshotRevision(
    principalSnapshot: Awaited<ReturnType<ClientStateRepository['readPrincipalSnapshot']>>
): void {
    if (
        principalSnapshot &&
        principalSnapshot.snapshot.stateRevision !== principalSnapshot.principal.entry.revision + 1
    ) {
        throw new StateSnapshotReadConflictError(principalSnapshot.principal.entry.key);
    }
}

async function readReceiptEvent(
    repository: ClientStateRepository,
    command: ClientMutationCommand,
    idempotency: Awaited<ReturnType<ClientStateRepository['findIdempotentClientMutationReceiptEntry']>>
) {
    if (!idempotency || idempotency.value.receipt.eventId === null) {
        return null;
    }
    const receiptEvent = (await repository.listEvents(command.aggregateRef)).find(
        (event) => event.eventId === idempotency.value.receipt.eventId
    ) ?? null;
    if (!receiptEvent) {
        throw new ClientMutationRejectedError(
            `Client mutation receipt event not found: ${idempotency.value.receipt.eventId}`
        );
    }
    return receiptEvent;
}
