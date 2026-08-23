import {
    rejectClientMutation,
    requireExactKeys,
    requireNonEmptyString,
    requireNullableEnum,
    requireNullableJsonRecord,
    requireNullableNonEmptyString,
    requireNullableString,
    requireNullableStringArray,
    requireNullableTimestamp,
    requirePositiveSafeInteger,
    requireTimestamp
} from '../../client-state-validation-primitives.ts';
import type { ClientValidationRecord } from '../../client-state-validation-primitives.ts';
import {
    CLIENT_INSTANCE_STATUSES,
    CLIENT_PLATFORMS,
    CLIENT_PRESENCE_STATES,
    CLIENT_PRINCIPAL_STATUSES,
    CLIENT_TRANSPORTS,
    type ClientMutationOperation
} from '../client-mutation-contracts.ts';

type OperationInputValidation = Readonly<{
    operation: ClientMutationOperation;
    input: ClientValidationRecord;
    commandRoot: ClientValidationRecord;
}>;

export function validateClientMutationOperationInput(validation: OperationInputValidation): void {
    validateActorInput(validation.input);
    switch (validation.operation) {
        case 'upsertPrincipal':
            return validatePrincipalInput(validation);
        case 'upsertInstance':
            return validateInstanceInput(validation);
        case 'connectSession':
        case 'connectAuthorisedWsSession':
            return validateConnectInput(validation);
        case 'heartbeatSession':
            return validateHeartbeatInput(validation);
        case 'disconnectSession':
        case 'disconnectAuthorisedWsSession':
            return validateDisconnectInput(validation);
        case 'expireSession':
            return validateExpiryInput(validation);
    }
}

function validatePrincipalInput(validation: OperationInputValidation): void {
    validateRoot(validation, 'Client principal command');
    requireExactKeys(validation.input, principalInputKeys, 'Client principal input');
    requireNonEmptyString(validation.input.username, 'Client principal username');
    requireNullableString(validation.input.displayName, 'Client principal displayName');
    requireNullableString(validation.input.avatarUrl, 'Client principal avatarUrl');
    requireNullableEnum(
        validation.input.status,
        CLIENT_PRINCIPAL_STATUSES,
        'Client principal status'
    );
    requireNullableString(validation.input.authProvider, 'Client principal authProvider');
    requireNullableString(validation.input.externalSubjectId, 'Client principal externalSubjectId');
    requireNullableStringArray(validation.input.roles, 'Client principal roles');
    requireNullableJsonRecord(validation.input.metadata, 'Client principal metadata');
    requireNullableTimestamp(
        validation.input.lastSeenAtEpochMs,
        'Client principal lastSeenAtEpochMs'
    );
}

function validateInstanceInput(validation: OperationInputValidation): void {
    validateRoot(validation, 'Client instance command', true);
    requireExactKeys(validation.input, instanceInputKeys, 'Client instance input');
    requireNullableEnum(validation.input.status, CLIENT_INSTANCE_STATUSES, 'Client instance status');
    requireNullableEnum(validation.input.platform, CLIENT_PLATFORMS, 'Client instance platform');
    for (const field of ['deviceLabel', 'appVersion', 'userAgent'] as const) {
        requireNullableString(validation.input[field], `Client instance ${field}`);
    }
    requireNullableStringArray(validation.input.capabilities, 'Client instance capabilities');
}

function validateConnectInput(validation: OperationInputValidation): void {
    validateSessionRoot(validation);
    requireExactKeys(validation.input, connectInputKeys, 'Client connect input');
    validateGenerationId(validation.input.generationId);
    requireNullableEnum(
        validation.input.presenceState,
        CLIENT_PRESENCE_STATES,
        'Client connect presenceState'
    );
    requireNullableEnum(validation.input.transport, CLIENT_TRANSPORTS, 'Client connect transport');
    requireNullableNonEmptyString(validation.input.connectionId, 'Client connect connectionId');
    for (const field of connectTimestampFields) {
        requireNullableTimestamp(validation.input[field], `Client connect ${field}`);
    }
    validateCommandConnectAdditions(validation.input);
    validateConnectTimestampOrder(validation.input);
}

