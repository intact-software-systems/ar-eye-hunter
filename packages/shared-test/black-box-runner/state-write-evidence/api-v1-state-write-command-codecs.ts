import { decodeAdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import { decodeAuthMutationIntent } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-intent.ts';
import { decodeCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import { validateRtcRttMeasurement } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
    decodeJsonWireValue,
    type JsonWireValue
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

export interface ExactStandaloneCommandIdsInput {
    readonly type: AppInboxType;
    readonly data: unknown;
    readonly authority: unknown;
    readonly fallback: string;
}

export function readExactStandaloneCommandIds(
    input: ExactStandaloneCommandIdsInput
): readonly string[] {
    const { type, data, authority, fallback } = input;
    if (type.startsWith('AUTH_')) {
        const intent = decodeAuthMutationIntent(data as JsonWireValue);
        if (intent.kind !== authKind(type)) {
            throw new TypeError('auth command kind differs from type');
        }
        return [intent.requestId];
    }
    if (type.startsWith('CRDT_')) {
        const command = decodeCrdtMutationCommand(data);
        if (type === AppInboxType.CRDT_UPDATE_APPEND && command.operation !== 'append') {
            throw new TypeError('CRDT command operation differs from type');
        }
        return [command.commandId, command.deliveryId];
    }
    if (type === AppInboxType.ADMIN_PRUNE_EXPIRED) {
        return [decodeAdminPruneCommand(decodeJsonWireValue(data, 'Admin prune command')).jobId];
    }
    if (type === AppInboxType.RTC_RTT_SUBMIT) {
        return [readRtcRttRequestId(data)];
    }
    if (type === AppInboxType.TOPOLOGY_RECONFIGURE) {
        return [readTopologyReconfigureCommand(authority).requestId];
    }
    if (type === AppInboxType.CLIENT_EXPIRED_SESSIONS) {
        const command = readExactRecord(data, ['atEpochMs'], 'client expiry command');
        if (!Number.isSafeInteger(command.atEpochMs)) {
            throw new TypeError('client expiry timestamp is invalid');
        }
        return [fallback];
    }
    if (type === AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP) {
        const cleanup = readGroupSessionCleanupCommand(data);
        return [cleanup.sessionId, cleanup.generationId];
    }
    return [fallback];
}

export function readTopologyReconfigureCommand(authority: unknown) {
    const durable = readRecord(authority, 'topology reconfigure authority');
    const command = readExactRecord(
        durable.command,
        ['actor', 'groupRef', 'requestId', 'commandHash', 'capturedAtEpochMs', 'operation', 'payload'],
        'topology reconfigure command'
    );
    if (command.operation !== 'reconfigureTopology') {
        throw new TypeError('topology reconfigure operation differs from type');
    }
    return {
        requestId: readString(command.requestId, 'topology reconfigure requestId'),
        groupRef: readGroupRef(command.groupRef)
    };
}

export function readGroupSessionCleanupCommand(data: unknown) {
    const cleanup = readExactRecord(
        data,
        ['connection', 'disconnectedAtEpochMs', 'reason'],
        'group session cleanup command'
    );
    const connection = readExactRecord(
        cleanup.connection,
        [
            'authSession',
            'generationId',
            'generationStartedAtEpochMs',
            'scope',
            'principalId',
            'clientInstanceId',
            'displayName',
            'userAgent',
            'platform',
            'capabilities',
            'expiresAtEpochMs'
        ],
        'group session cleanup connection'
    );
    const authSession = readExactRecord(
        connection.authSession,
        ['clientId', 'username', 'sessionId', 'expiresAtEpochMs', 'issuedAtEpochMs'],
        'group session cleanup auth session'
    );
    readScope(connection.scope);
    readString(connection.principalId, 'group session cleanup principalId');
    readString(connection.clientInstanceId, 'group session cleanup clientInstanceId');
    readString(connection.displayName, 'group session cleanup displayName');
    if (connection.userAgent !== null) {
        readString(connection.userAgent, 'group session cleanup userAgent');
    }
    readRecord(connection.platform, 'group session cleanup platform');
    if (
        !Array.isArray(connection.capabilities) ||
        !connection.capabilities.every((capability) => typeof capability === 'string')
    ) {
        throw new TypeError('group session cleanup capabilities are invalid');
    }
    for (
        const [label, value] of [
            ['generationStartedAtEpochMs', connection.generationStartedAtEpochMs],
            ['expiresAtEpochMs', connection.expiresAtEpochMs],
            ['disconnectedAtEpochMs', cleanup.disconnectedAtEpochMs],
            ['auth expiresAtEpochMs', authSession.expiresAtEpochMs],
            ['auth issuedAtEpochMs', authSession.issuedAtEpochMs]
        ] as const
    ) {
        if (!Number.isSafeInteger(value)) {
            throw new TypeError(`${label} is invalid`);
        }
    }
    readString(cleanup.reason, 'group session cleanup reason');
    return {
        sessionId: readString(authSession.sessionId, 'group session cleanup sessionId'),
        generationId: readString(connection.generationId, 'group session cleanup generationId')
    };
}

export function isGeneralClientCommand(type: AppInboxType): boolean {
    return (
        [
            AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            AppInboxType.CLIENT_INSTANCE_UPSERT,
            AppInboxType.CLIENT_SESSION_CONNECT,
            AppInboxType.CLIENT_SESSION_HEARTBEAT,
            AppInboxType.CLIENT_SESSION_DISCONNECT
        ] as readonly AppInboxType[]
    ).includes(type);
}

export function isTopologyConfigCommand(type: AppInboxType): boolean {
    return type.startsWith('TOPOLOGY_CONFIG_') || type.startsWith('TOPOLOGY_OVERRIDE_');
}

export function clientPayloadKeys(type: AppInboxType): readonly string[] {
    if (type === AppInboxType.CLIENT_PRINCIPAL_UPSERT) {
        return ['scope', 'principalId', 'request'];
    }
    if (type === AppInboxType.CLIENT_INSTANCE_UPSERT) {
        return ['scope', 'principalId', 'clientInstanceId', 'request'];
    }
    return ['scope', 'principalId', 'clientInstanceId', 'sessionId', 'request'];
}

export function readScope(value: unknown) {
    const scope = readExactRecord(value, ['applicationId', 'workspaceId'], 'client scope');
    return {
        applicationId: readString(scope.applicationId, 'applicationId'),
        workspaceId: readString(scope.workspaceId, 'workspaceId')
    };
}

export function readGroupRef(value: unknown) {
    const ref = readExactRecord(value, ['applicationId', 'workspaceId', 'groupId'], 'group ref');
    return {
        applicationId: readString(ref.applicationId, 'applicationId'),
        workspaceId: readString(ref.workspaceId, 'workspaceId'),
        groupId: readString(ref.groupId, 'groupId')
    };
}

export function readExactRecord(
    value: unknown,
    keys: readonly string[],
    label: string
): Record<string, unknown> {
    const candidate = readRecord(value, label);
    if (JSON.stringify(Object.keys(candidate).toSorted()) !== JSON.stringify([...keys].toSorted())) {
        throw new TypeError(`${label} keys are invalid`);
    }
    return candidate;
}

export function readRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

export function readString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function authKind(type: AppInboxType): string {
    const kinds: Readonly<Partial<Record<AppInboxType, string>>> = {
        [AppInboxType.AUTH_USER_REGISTER]: 'register-user',
        [AppInboxType.AUTH_SESSION_ISSUE]: 'issue-session',
        [AppInboxType.AUTH_SESSION_LOGOUT]: 'logout-session',
        [AppInboxType.AUTH_WS_TICKET_ISSUE]: 'issue-ws-ticket',
        [AppInboxType.AUTH_WS_TICKET_CONSUME]: 'consume-ws-ticket',
        [AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE]: 'issue-agent-tickets',
        [AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME]: 'consume-agent-ticket'
    };
    const kind = kinds[type];
    if (!kind) {
        throw new TypeError('auth command type is unsupported');
    }
    return kind;
}

function readRtcRttRequestId(value: unknown): string {
    const command = readExactRecord(
        value,
        ['actor', 'requestId', 'commandHash', 'mutationCommandHash', 'capturedAtEpochMs', 'rtt'],
        'RTC RTT command'
    );
    const actor = readExactRecord(command.actor, ['principalId', 'sessionId'], 'RTC RTT actor');
    readString(actor.principalId, 'RTC RTT principalId');
    readString(actor.sessionId, 'RTC RTT sessionId');
    const requestId = readString(command.requestId, 'RTC RTT requestId');
    readString(command.commandHash, 'RTC RTT commandHash');
    readString(command.mutationCommandHash, 'RTC RTT mutationCommandHash');
    if (!Number.isSafeInteger(command.capturedAtEpochMs)) {
        throw new TypeError('RTC RTT capture timestamp is invalid');
    }
    validateRtcRttMeasurement(command.rtt);
    return requestId;
}
