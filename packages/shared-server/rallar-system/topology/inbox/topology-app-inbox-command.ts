import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import {
    fromCanonicalGroupTopologyConfigPatch,
    readCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch
} from '@shared/api/group-topology-config-canonical.ts';

import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import { hashCanonicalCommand } from '../../app-inbox/hash-canonical-command.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import { GroupMutationAuthorizationError } from '../../group-state/group-mutation-authority.ts';
import type { GroupTopologyConfigMutationCommand } from '../config/mutation/group-topology-config-mutation-contracts.ts';
import type {
    CreateTopologyAppInboxCommandInput,
    TopologyAppInboxCommand,
    TopologyAppInboxPayload,
    TopologyAppInboxRequestPayload
} from './topology-app-inbox-contracts.ts';

type TopologyRecord = Record<string, unknown>;

interface TopologyConfigMutationCommandInput {
    readonly command: TopologyAppInboxCommand;
    readonly config: GroupTopologyConfigPatch | null;
    readonly ttlMs: number | null;
    readonly expiresAtEpochMs: number | null;
}

export async function toTopologyAppInboxCommand(
    input: CreateTopologyAppInboxCommandInput
): Promise<TopologyAppInboxCommand> {
    if (
        input.requestId.length === 0 ||
        input.actor.principalId.length === 0 ||
        input.actor.sessionId.length === 0 ||
        input.groupRef.applicationId.length === 0 ||
        input.groupRef.workspaceId.length === 0 ||
        input.groupRef.groupId.length === 0 ||
        !isTopologyAppInboxRequestPayload(input.payload) ||
        !Number.isSafeInteger(input.capturedAtEpochMs) ||
        input.capturedAtEpochMs < 0
    ) {
        throw new TypeError('Topology AppInbox command identity is invalid');
    }
    const payload = toCanonicalTopologyAppInboxPayload(input.payload);
    const stableCommand = {
        actor: { ...input.actor },
        groupRef: {
            applicationId: input.groupRef.applicationId,
            workspaceId: input.groupRef.workspaceId,
            groupId: input.groupRef.groupId
        },
        requestId: input.requestId,
        operation: payload.operation,
        payload
    } as const;
    return {
        ...stableCommand,
        capturedAtEpochMs: input.capturedAtEpochMs,
        commandHash: await hashCanonicalCommand(stableCommand)
    } as TopologyAppInboxCommand;
}

export async function toTopologyHttpMutationSemanticHash(
    input: Readonly<{
        principalId: string;
        groupRef: TopologyAppInboxCommand['groupRef'];
        requestId: string;
        payload: TopologyAppInboxRequestPayload;
    }>
): Promise<string> {
    return await hashTopologyHttpMutationSemantic({
        ...input,
        payload: toCanonicalTopologyAppInboxPayload(input.payload)
    });
}

export async function toPersistedTopologyHttpMutationSemanticHash(
    command: TopologyAppInboxCommand
): Promise<string> {
    return await hashTopologyHttpMutationSemantic({
        principalId: command.actor.principalId,
        groupRef: command.groupRef,
        requestId: command.requestId,
        payload: command.payload
    });
}

async function hashTopologyHttpMutationSemantic(
    input: Readonly<{
        principalId: string;
        groupRef: TopologyAppInboxCommand['groupRef'];
        requestId: string;
        payload: TopologyAppInboxPayload;
    }>
): Promise<string> {
    return await hashCanonicalCommand({
        operation: input.payload.operation,
        requestId: input.requestId,
        callerId: input.principalId,
        groupRef: input.groupRef,
        payload: input.payload
    });
}

export async function readAuthenticatedTopologyCommand<V>(
    enqueue: AppInboxEnqueueInput<V>,
    authority: IssuedAuthSession
): Promise<TopologyAppInboxCommand> {
    return await readTopologyCommandForValidatedSession(enqueue, {
        principalId: authority.clientId,
        sessionId: authority.sessionId
    });
}

export async function readTopologyCommandForValidatedSession<V>(
    enqueue: AppInboxEnqueueInput<V>,
    expectedActor: Readonly<{ principalId: string; sessionId: string; }>
): Promise<TopologyAppInboxCommand> {
    const command = enqueue.data as TopologyAppInboxCommand;
    if (
        !command ||
        typeof command !== 'object' ||
        !command.actor ||
        typeof command.actor !== 'object' ||
        typeof command.actor.principalId !== 'string' ||
        typeof command.actor.sessionId !== 'string' ||
        !command.groupRef ||
        typeof command.groupRef !== 'object' ||
        typeof command.operation !== 'string' ||
        !isTopologyAppInboxPayload(command.payload) ||
        command.payload.operation !== command.operation ||
        command.actor.principalId !== expectedActor.principalId ||
        command.actor.sessionId !== expectedActor.sessionId ||
        toTopologyAppInboxType(command.operation) !== enqueue.type
    ) {
        throw new GroupMutationAuthorizationError(
            'Topology AppInbox command does not match authenticated authority.'
        );
    }
    const stableCommand = {
        actor: command.actor,
        groupRef: command.groupRef,
        requestId: command.requestId,
        operation: command.operation,
        payload: command.payload
    };
    if ((await hashCanonicalCommand(stableCommand)) !== command.commandHash) {
        throw new GroupMutationAuthorizationError('Topology AppInbox command hash is invalid.');
    }
    return command;
}