function validateCommandConnectAdditions(input: ClientValidationRecord): void {
    requireNullableEnum(input.instancePlatform, CLIENT_PLATFORMS, 'Client connect instancePlatform');
    requireNullableString(input.instanceUserAgent, 'Client connect instanceUserAgent');
    requireNullableStringArray(input.instanceCapabilities, 'Client connect instanceCapabilities');
    requireNullableNonEmptyString(input.principalUsername, 'Client connect principalUsername');
    requireNullableNonEmptyString(input.principalDisplayName, 'Client connect principalDisplayName');
    requireNullableStringArray(input.principalRoles, 'Client connect principalRoles');
}

function validateHeartbeatInput(validation: OperationInputValidation): void {
    validateSessionRoot(validation);
    requireExactKeys(validation.input, heartbeatInputKeys, 'Client heartbeat input');
    validateGenerationId(validation.input.generationId);
    requireNullableEnum(
        validation.input.presenceState,
        CLIENT_PRESENCE_STATES,
        'Client heartbeat presenceState'
    );
    requireNullableTimestamp(
        validation.input.lastHeartbeatAtEpochMs,
        'Client heartbeat lastHeartbeatAtEpochMs'
    );
    requireNullableTimestamp(validation.input.expiresAtEpochMs, 'Client heartbeat expiresAtEpochMs');
    validateHeartbeatTimestampOrder(validation.input);
}

function validateDisconnectInput(validation: OperationInputValidation): void {
    validateSessionRoot(validation);
    requireExactKeys(validation.input, disconnectInputKeys, 'Client disconnect input');
    validateGenerationId(validation.input.generationId);
    for (const field of disconnectTimestampFields) {
        requireNullableTimestamp(validation.input[field], `Client disconnect ${field}`);
    }
    validateDisconnectTimestampOrder(validation.input);
}

function validateExpiryInput(validation: OperationInputValidation): void {
    validateSessionRoot(validation);
    requireExactKeys(validation.input, expiryInputKeys, 'Client expiry input');
    validateGenerationId(validation.input.generationId);
    requirePositiveSafeInteger(validation.input.generationVersion, 'Client expiry generationVersion');
    requireTimestamp(
        validation.input.observedExpiresAtEpochMs,
        'Client expiry observedExpiresAtEpochMs'
    );
    requireTimestamp(validation.input.expiresAtEpochMs, 'Client expiry expiresAtEpochMs');
    if (validation.input.expiresAtEpochMs < validation.input.observedExpiresAtEpochMs) {
        rejectClientMutation(
            'Client expiry expiresAtEpochMs must not predate observedExpiresAtEpochMs'
        );
    }
}

function validateRoot(validation: OperationInputValidation, label: string, instance = false): void {
    const root = validation.commandRoot;
    requireExactKeys(root, instance ? instanceCommandKeys : commandBaseKeys, label);
    if (instance) {
        requireNonEmptyString(root.clientInstanceId, 'Client instance id');
    }
}

function validateSessionRoot(validation: OperationInputValidation): void {
    const root = validation.commandRoot;
    requireExactKeys(root, sessionCommandKeys, 'Client session command');
    requireNonEmptyString(root.clientInstanceId, 'Client session clientInstanceId');
    requireNonEmptyString(root.sessionId, 'Client session sessionId');
}

function validateActorInput(input: ClientValidationRecord): void {
    requireNullableNonEmptyString(input.actorPrincipalId, 'Client mutation actorPrincipalId');
    requireNullableNonEmptyString(input.actorSessionId, 'Client mutation actorSessionId');
    requireNullableString(input.reason, 'Client mutation reason');
    requireNullableString(input.traceId, 'Client mutation traceId');
}

