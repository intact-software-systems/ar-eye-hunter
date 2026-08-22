import type { StateScope } from '@shared/api/state-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import {
    toAuthenticatedClientMutationContextId
} from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import {
    AppInboxType,
    type AppInboxType as AppInboxTypeValue
} from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

export interface StateWriteAppInboxCommand {
    readonly commandId: string;
    readonly kind:
        | 'profile-instance'
        | 'membership'
        | 'presence-connect'
        | 'presence-heartbeat'
        | 'presence-disconnect'
        | 'config'
        | 'topology-source';
}

export interface StateWriteAppInboxExpectation {
    readonly commandId: string;
    readonly operationId: string;
    readonly topicId: AppInboxTypeValue;
    readonly logicalResourceId: string;
    readonly logicalContextId: string;
    readonly physicalKey: Key;
}

export interface StateWriteAppInboxIdentity {
    readonly commandId: string;
    readonly operationId: string;
    readonly commandType: AppInboxTypeValue;
}

export interface PersistedStateWriteAppInboxIdentityRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_resource: string;
}

export function toStateWriteAppInboxExpectations(
    commands: readonly StateWriteAppInboxCommand[],
    scope: StateScope,
    groupCount: number
): readonly StateWriteAppInboxExpectation[] {
    return commands.flatMap((command) => {
        const clientIndex = readStateWriteBenchmarkClientIndex(command.commandId);
        const groupId = `group-${clientIndex % groupCount}`;
        if (command.kind === 'profile-instance') {
            const principalId = `client-${clientIndex}`;
            const callerSessionId = toStateWriteBenchmarkSessionId(
                scope,
                principalId,
                `client-session-${clientIndex}`
            );
            const logicalContextId = toAuthenticatedClientMutationContextId({
                scope,
                principalId,
                callerClientId: principalId,
                callerSessionId
            });
            return [
                toExpectation({
                    commandId: command.commandId,
                    operationId: 'profile',
                    topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                    logicalResourceId: `${command.commandId}-profile`,
                    logicalContextId
                }),
                toExpectation({
                    commandId: command.commandId,
                    operationId: 'instance',
                    topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                    logicalResourceId: `${command.commandId}-instance`,
                    logicalContextId
                })
            ];
        }
        const topicId = toSingleOperationTopic(command.kind);
        return [toExpectation({
            commandId: command.commandId,
            operationId: 'command',
            topicId,
            logicalResourceId: command.commandId,
            logicalContextId: toStateWriteBenchmarkGroupContextId(scope, groupId)
        })];
    });
}

export function readStateWriteAppInboxIdentity(
    row: PersistedStateWriteAppInboxIdentityRow,
    expectation: StateWriteAppInboxExpectation
): StateWriteAppInboxIdentity | undefined {
    if (
        row.ri_resource_id !== expectation.physicalKey.resourceId ||
        row.ri_topic_id !== expectation.physicalKey.topicId ||
        row.fk_ext_bank_id !== expectation.physicalKey.contextId
    ) {
        return undefined;
    }
    const envelope = readJsonWireObject(row.ri_resource);
    const route = readRecord(envelope?.route);
    const payload = readRecord(envelope?.payload);
    const enqueue = typeof payload?.resource === 'string'
        ? readJsonWireObject(payload.resource)
        : undefined;
    if (
        payload?.typeId !== expectation.topicId ||
        enqueue?.type !== expectation.topicId ||
        enqueue?.topicId !== expectation.topicId ||
        enqueue?.resourceId !== expectation.logicalResourceId ||
        enqueue?.contextId !== expectation.logicalContextId ||
        (route !== undefined &&
            (
                route.resourceId !== expectation.physicalKey.resourceId ||
                route.topicId !== expectation.physicalKey.topicId ||
                route.contextId !== expectation.physicalKey.contextId
            ))
    ) {
        return undefined;
    }
    return {
        commandId: expectation.commandId,
        operationId: expectation.operationId,
        commandType: expectation.topicId
    };
}

export function toStateWriteBenchmarkGroupContextId(
    scope: StateScope,
    groupId: string
): string {
    return [scope.applicationId, scope.workspaceId, groupId].map(encodeURIComponent).join(':');
}

export function toStateWriteBenchmarkSessionId(
    scope: StateScope,
    principalId: string,
    sessionLabel: string
): string {
    return [
        scope.applicationId,
        scope.workspaceId,
        principalId,
        sessionLabel
    ].map(encodeURIComponent).join(':');
}

export function readStateWriteBenchmarkClientIndex(commandId: string): number {
    const clientIndex = Number(commandId.slice(commandId.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) {
        throw new Error(`Benchmark command ID has no client index: ${commandId}`);
    }
    return clientIndex;
}

function toSingleOperationTopic(
    kind: Exclude<StateWriteAppInboxCommand['kind'], 'profile-instance'>
): AppInboxTypeValue {
    switch (kind) {
        case 'membership':
            return AppInboxType.GROUP_MEMBER_UPSERT;
        case 'presence-connect':
            return AppInboxType.GROUP_PRESENCE_CONNECT;
        case 'presence-heartbeat':
            return AppInboxType.GROUP_PRESENCE_HEARTBEAT;
        case 'presence-disconnect':
            return AppInboxType.GROUP_PRESENCE_DISCONNECT;
        case 'config':
            return AppInboxType.GROUP_UPDATE;
        case 'topology-source':
            return AppInboxType.TOPOLOGY_CONFIG_PUT;
    }
}

function toExpectation(
    identity: Omit<StateWriteAppInboxExpectation, 'physicalKey'>
): StateWriteAppInboxExpectation {
    return {
        ...identity,
        physicalKey: toAppQueueKey({
            topicId: identity.topicId,
            resourceId: identity.logicalResourceId,
            contextId: identity.logicalContextId
        })
    };
}

function readJsonWireObject(value: string): JsonWireObject | undefined {
    try {
        return readRecord(decodeJsonWireValue(JSON.parse(value), 'Benchmark AppInbox resource'));
    }
    catch {
        return undefined;
    }
}

function readRecord(value: JsonWireValue | undefined): JsonWireObject | undefined {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonWireObject
        : undefined;
}