export function toTopologyHttpMutationContextId(
    groupRef: TopologyAppInboxCommand['groupRef'],
    callerId: string
): string {
    return [
        ['application', groupRef.applicationId],
        ['workspace', groupRef.workspaceId],
        ['group', groupRef.groupId],
        ['caller', callerId]
    ]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join(':');
}

export function readDurableTopologyAppInboxCommand(value: unknown): TopologyAppInboxCommand {
    if (!isRecord(value)) {
        throw new TypeError('topology command is invalid');
    }
    requireExactKeys(value, [
        'actor',
        'groupRef',
        'requestId',
        'commandHash',
        'capturedAtEpochMs',
        'operation',
        'payload'
    ]);
    if (!isTopologyAppInboxPayload(value.payload)) {
        throw new TypeError('topology command payload is invalid');
    }
    const actor = isRecord(value.actor) ? value.actor : null;
    const groupRef = isRecord(value.groupRef) ? value.groupRef : null;
    if (!actor || !groupRef) {
        throw new TypeError('topology identity is invalid');
    }
    requireExactKeys(actor, ['principalId', 'sessionId']);
    requireExactKeys(groupRef, ['applicationId', 'workspaceId', 'groupId']);
    if (!hasValidTopologyCommandIdentity(value, actor, groupRef)) {
        throw new TypeError('topology command identity fields are invalid');
    }
    return value as TopologyAppInboxCommand;
}

export function toTopologyConfigMutationCommand(
    command: TopologyAppInboxCommand
): GroupTopologyConfigMutationCommand {
    switch (command.payload.operation) {
        case 'putConfig':
            return topologyConfigMutationCommand({
                command,
                config: fromCanonicalGroupTopologyConfigPatch(command.payload.config),
                ttlMs: null,
                expiresAtEpochMs: null
            });
        case 'deleteConfig':
            return topologyConfigMutationCommand({
                command,
                config: null,
                ttlMs: null,
                expiresAtEpochMs: null
            });
        case 'putOverride':
            return topologyConfigMutationCommand({
                command,
                config: fromCanonicalGroupTopologyConfigPatch(command.payload.config),
                ttlMs: command.payload.ttlMs,
                expiresAtEpochMs: command.payload.expiresAtEpochMs
            });
        case 'deleteOverride':
            return topologyConfigMutationCommand({
                command,
                config: null,
                ttlMs: null,
                expiresAtEpochMs: null
            });
        case 'reconfigureTopology':
            throw new TypeError('Reconfigure is not a topology config mutation');
    }
}

export function requireExactTopologyKeys(
    record: TopologyRecord,
    expected: readonly string[]
): void {
    requireExactKeys(record, expected);
}

export function isTopologyRecord(value: unknown): value is TopologyRecord {
    return isRecord(value);
}

function isTopologyAppInboxRequestPayload(value: unknown): value is TopologyAppInboxRequestPayload {
    if (!isRecord(value) || typeof value.operation !== 'string') {
        return false;
    }
    try {
        switch (value.operation) {
            case 'putConfig':
                requireExactKeys(value, ['operation', 'config']);
                toCanonicalGroupTopologyConfigPatch(value.config);
                return true;
            case 'deleteConfig':
                requireExactKeys(value, ['operation', 'target']);
                return value.target === 'config';
            case 'putOverride':
                requireExactKeys(value, ['operation', 'config', 'ttlMs', 'expiresAtEpochMs']);
                toCanonicalGroupTopologyConfigPatch(value.config);
                return isFiniteNumberOrNull(value.ttlMs) && isFiniteNumberOrNull(value.expiresAtEpochMs);
            case 'deleteOverride':
                requireExactKeys(value, ['operation', 'target']);
                return value.target === 'override';
            case 'reconfigureTopology':
                requireExactKeys(value, ['operation', 'requestOptions', 'publish']);
                toCanonicalGroupTopologyConfigPatch(value.requestOptions);
                return typeof value.publish === 'boolean';
            default:
                return false;
        }
    }
    catch {
        return false;
    }
}

