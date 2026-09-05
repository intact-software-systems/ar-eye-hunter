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
import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import { decodeClientValidationRecord, requireExactKeys } from '../../validation/client-record-validation.ts';
import { assertClientExpiredSessionAuthority } from '../assert-client-expired-session-authority.ts';
import type { ClientMutationCommand, ClientMutationRead } from '../client-mutation-contracts.ts';

export function assertClientMutationRead(
    command: ClientMutationCommand,
    read: ClientMutationRead
): void {
    const root = decodeClientValidationRecord(read, 'Client mutation read');
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
    assertNullableEntryValue(read.principal, 'Client principal read', validateClientPrincipal);
    assertNullableEntryValue(read.instance, 'Client instance read', validateClientInstance);
    assertNullableEntryValue(read.session, 'Client session read', validateClientSession);
    assertClientExpiredSessionAuthority({
        aggregateRef: command.aggregateRef,
        clientInstanceId: 'clientInstanceId' in command ? command.clientInstanceId : null,
        sessionId: 'sessionId' in command ? command.sessionId : null,
        liveSession: read.session,
        expiredSessionEntry: read.expiredSessionEntry
    });
    assertNullableEntryValue(
        read.idempotency,
        'Client idempotency read',
        validateClientMutationIdempotencyRecordValue
    );
    assertClientMutationSnapshotRead(command, read);
    assertClientMutationReadScope(command, read);
}

function assertClientMutationSnapshotRead(
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

function assertClientMutationReadScope(
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
    assertClientMutationSessionReadScope(command, read);
    assertClientMutationIdempotencyRead(command, read);
}

function assertClientMutationSessionReadScope(
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

function assertClientMutationIdempotencyRead(
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

function assertNullableEntryValue(
    value: unknown,
    label: string,
    assertValue: (value: unknown, label: string) => void
): void {
    if (value === null) {
        return;
    }
    const wrapped = decodeClientValidationRecord(value, label);
    requireExactKeys(wrapped, ['entry', 'value'], label);
    validateClientRuntimeStateEntry(wrapped.entry, `${label}.entry`);
    assertValue(wrapped.value, `${label}.value`);
}
