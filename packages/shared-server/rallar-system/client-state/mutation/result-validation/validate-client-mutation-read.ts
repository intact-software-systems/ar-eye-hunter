import { validateAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';

import {
    // Receipt validation remains a direct dependency on its canonical owner.
    validateClientMutationIdempotencyRecordValue
} from '../../client-mutation-receipt-validation.ts';
import {
    validateClientEvent,
    validateClientInstance,
    validateClientPrincipal,
    validateClientRuntimeStateEntry,
    validateClientSession
} from '../../client-state-contract-validation.ts';
import { sameClientPrincipalRef } from '../../client-state-semantic-equality.ts';
import {
    ClientMutationRejectedError,
    requireExactKeys,
    requirePlainRecord
} from '../../client-state-validation-primitives.ts';
import type { ClientMutationCommand, ClientMutationRead } from '../client-mutation-contracts.ts';
import { validateClientExpiredSessionAuthority } from '../validate-client-expired-session-authority.ts';

export function validateClientMutationRead(
    command: ClientMutationCommand,
    read: ClientMutationRead
): void {
    const root = requirePlainRecord(read, 'Client mutation read');
    requireExactKeys(
        root,
        [
            'authoritySession',
            'idempotency',
            'principal',
            'instance',
            'session',
            'expiredSessionEntry',
            'snapshot',
            'receiptEvent'
        ],
        'Client mutation read'
    );
    validateNullableEntryValue(read.principal, 'Client principal read', validateClientPrincipal);
    validateNullableEntryValue(read.instance, 'Client instance read', validateClientInstance);
    validateNullableEntryValue(read.session, 'Client session read', validateClientSession);
    validateClientExpiredSessionAuthority({
        aggregateRef: command.aggregateRef,
        clientInstanceId: 'clientInstanceId' in command ? command.clientInstanceId : null,
        sessionId: 'sessionId' in command ? command.sessionId : null,
        liveSession: read.session,
        expiredSessionEntry: read.expiredSessionEntry
    });
    validateNullableEntryValue(
        read.idempotency,
        'Client idempotency read',
        validateClientMutationIdempotencyRecordValue
    );
    validateClientMutationSnapshotRead(command, read);
    validateClientMutationReadScope(command, read);
}

function validateClientMutationSnapshotRead(
    command: ClientMutationCommand,
    read: ClientMutationRead
): void {
    if (read.snapshot !== null) {
        try {
            validateAuthoritativeClientSnapshot(read.snapshot, command.aggregateRef);
        }
        catch (error) {
            throw new ClientMutationRejectedError(
                error instanceof Error ? error.message : 'Client snapshot read is invalid'
            );
        }
    }
    if (read.receiptEvent !== null) {
        validateClientEvent(read.receiptEvent, 'Stored client event');
        if (!sameClientPrincipalRef(read.receiptEvent, command.aggregateRef)) {
            throw new ClientMutationRejectedError(
                'Stored client event identity differs from its requested aggregate'
            );
        }
    }
}

function validateClientMutationReadScope(
    command: ClientMutationCommand,
    read: ClientMutationRead
): void {
    if (read.principal && !sameClientPrincipalRef(read.principal.value, command.aggregateRef)) {
        throw new ClientMutationRejectedError('Client principal read is wrongly scoped');
    }
    if (read.instance) {
        if (
            !('clientInstanceId' in command) ||
            !sameClientPrincipalRef(read.instance.value, command.aggregateRef) ||
            read.instance.value.clientInstanceId !== command.clientInstanceId
        ) {
            throw new ClientMutationRejectedError('Client instance read is wrongly scoped');
        }
    }
    validateClientMutationSessionReadScope(command, read);
    validateClientMutationIdempotencyRead(command, read);
}

function validateClientMutationSessionReadScope(
    command: ClientMutationCommand,
    read: ClientMutationRead
): void {
    if (!read.session) {
        return;
    }
    if (
        !('sessionId' in command) ||
        !sameClientPrincipalRef(read.session.value, command.aggregateRef) ||
        read.session.value.clientInstanceId !== command.clientInstanceId ||
        read.session.value.sessionId !== command.sessionId ||
        !read.session.value.generationId ||
        !Number.isSafeInteger(read.session.value.generationVersion) ||
        read.session.value.generationVersion < 1
    ) {
        throw new ClientMutationRejectedError('Client session read is invalid');
    }
}

function validateClientMutationIdempotencyRead(
    command: ClientMutationCommand,
    read: ClientMutationRead
): void {
    if (!read.idempotency) {
        return;
    }
    if (
        command.requestId === null ||
        read.idempotency.value.requestId !== command.requestId ||
        !/^sha256:[0-9a-f]{64}$/.test(read.idempotency.value.commandHash) ||
        read.idempotency.value.receipt.commandHash !== read.idempotency.value.commandHash
    ) {
        throw new ClientMutationRejectedError('Client idempotency read is invalid');
    }
}

function validateNullableEntryValue(
    value: unknown,
    label: string,
    validateValue: (value: unknown, label: string) => void
): void {
    if (value === null) {
        return;
    }
    const wrapped = requirePlainRecord(value, label);
    requireExactKeys(wrapped, ['entry', 'value'], label);
    validateClientRuntimeStateEntry(wrapped.entry, `${label}.entry`);
    validateValue(wrapped.value, `${label}.value`);
}
