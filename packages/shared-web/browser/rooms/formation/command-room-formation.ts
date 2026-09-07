import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { GroupTopologyReadThroughOutcome } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import { toApiMutationWorkflowRequestId } from '@shared-web/browser/state-read/state-workflow-support.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { throwRallarValidation, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { Command } from '@shared/cache/Command.ts';

import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';
import {
    toRoomFormationGroupStateRequest,
    type GroupRef,
    type GroupSnapshot,
    type RoomFormationCommand
} from '../room-group-state-translation.ts';
import { runRoomTargetMutation, type RunRoomTargetMutationInput } from '../update-room.ts';
import type { RallarRoomConnectOptions, RallarRoomFormationCommandOptions } from './rallar-room-formation-contracts.ts';
import { toRallarRoomLayout } from './room-formation-observation.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface RoomFormationServiceDependencies
    extends Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'> {
    readonly slots: RallarRoomLayoutSlotsPort;
    /**
     * One room refresh: the point read, then the topology read-through whose
     * outcome it reports. `undefined` means the refreshed room does not count
     * this session as present, so no read-through ran for it.
     */
    readonly refreshRoom: (
        roomRef: GroupRef,
        options?: RallarScopedOperationOptions
    ) => Promise<GroupTopologyReadThroughOutcome | undefined>;
}

export interface CommandRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly command: RoomFormationCommand;
    readonly options: RallarRoomFormationCommandOptions;
    readonly dependencies: RoomFormationServiceDependencies;
}

export interface ConnectRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly options: RallarRoomConnectOptions;
    readonly dependencies: RoomFormationServiceDependencies;
}

interface ConnectFence {
    readonly expectedFormationEpoch: number;
    readonly expectedLayout: GroupLayoutIdentity;
}

export async function commandRoomFormation(input: CommandRoomFormationInput): Promise<GroupSnapshot> {
    const request = toRoomFormationGroupStateRequest({ command: input.command, reason: input.options.reason });
    const requestId = toApiMutationWorkflowRequestId();
    return await runRoomTargetMutation({
        ...input.dependencies,
        room: input.roomRef,
        options: input.options,
        execute: async ({ roomId, scope, policies }) =>
            await new Command<GroupSnapshot>(
                (signal) =>
                    roomGroupStateHttpApi.commandLifecycle({
                        groupId: roomId,
                        request,
                        options: { requestId, signal },
                        scope
                    }),
                policies.command ?? {}
            ).run()
    });
}

export async function connectRoomFormation(input: ConnectRoomFormationInput): Promise<GroupSnapshot> {
    const fence = await readConnectFence(input);
    try {
        return await commandRoomFormation({
            roomRef: input.roomRef,
            command: { command: 'connect', ...fence },
            options: input.options,
            dependencies: input.dependencies
        });
    }
    catch (error) {
        // A refused epoch means the cached snapshot is behind the group while the
        // plan may well be current, so the room is read through before the caller
        // retries; a refused layout is one the server no longer dials, so it is
        // forgotten and the next connect reads the current one through.
        const refused = error instanceof ApiHttpError ? error.mutationFailure?.code : undefined;
        if (refused === 'group-connect-stale-epoch') {
            await input.dependencies.refreshRoom(input.roomRef, input.options);
        }
        else if (
            refused === 'group-connect-no-planned-layout' || refused === 'group-connect-planned-layout-superseded'
        ) {
            input.dependencies.slots.forgetPlanned(input.roomRef, fence.expectedLayout);
        }
        throw error;
    }
}

async function readConnectFence(input: ConnectRoomFormationInput): Promise<ConnectFence> {
    const cached = resolveConnectFence(input, 'coherent');
    if (cached) {
        return cached;
    }
    const readThrough = await input.dependencies.refreshRoom(input.roomRef, input.options);
    const refreshed = resolveConnectFence(input, 'as-cached');
    if (refreshed) {
        return refreshed;
    }
    throwRallarValidation([toMissingPlannedLayoutIssue(readThrough)]);
}

/**
 * The read-through fills the planned slot only for a session the room counts
 * as present, and it logs a failed topology read instead of throwing. Neither
 * says nothing is published, so each keeps its own code; `no-planned-layout`
 * is the answer of a read-through that completed.
 */
function toMissingPlannedLayoutIssue(readThrough: GroupTopologyReadThroughOutcome | undefined): RallarValidationIssue {
    switch (readThrough) {
        case undefined:
            return {
                path: '$.layout',
                code: 'session-not-present',
                message: 'Cannot connect room formation: this session is not present in the room, so no planned ' +
                    'layout can be read for it; pass `layout` to name one.'
            };
        case 'read-failed':
        case 'revision-conflict':
            return {
                path: '$.layout',
                code: 'planned-layout-read-failed',
                message: 'Cannot connect room formation: the planned layout could not be read through; retry, or ' +
                    'pass `layout` to name one.'
            };
        case 'adopted':
        case 'no-overlay':
            return {
                path: '$.layout',
                code: 'no-planned-layout',
                message: 'Cannot connect room formation: no planned layout is published for this room.'
            };
    }
}

/**
 * The epoch and the planned identity come from two caches that fill
 * independently. A planned layout published past the cached snapshot's
 * revision means the snapshot is behind, and an epoch read from it is refused
 * as `group-connect-stale-epoch` before the server looks at the layout,
 * whether the caller names one or not; the first resolution refuses that
 * pairing so the read-through can catch the snapshot up, and the second
 * accepts what the read-through returned.
 */
function resolveConnectFence(
    input: ConnectRoomFormationInput,
    pairing: 'coherent' | 'as-cached'
): ConnectFence | undefined {
    const snapshot = input.dependencies.stateStore.findGroupSnapshot(input.roomRef);
    if (!snapshot) {
        return undefined;
    }
    const planned = toRallarRoomLayout('planned', input.dependencies.slots.readPlanned(input.roomRef), input.roomRef);
    const snapshotLagsLayout = planned !== undefined &&
        compareGroupCausalRevision(planned.overlay.sourceGroupStateCausalRevision, snapshot.causalRevision) ===
            'dominates';
    if (pairing === 'coherent' && snapshotLagsLayout) {
        return undefined;
    }
    const expectedLayout = input.options.layout ?? planned?.identity;
    if (!expectedLayout) {
        return undefined;
    }
    return { expectedFormationEpoch: snapshot.group.formationEpoch, expectedLayout };
}