function isTopologyAppInboxPayload(value: unknown): value is TopologyAppInboxPayload {
    if (!isRecord(value)) {
        return false;
    }
    const record = value;
    if (typeof record.operation !== 'string') {
        return false;
    }
    try {
        switch (record.operation) {
            case 'putConfig':
                requireExactKeys(record, ['operation', 'config']);
                readCanonicalGroupTopologyConfigPatch(record.config);
                return true;
            case 'deleteConfig':
                requireExactKeys(record, ['operation', 'target']);
                return record.target === 'config';
            case 'putOverride':
                requireExactKeys(record, ['operation', 'config', 'ttlMs', 'expiresAtEpochMs']);
                readCanonicalGroupTopologyConfigPatch(record.config);
                return isFiniteNumberOrNull(record.ttlMs) && isFiniteNumberOrNull(record.expiresAtEpochMs);
            case 'deleteOverride':
                requireExactKeys(record, ['operation', 'target']);
                return record.target === 'override';
            case 'reconfigureTopology':
                requireExactKeys(record, ['operation', 'requestOptions', 'publish']);
                readCanonicalGroupTopologyConfigPatch(record.requestOptions);
                return typeof record.publish === 'boolean';
            default:
                return false;
        }
    }
    catch {
        return false;
    }
}

function toCanonicalTopologyAppInboxPayload(
    payload: TopologyAppInboxRequestPayload
): TopologyAppInboxPayload {
    switch (payload.operation) {
        case 'putConfig':
            return {
                operation: payload.operation,
                config: toCanonicalGroupTopologyConfigPatch(payload.config)
            };
        case 'deleteConfig':
        case 'deleteOverride':
            return { ...payload };
        case 'putOverride':
            return {
                ...payload,
                config: toCanonicalGroupTopologyConfigPatch(payload.config)
            };
        case 'reconfigureTopology':
            return {
                ...payload,
                requestOptions: toCanonicalGroupTopologyConfigPatch(payload.requestOptions)
            };
    }
}

export function toTopologyAppInboxType(
    operation: TopologyAppInboxCommand['operation']
): AppInboxType {
    switch (operation) {
        case 'putConfig':
            return AppInboxType.TOPOLOGY_CONFIG_PUT;
        case 'deleteConfig':
            return AppInboxType.TOPOLOGY_CONFIG_DELETE;
        case 'putOverride':
            return AppInboxType.TOPOLOGY_OVERRIDE_PUT;
        case 'deleteOverride':
            return AppInboxType.TOPOLOGY_OVERRIDE_DELETE;
        case 'reconfigureTopology':
            return AppInboxType.TOPOLOGY_RECONFIGURE;
    }
}

function topologyConfigMutationCommand(
    input: TopologyConfigMutationCommandInput
): GroupTopologyConfigMutationCommand {
    const { command, config, expiresAtEpochMs, ttlMs } = input;
    if (command.operation === 'reconfigureTopology') {
        throw new TypeError('Reconfigure is not a topology config mutation');
    }
    return {
        operation: command.operation,
        aggregateRef: command.groupRef,
        commandId: command.requestId,
        requestId: command.requestId,
        input: {
            config,
            updatedByPrincipalId: command.actor.principalId,
            ttlMs,
            expiresAtEpochMs
        }
    };
}

function hasValidTopologyCommandIdentity(
    value: TopologyRecord,
    actor: TopologyRecord,
    groupRef: TopologyRecord
): boolean {
    return (
        typeof actor.principalId === 'string' &&
        actor.principalId.length > 0 &&
        typeof actor.sessionId === 'string' &&
        actor.sessionId.length > 0 &&
        typeof groupRef.applicationId === 'string' &&
        groupRef.applicationId.length > 0 &&
        typeof groupRef.workspaceId === 'string' &&
        groupRef.workspaceId.length > 0 &&
        typeof groupRef.groupId === 'string' &&
        groupRef.groupId.length > 0 &&
        typeof value.requestId === 'string' &&
        value.requestId.length > 0 &&
        typeof value.commandHash === 'string' &&
        Number.isSafeInteger(value.capturedAtEpochMs) &&
        (value.capturedAtEpochMs as number) >= 0 &&
        value.operation === (value.payload as TopologyAppInboxPayload).operation
    );
}

function isRecord(value: unknown): value is TopologyRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(record: TopologyRecord, expected: readonly string[]): void {
    if (JSON.stringify(Object.keys(record).toSorted()) !== JSON.stringify([...expected].toSorted())) {
        throw new TypeError('Topology durable command has missing or unknown fields');
    }
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}
