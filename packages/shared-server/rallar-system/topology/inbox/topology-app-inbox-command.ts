import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import {
    fromCanonicalGroupTopologyConfigPatch,
    readCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch
} from '@shared/api/group-topology-config-canonical.ts';

import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import { GroupMutationAuthorizationError } from '../../group-state/group-mutation-authority.ts';
import {
    computeMutationCommandDigest,
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
import type { GroupTopologyConfigMutationCommand } from '../config/mutation/group-topology-config-mutation-contracts.ts';
import type {
    CreateTopologyAppInboxCommandInput,
    TopologyAppInboxCommand,
    TopologyAppInboxPayload,
    TopologyAppInboxRequestPayload
} from './topology-app-inbox-contracts.ts';

interface TopologyConfigMutationCommandInput {
    readonly command: TopologyAppInboxCommand;
    readonly config: GroupTopologyConfigPatch | null;
    readonly ttlMs: number | null;
    readonly expiresAtEpochMs: number | null;
}

interface TopologyAppInboxCommandIdentity {
    readonly actor: TopologyAppInboxCommand['actor'];
    readonly groupRef: TopologyAppInboxCommand['groupRef'];
    readonly requestId: string;
    readonly commandHash: string;
    readonly capturedAtEpochMs: number;
}

export function toTopologyAppInboxCommand(
    input: CreateTopologyAppInboxCommandInput
): TopologyAppInboxCommand {
    const actor = decodeTopologyActor(
        decodeJsonWireValue(input.actor, 'Topology AppInbox actor')
    );
    const groupRef = decodeTopologyGroupRef(
        decodeJsonWireValue(input.groupRef, 'Topology AppInbox groupRef')
    );
    if (
        input.requestId.length === 0 ||
        !Number.isSafeInteger(input.capturedAtEpochMs) ||
        input.capturedAtEpochMs < 0
    ) {
        throw new TypeError('Topology AppInbox command identity is invalid');
    }
    const payload = toCanonicalTopologyAppInboxPayload(input.payload);
    const stableCommand = {
        actor,
        groupRef,
        requestId: input.requestId,
        operation: payload.operation,
        payload
    } as const;
    return toTypedTopologyAppInboxCommand(
        {
            actor,
            groupRef,
            requestId: input.requestId,
            capturedAtEpochMs: input.capturedAtEpochMs,
            commandHash: computeMutationCommandDigest(stableCommand)
        },
        payload
    );
}

export function computeTopologyHttpMutationSemanticDigest(
    input: Readonly<{
        principalId: string;
        groupRef: TopologyAppInboxCommand['groupRef'];
        requestId: string;
        payload: TopologyAppInboxRequestPayload;
    }>
): string {
    return computeCanonicalTopologyHttpMutationDigest({
        ...input,
        payload: toCanonicalTopologyAppInboxPayload(input.payload)
    });
}

export function computePersistedTopologyHttpMutationSemanticDigest(
    command: TopologyAppInboxCommand
): string {
    return computeCanonicalTopologyHttpMutationDigest({
        principalId: command.actor.principalId,
        groupRef: command.groupRef,
        requestId: command.requestId,
        payload: command.payload
    });
}

function computeCanonicalTopologyHttpMutationDigest(
    input: Readonly<{
        principalId: string;
        groupRef: TopologyAppInboxCommand['groupRef'];
        requestId: string;
        payload: TopologyAppInboxPayload;
    }>
): string {
    return computeMutationCommandDigest({
        operation: input.payload.operation,
        requestId: input.requestId,
        callerId: input.principalId,
        groupRef: input.groupRef,
        payload: input.payload
    });
}

export function decodeAuthenticatedTopologyCommand(
    enqueue: AppInboxEnqueueInput,
    authority: IssuedAuthSession
): TopologyAppInboxCommand {
    return decodeTopologyCommandForValidatedSession(enqueue, {
        principalId: authority.clientId,
        sessionId: authority.sessionId
    });
}

export function decodeTopologyCommandForValidatedSession(
    enqueue: AppInboxEnqueueInput,
    expectedActor: Readonly<{ principalId: string; sessionId: string; }>
): TopologyAppInboxCommand {
    const command = decodeDurableTopologyAppInboxCommand(enqueue.data);
    if (
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
    if (computeMutationCommandDigest(stableCommand) !== command.commandHash) {
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

export function decodeDurableTopologyAppInboxCommand(value: unknown): TopologyAppInboxCommand {
    const command = requireTopologyObject(
        decodeJsonWireValue(value, 'Topology durable AppInbox command'),
        'Topology durable AppInbox command'
    );
    requireExactKeys(command, [
        'actor',
        'groupRef',
        'requestId',
        'commandHash',
        'capturedAtEpochMs',
        'operation',
        'payload'
    ], 'Topology durable AppInbox command');
    const actor = decodeTopologyActor(command.actor);
    const groupRef = decodeTopologyGroupRef(command.groupRef);
    const requestId = decodeTopologyString(command.requestId, 'requestId');
    const commandHash = decodeTopologyString(command.commandHash, 'commandHash');
    const capturedAtEpochMs = decodeTopologyEpoch(
        command.capturedAtEpochMs,
        'capturedAtEpochMs'
    );
    const payload = decodeTopologyAppInboxPayload(command.payload);
    if (command.operation !== payload.operation) {
        throw new TypeError('Topology durable command operation does not match its payload');
    }
    return toTypedTopologyAppInboxCommand(
        { actor, groupRef, requestId, commandHash, capturedAtEpochMs },
        payload
    );
}

export function toTopologyConfigMutationCommand(
    command: TopologyAppInboxCommand
): GroupTopologyConfigMutationCommand {
    switch (command.payload.operation) {
        case 'putConfig':
            return createTopologyConfigMutationCommand({
                command,
                config: fromCanonicalGroupTopologyConfigPatch(command.payload.config),
                ttlMs: null,
                expiresAtEpochMs: null
            });
        case 'deleteConfig':
            return createTopologyConfigMutationCommand({
                command,
                config: null,
                ttlMs: null,
                expiresAtEpochMs: null
            });
        case 'putOverride':
            return createTopologyConfigMutationCommand({
                command,
                config: fromCanonicalGroupTopologyConfigPatch(command.payload.config),
                ttlMs: command.payload.ttlMs,
                expiresAtEpochMs: command.payload.expiresAtEpochMs
            });
        case 'deleteOverride':
            return createTopologyConfigMutationCommand({
                command,
                config: null,
                ttlMs: null,
                expiresAtEpochMs: null
            });
        case 'reconfigureTopology':
            throw new TypeError('Reconfigure is not a topology config mutation');
    }
}

function isTopologyRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toCanonicalTopologyAppInboxPayload(
    payload: TopologyAppInboxRequestPayload
): TopologyAppInboxPayload {
    const request = requireTopologyObject(
        decodeJsonWireValue(payload, 'Topology AppInbox request payload'),
        'Topology AppInbox request payload'
    );
    switch (request.operation) {
        case 'putConfig':
            requireExactKeys(request, ['operation', 'config']);
            return {
                operation: request.operation,
                config: toCanonicalGroupTopologyConfigPatch(request.config)
            };
        case 'deleteConfig':
            requireExactKeys(request, ['operation', 'target']);
            if (request.target !== 'config') {
                throw new TypeError('Topology delete config target is invalid');
            }
            return { operation: request.operation, target: request.target };
        case 'putOverride':
            requireExactKeys(request, ['operation', 'config', 'ttlMs', 'expiresAtEpochMs']);
            return {
                operation: request.operation,
                config: toCanonicalGroupTopologyConfigPatch(request.config),
                ttlMs: decodeFiniteNumberOrNull(request.ttlMs, 'Topology override ttlMs'),
                expiresAtEpochMs: decodeFiniteNumberOrNull(
                    request.expiresAtEpochMs,
                    'Topology override expiresAtEpochMs'
                )
            };
        case 'deleteOverride':
            requireExactKeys(request, ['operation', 'target']);
            if (request.target !== 'override') {
                throw new TypeError('Topology delete override target is invalid');
            }
            return { operation: request.operation, target: request.target };
        case 'reconfigureTopology':
            requireExactKeys(request, ['operation', 'requestOptions', 'publish']);
            if (typeof request.publish !== 'boolean') {
                throw new TypeError('Topology reconfigure publish is invalid');
            }
            return {
                operation: request.operation,
                requestOptions: toCanonicalGroupTopologyConfigPatch(request.requestOptions),
                publish: request.publish
            };
        default:
            throw new TypeError('Topology AppInbox request operation is invalid');
    }
}

function decodeTopologyAppInboxPayload(
    value: JsonWireValue | undefined
): TopologyAppInboxPayload {
    const payload = requireTopologyObject(value, 'Topology durable AppInbox payload');
    switch (payload.operation) {
        case 'putConfig':
            requireExactKeys(payload, ['operation', 'config']);
            return {
                operation: payload.operation,
                config: readCanonicalGroupTopologyConfigPatch(payload.config)
            };
        case 'deleteConfig':
            requireExactKeys(payload, ['operation', 'target']);
            if (payload.target !== 'config') {
                throw new TypeError('Topology durable delete config target is invalid');
            }
            return { operation: payload.operation, target: payload.target };
        case 'putOverride':
            requireExactKeys(payload, ['operation', 'config', 'ttlMs', 'expiresAtEpochMs']);
            return {
                operation: payload.operation,
                config: readCanonicalGroupTopologyConfigPatch(payload.config),
                ttlMs: decodeFiniteNumberOrNull(payload.ttlMs, 'Topology durable override ttlMs'),
                expiresAtEpochMs: decodeFiniteNumberOrNull(
                    payload.expiresAtEpochMs,
                    'Topology durable override expiresAtEpochMs'
                )
            };
        case 'deleteOverride':
            requireExactKeys(payload, ['operation', 'target']);
            if (payload.target !== 'override') {
                throw new TypeError('Topology durable delete override target is invalid');
            }
            return { operation: payload.operation, target: payload.target };
        case 'reconfigureTopology':
            requireExactKeys(payload, ['operation', 'requestOptions', 'publish']);
            if (typeof payload.publish !== 'boolean') {
                throw new TypeError('Topology durable reconfigure publish is invalid');
            }
            return {
                operation: payload.operation,
                requestOptions: readCanonicalGroupTopologyConfigPatch(payload.requestOptions),
                publish: payload.publish
            };
        default:
            throw new TypeError('Topology durable AppInbox payload operation is invalid');
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

function createTopologyConfigMutationCommand(
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
        commandHash: command.commandHash,
        capturedAtEpochMs: command.capturedAtEpochMs,
        input: {
            config,
            updatedByPrincipalId: command.actor.principalId,
            ttlMs,
            expiresAtEpochMs
        }
    };
}

function toTypedTopologyAppInboxCommand(
    identity: TopologyAppInboxCommandIdentity,
    payload: TopologyAppInboxPayload
): TopologyAppInboxCommand {
    switch (payload.operation) {
        case 'putConfig':
            return { ...identity, operation: payload.operation, payload };
        case 'deleteConfig':
            return { ...identity, operation: payload.operation, payload };
        case 'putOverride':
            return { ...identity, operation: payload.operation, payload };
        case 'deleteOverride':
            return { ...identity, operation: payload.operation, payload };
        case 'reconfigureTopology':
            return { ...identity, operation: payload.operation, payload };
    }
}

function decodeTopologyActor(
    value: JsonWireValue | undefined
): TopologyAppInboxCommand['actor'] {
    const actor = requireTopologyObject(value, 'Topology AppInbox actor');
    requireExactKeys(actor, ['principalId', 'sessionId'], 'Topology AppInbox actor');
    return {
        principalId: decodeTopologyString(actor.principalId, 'actor principalId'),
        sessionId: decodeTopologyString(actor.sessionId, 'actor sessionId')
    };
}

function decodeTopologyGroupRef(
    value: JsonWireValue | undefined
): TopologyAppInboxCommand['groupRef'] {
    const groupRef = requireTopologyObject(value, 'Topology AppInbox groupRef');
    requireExactKeys(
        groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Topology AppInbox groupRef'
    );
    return {
        applicationId: decodeTopologyString(groupRef.applicationId, 'group applicationId'),
        workspaceId: decodeTopologyString(groupRef.workspaceId, 'group workspaceId'),
        groupId: decodeTopologyString(groupRef.groupId, 'group groupId')
    };
}

function decodeTopologyString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Topology AppInbox ${label} is invalid`);
    }
    return value;
}

function decodeTopologyEpoch(value: JsonWireValue | undefined, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Topology AppInbox ${label} is invalid`);
    }
    return value;
}

function requireTopologyObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (value === undefined || !isTopologyRecord(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function requireExactKeys(
    record: JsonWireObject,
    expected: readonly string[],
    label = 'Topology durable command'
): void {
    if (JSON.stringify(Object.keys(record).toSorted()) !== JSON.stringify([...expected].toSorted())) {
        throw new TypeError(`${label} has missing or unexpected fields`);
    }
}

function decodeFiniteNumberOrNull(
    value: JsonWireValue | undefined,
    label: string
): number | null {
    if (value === null || typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    throw new TypeError(`${label} is invalid`);
}
