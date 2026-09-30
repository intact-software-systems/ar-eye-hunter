import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { GroupStateRepositoryReads } from '../../group-state/persistence/group-state-repository-reads.ts';
import { StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import { ClientStateRepository } from '../persistence/client-state-repository.ts';
import { ClientMutationRejectedError } from '../validation/client-mutation-rejection.ts';
import type { ClientMutationCommand, ClientMutationRead } from './client-mutation-contracts.ts';

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

export interface ReadClientMutationInput {
    readonly repository: ClientStateRepository;
    readonly groupRepository: GroupStateRepositoryReads;
    readonly authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>;
    readonly command: ClientMutationCommand;
    readonly audienceObservedAtEpochMs: number;
}

export async function readClientMutation(
    input: ReadClientMutationInput
): Promise<ClientMutationRead> {
    const { repository, authSessionRepository, command } = input;
    const audienceObservedAtEpochMs = input.audienceObservedAtEpochMs;
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
    const receiptEvent = await readReceiptEvent(repository, command, idempotency);

    return {
        authoritySession: authoritySession ?? null,
        idempotency: idempotency ?? null,
        principal: principalSnapshot?.principal ?? null,
        instance: instance ?? null,
        session: sessionRead.value ?? null,
        expiredSessionEntry: sessionRead.expiredEntry ?? null,
        snapshot: principalSnapshot?.snapshot ?? null,
        receiptEvent,
        audienceObservedAtEpochMs,
        audienceGroupSnapshots: [],
        audienceClientSnapshots: []
    };
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
