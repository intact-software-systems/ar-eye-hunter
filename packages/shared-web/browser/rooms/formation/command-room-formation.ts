import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { ApiMiddleware, RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { toRallarCommandOptions, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { throwRallarValidationIssue } from '@shared-web/browser/rooms/rallar-room-validation.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-read/state-workflow-support.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { isGroupConnectRejectionCode } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { Command } from '@shared/cache/Command.ts';

import {
    toRoomFormationGroupStateRequest,
    type GroupRef,
    type GroupSnapshot,
    type RoomFormationCommand
} from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type { RallarRoomConnectOptions, RallarRoomFormationCommandOptions } from './rallar-room-formation-contracts.ts';
import { roomFormationHttpApi } from './room-formation-http-api.ts';
import { toRallarRoomLayout } from './room-formation-observation.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface RoomFormationCommandPorts {
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
    readonly refreshRoom: (roomRef: GroupRef, options?: RallarScopedOperationOptions) => Promise<void>;
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
    try {
        return await commandRoomFormation({
            roomRef: input.roomRef,
            command: { command: 'connect', ...fence },
            options: input.options,
            ports: input.ports
        });
    }
    catch (error) {
        // A refused fence names a layout the server no longer dials; the next
        // connect must read the current one through rather than post it again.
        if (isConnectFenceRejection(error)) {
            input.ports.slots.forgetPlanned(input.roomRef, fence.expectedLayout);
        }
        throw error;
    }
}

function isConnectFenceRejection(error: unknown): boolean {
    const code = error instanceof ApiHttpError ? error.mutationFailure?.code : undefined;
    return code !== undefined && (isGroupConnectRejectionCode(code) || code === 'group-mutation-rejected');
}

async function readConnectFence(input: ConnectRoomFormationInput): Promise<ConnectFence> {
    const cached = resolveConnectFence(input, 'coherent');
    if (cached) {
        return cached;
    }
    await input.ports.refreshRoom(input.roomRef, input.options);
    const refreshed = resolveConnectFence(input, 'as-cached');
    if (refreshed) {
        return refreshed;
    }
    throwRallarValidationIssue(
        '$.layout',
        'no-planned-layout',
        'Cannot connect room formation: no planned layout is published for this room.'
    );
}

/**
 * The epoch and the planned identity come from two caches that fill
 * independently. A planned layout published past the cached snapshot's
 * revision would pair a fresh identity with a stale epoch, which the server
 * rejects without naming the layout; the first resolution refuses that pair
 * so the read-through can catch the snapshot up, and the second accepts what
 * the read-through returned.
 */
function resolveConnectFence(
    input: ConnectRoomFormationInput,
    pairing: 'coherent' | 'as-cached'
): ConnectFence | undefined {
    const snapshot = input.ports.stateStore.findGroupSnapshot(input.roomRef);
    if (!snapshot) {
        return undefined;
    }
    if (input.options.layout) {
        return { expectedFormationEpoch: snapshot.group.formationEpoch, expectedLayout: input.options.layout };
    }
    const planned = toRallarRoomLayout('planned', input.ports.slots.readPlanned(input.roomRef), input.roomRef);
    if (!planned) {
        return undefined;
    }
    const snapshotLagsLayout =
        compareGroupCausalRevision(planned.overlay.sourceGroupStateCausalRevision, snapshot.causalRevision) ===
            'dominates';
    if (pairing === 'coherent' && snapshotLagsLayout) {
        return undefined;
    }
    return { expectedFormationEpoch: snapshot.group.formationEpoch, expectedLayout: planned.identity };
}
