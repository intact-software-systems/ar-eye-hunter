import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { OverlayRepositoryChange } from '@shared/repository/overlays-repository.ts';

import type { GroupRef, RoomFormationCommand } from '../room-group-state-translation.ts';
import {
    commandRoomFormation,
    connectRoomFormation,
    type RoomFormationServiceDependencies
} from './command-room-formation.ts';
import type {
    RallarRoomFormation,
    RallarRoomFormationCommandOptions,
    RallarRoomFormationStatus,
    RallarRoomLayoutEvent,
    RallarRoomLayoutListener,
    RallarRoomLayoutRole
} from './rallar-room-formation-contracts.ts';
import { readRoomFormationView } from './read-room-formation-view.ts';
import {
    readRoomFormationStatus,
    subscribeRoomFormation,
    toRallarRoomLayout,
    type ReadRoomFormationStatusInput
} from './room-formation-observation.ts';
import { waitForRoomCondition, waitForRoomLayout, waitForRoomStage } from './wait-for-room-formation.ts';

export interface CreateRoomFormationInput {
    readonly roomRef: GroupRef;
    readonly dependencies: RoomFormationServiceDependencies;
}

export function createRoomFormation(input: CreateRoomFormationInput): RallarRoomFormation {
    const { roomRef, dependencies } = input;
    const observation: ReadRoomFormationStatusInput = {
        roomRef,
        stateStore: dependencies.stateStore,
        slots: dependencies.slots
    };
    const waits = { ...observation, resolveOperationOptions: dependencies.resolveOperationOptions };
    const submit = async (
        command: RoomFormationCommand,
        options: RallarRoomFormationCommandOptions = {}
    ) => await commandRoomFormation({ roomRef, command, options, dependencies });

    return {
        roomRef,
        status: () => readRoomFormationStatus(observation),
        readView: async (options = {}) => await readRoomFormationView({ roomRef, options, dependencies }),
        plan: async (options) => await submit({ command: 'plan' }, options),
        connect: async (options = {}) => await connectRoomFormation({ roomRef, options, dependencies }),
        activate: async (options) => await submit({ command: 'activate' }, options),
        reconfigure: async (options = {}) =>
            await submit({ command: 'reconfigure', landing: options.landing }, options),
        pause: async (options) => await submit({ command: 'pause' }, options),
        resume: async (options) => await submit({ command: 'resume' }, options),
        reset: async (options) => await submit({ command: 'reset' }, options),
        start: async (options) => await submit({ command: 'start' }, options),
        waitForStage: async (stage, options = {}) =>
            await waitForRoomStage({ ...waits, stages: toList(stage), options }),
        waitForCondition: async (condition, options = {}) =>
            await waitForRoomCondition({ ...waits, conditions: toList(condition), options }),
        waitForLayout: async (options = {}) => await waitForRoomLayout({ ...waits, options }),
        onChange: (listener, options = {}) => subscribeToFormationChanges(observation, listener, options),
        onLayout: (listener) => subscribeToLayoutEvents(observation, listener)
    };
}

function toList<T>(value: T | readonly T[]): readonly T[] {
    return Array.isArray(value) ? value : [value as T];
}

function subscribeToFormationChanges(
    input: ReadRoomFormationStatusInput,
    listener: RallarStateListener<RallarRoomFormationStatus>,
    options: RallarOnChangeOptions
): RallarUnsubscribe {
    let last = readRoomFormationStatus(input);
    if ((options.emitCurrent ?? true) && last !== undefined) {
        notifyListener(listener, last);
    }
    return subscribeRoomFormation(input, () => {
        const next = readRoomFormationStatus(input);
        if (next === undefined || isSameFormationObservation(last, next)) {
            return;
        }
        last = next;
        notifyListener(listener, next);
    });
}

/** The caches replace objects on every change, so identity is the observable-change test. */
function isSameFormationObservation(
    left: RallarRoomFormationStatus | undefined,
    right: RallarRoomFormationStatus
): boolean {
    return left !== undefined &&
        left.snapshot === right.snapshot &&
        left.planned?.overlay === right.planned?.overlay &&
        left.accepted?.overlay === right.accepted?.overlay;
}

function subscribeToLayoutEvents(
    input: ReadRoomFormationStatusInput,
    listener: RallarRoomLayoutListener
): RallarUnsubscribe {
    const overlayId = toScopedOverlayId(input.roomRef);
    const forward = (role: RallarRoomLayoutRole) => (change: OverlayRepositoryChange) => {
        if (change.overlayId !== overlayId) {
            return;
        }
        notifyListener(listener, toRoomLayoutEvent(role, change, input.roomRef));
    };
    const unsubscribes = [
        input.slots.onPlannedChange(forward('planned')),
        input.slots.onAcceptedChange(forward('accepted'))
    ];
    return () => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    };
}

function toRoomLayoutEvent(
    role: RallarRoomLayoutRole,
    change: OverlayRepositoryChange,
    roomRef: GroupRef
): RallarRoomLayoutEvent {
    const layout = toRallarRoomLayout(role, change.overlay, roomRef);
    if (layout === undefined) {
        return { kind: 'layoutRemoved', roomRef, role, previous: toRallarRoomLayout(role, change.previous, roomRef) };
    }
    return role === 'planned'
        ? { kind: 'layoutPlanned', roomRef, layout }
        : { kind: 'layoutAccepted', roomRef, layout };
}
