import {
    rejectClientMutation,
    requireExactKeys,
    requireNonEmptyString,
    requireNullableNonEmptyString,
    requirePlainRecord,
    requirePositiveSafeInteger,
    requireSha256,
    requireTimestamp,
    validateClientPrincipalRef
} from '../../client-state-validation-primitives.ts';
import type { ClientValidationRecord } from '../../client-state-validation-primitives.ts';
import { CLIENT_MUTATION_OPERATIONS, type ClientMutationCommand } from '../client-mutation-contracts.ts';
import { validateClientMutationOperationInput } from './validate-client-mutation-operation-input.ts';

export function validateClientMutationCommand(
    command: unknown
): asserts command is ClientMutationCommand {
    const value = requirePlainRecord(command, 'Client mutation command');
    const operation = value.operation;
    if (!CLIENT_MUTATION_OPERATIONS.has(operation as never)) {
        rejectClientMutation('Client mutation command operation is invalid');
    }
    requireNonEmptyString(value.commandId, 'Client mutation commandId');
    requireNullableNonEmptyString(value.requestId, 'Client mutation requestId');
    validateClientPrincipalRef(value.aggregateRef, 'Client mutation aggregateRef');
    validateClientMutationFacts(value.facts);
    validateClientMutationAuthority(value.authority);
    const input = requirePlainRecord(value.input, 'Client mutation input');
    validateClientMutationOperationInput({
        operation: operation as ClientMutationCommand['operation'],
        input,
        commandRoot: value
    });
}

export function validateClientMutationFacts(facts: unknown): void {
    const value = requirePlainRecord(facts, 'Client mutation facts');
    requireExactKeys(
        value,
        [
            'nowEpochMs',
            'serviceId',
            'eventId',
            'commandHash',
            'attemptCount',
            'expireAtEpochMs'
        ],
        'Client mutation facts'
    );
    requireTimestamp(value.nowEpochMs, 'Client mutation facts.nowEpochMs');
    requireNonEmptyString(value.serviceId, 'Client mutation facts.serviceId');
    requireNonEmptyString(value.eventId, 'Client mutation facts.eventId');
    requireSha256(value.commandHash, 'Client mutation facts.commandHash');
    requirePositiveSafeInteger(value.attemptCount, 'Client mutation facts.attemptCount');
    requireTimestamp(value.expireAtEpochMs, 'Client mutation facts.expireAtEpochMs');
    if ((value.expireAtEpochMs as number) <= (value.nowEpochMs as number)) {
        rejectClientMutation('Client mutation facts.expireAtEpochMs must follow nowEpochMs');
    }
}

function validateClientMutationAuthority(authority: unknown): void {
    const value = requirePlainRecord(authority, 'Client mutation authority');
    if (value.kind === 'issued-session') {
        validateIssuedSessionAuthority(value);
        return;
    }
    if (value.kind === 'system') {
        requireExactKeys(
            value,
            ['kind', 'version', 'serviceId', 'operation'],
            'Client mutation system authority'
        );
        if (value.version !== 1 || value.operation !== 'expireSession') {
            rejectClientMutation('Client mutation system authority is invalid');
        }
        requireNonEmptyString(value.serviceId, 'Client mutation authority.serviceId');
        return;
    }
    rejectClientMutation('Client mutation authority kind is invalid');
}

function validateIssuedSessionAuthority(value: ClientValidationRecord): void {
    requireExactKeys(
        value,
        [
            'kind',
            'version',
            'principalId',
            'sessionId',
            'sessionIssuedAtEpochMs',
            'sessionExpiresAtEpochMs',
            'applicationId',
            'workspaceId',
            'operation'
        ],
        'Client mutation issued-session authority'
    );
    if (
        value.version !== 1 ||
        value.operation === 'expireSession' ||
        !CLIENT_MUTATION_OPERATIONS.has(value.operation as never)
    ) {
        rejectClientMutation('Client mutation issued-session authority is invalid');
    }
    for (const field of ['principalId', 'sessionId', 'applicationId', 'workspaceId'] as const) {
        requireNonEmptyString(value[field], `Client mutation authority.${field}`);
    }
    requireTimestamp(
        value.sessionIssuedAtEpochMs,
        'Client mutation authority.sessionIssuedAtEpochMs'
    );
    requireTimestamp(
        value.sessionExpiresAtEpochMs,
        'Client mutation authority.sessionExpiresAtEpochMs'
    );
    if ((value.sessionExpiresAtEpochMs as number) <= (value.sessionIssuedAtEpochMs as number)) {
        rejectClientMutation('Client mutation authority expiry must follow issuance');
    }
}
