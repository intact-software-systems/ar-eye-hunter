import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { throwRallarValidationIssue } from '@shared-web/browser/rooms/rallar-room-validation.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { Command } from '@shared/cache/Command.ts';

import {
    toRallarRoomLayout,
    toRoomFormationGroupStateRequest,
    type GroupRef,
    type GroupSnapshot,
    type RoomFormationCommand
} from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type { RallarRoomConnectOptions, RallarRoomFormationCommandOptions } from './rallar-room-formation-contracts.ts';
import { roomFormationHttpApi } from './room-formation-http-api.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface RoomFormationCommandPorts {
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
    readonly refreshRoom: (roomRef: GroupRef) => Promise<void>;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(options: T) => T & RallarOperationOptions;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (input: RallarStateSnapshotAcceptanceInput) => Promise<void>;
}

export interface CommandRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly command: RoomFormationCommand;
    readonly options: RallarRoomFormationCommandOptions;
    readonly ports: RoomFormationCommandPorts;
}

export interface ConnectRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly options: RallarRoomConnectOptions;
    readonly ports: RoomFormationCommandPorts;
}

interface ConnectFence {
    readonly expectedFormationEpoch: number;
    readonly expectedLayout: GroupLayoutIdentity;
}

export async function commandRoomFormation(input: CommandRoomFormationInput): Promise<GroupSnapshot> {
    const { ports } = input;
    return await ports.runAuthAwareOperation(async () => {
        const operationOptions = ports.resolveOperationOptions(input.options);
        const context = await ports.connect(operationOptions);
        const session = ports.requireSession();
        const scope = input.options.scope ?? toStateScope(input.roomRef);
        const request = toRoomFormationGroupStateRequest({
            command: input.command,
            reason: input.options.reason,
            actorPrincipalId: session.clientId,
            actorSessionId: session.sessionId
        });
        const requestId = toApiMutationWorkflowRequestId();

        const snapshot = await new Command<GroupSnapshot>(
            (signal) =>
                roomFormationHttpApi.command({
                    groupId: input.roomRef.groupId,
                    command: input.command.command,
                    request,
                    options: { requestId, signal },
                    scope
                }),
            toRallarCommandOptions(operationOptions)
        ).run();
        await ports.acceptSnapshots({ context, clients: [], groups: [snapshot], scope });
        return snapshot;
    });
}

export async function connectRoomFormation(input: ConnectRoomFormationInput): Promise<GroupSnapshot> {
    const fence = await readConnectFence(input);
    return await commandRoomFormation({
        roomRef: input.roomRef,
        command: { command: 'connect', ...fence },
        options: input.options,
        ports: input.ports
    });
}

async function readConnectFence(input: ConnectRoomFormationInput): Promise<ConnectFence> {
    const cached = resolveConnectFence(input);
    if (cached) {
        return cached;
    }
    await input.ports.refreshRoom(input.roomRef);
    const refreshed = resolveConnectFence(input);
    if (refreshed) {
        return refreshed;
    }
    throwRallarValidationIssue(
        '$.layout',
        'no-planned-layout',
        'Cannot connect room formation: no planned layout is published for this room.'
    );
}

function resolveConnectFence(input: ConnectRoomFormationInput): ConnectFence | undefined {
    const snapshot = input.ports.stateStore.findGroupSnapshot(input.roomRef);
    const expectedLayout = input.options.layout ??
        toRallarRoomLayout('planned', input.ports.slots.readPlanned(input.roomRef), input.roomRef)?.identity;
    if (!snapshot || !expectedLayout) {
        return undefined;
    }
    return { expectedFormationEpoch: snapshot.group.formationEpoch, expectedLayout };
}