function validateGenerationId(value: unknown): void {
    requireNonEmptyString(value, 'Client session generationId');
}

function validateConnectTimestampOrder(input: ClientValidationRecord): void {
    const authenticatedAt = timestampValue(input.authenticatedAtEpochMs);
    const connectedAt = timestampValue(input.connectedAtEpochMs);
    const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
    const expiresAt = timestampValue(input.expiresAtEpochMs);
    if (authenticatedAt !== undefined && connectedAt !== undefined && authenticatedAt > connectedAt) {
        rejectClientMutation(
            'Client connect authenticatedAtEpochMs must not follow connectedAtEpochMs'
        );
    }
    if (connectedAt !== undefined && heartbeatAt !== undefined && connectedAt > heartbeatAt) {
        rejectClientMutation(
            'Client connect lastHeartbeatAtEpochMs must not predate connectedAtEpochMs'
        );
    }
    if (heartbeatAt !== undefined && expiresAt !== undefined && heartbeatAt > expiresAt) {
        rejectClientMutation('Client connect expiresAtEpochMs must not predate lastHeartbeatAtEpochMs');
    }
}

function validateHeartbeatTimestampOrder(input: ClientValidationRecord): void {
    const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
    const expiresAt = timestampValue(input.expiresAtEpochMs);
    if (heartbeatAt !== undefined && expiresAt !== undefined && expiresAt < heartbeatAt) {
        rejectClientMutation(
            'Client heartbeat expiresAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    }
}

function validateDisconnectTimestampOrder(input: ClientValidationRecord): void {
    const disconnectedAt = timestampValue(input.disconnectedAtEpochMs);
    const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
    const expiresAt = timestampValue(input.expiresAtEpochMs);
    if (disconnectedAt !== undefined && heartbeatAt !== undefined && disconnectedAt < heartbeatAt) {
        rejectClientMutation(
            'Client disconnect disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    }
    if (expiresAt !== undefined && heartbeatAt !== undefined && expiresAt < heartbeatAt) {
        rejectClientMutation(
            'Client disconnect expiresAtEpochMs must not predate lastHeartbeatAtEpochMs'
        );
    }
}

function timestampValue(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

const actorInputKeys = ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId'] as const;
const commandBaseKeys = [
    'operation',
    'aggregateRef',
    'commandId',
    'requestId',
    'authority',
    'facts',
    'input'
] as const;
const instanceCommandKeys = [...commandBaseKeys, 'clientInstanceId'] as const;
const sessionCommandKeys = [...instanceCommandKeys, 'sessionId'] as const;
const principalInputKeys = [
    'username',
    'displayName',
    'avatarUrl',
    'status',
    'authProvider',
    'externalSubjectId',
    'roles',
    'metadata',
    'lastSeenAtEpochMs',
    ...actorInputKeys
] as const;
const instanceInputKeys = [
    'status',
    'platform',
    'deviceLabel',
    'appVersion',
    'userAgent',
    'capabilities',
    ...actorInputKeys
] as const;
const connectInputKeys = [
    'generationId',
    'presenceState',
    'transport',
    'connectionId',
    'authenticatedAtEpochMs',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
    'instancePlatform',
    'instanceUserAgent',
    'instanceCapabilities',
    'principalUsername',
    'principalDisplayName',
    'principalRoles',
    ...actorInputKeys
] as const;
const heartbeatInputKeys = [
    'generationId',
    'presenceState',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
    ...actorInputKeys
] as const;
const disconnectInputKeys = [
    'generationId',
    'disconnectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
    ...actorInputKeys
] as const;
const expiryInputKeys = [
    'generationId',
    'generationVersion',
    'observedExpiresAtEpochMs',
    'expiresAtEpochMs',
    ...actorInputKeys
] as const;
const connectTimestampFields = [
    'authenticatedAtEpochMs',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs'
] as const;
const disconnectTimestampFields = [
    'disconnectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs'
] as const;
