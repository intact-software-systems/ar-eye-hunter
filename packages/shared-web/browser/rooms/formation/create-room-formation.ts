import type { GroupRef, RoomFormationCommand } from '../room-group-state-translation.ts';
import {
    commandRoomFormation,
    connectRoomFormation,
    type RoomFormationServiceDependencies
} from './command-room-formation.ts';
import type { RallarRoomFormation, RallarRoomFormationCommandOptions } from './rallar-room-formation-contracts.ts';
import { readRoomFormationView } from './read-room-formation-view.ts';
import {
    readRoomFormationStatus,
    subscribeRoomFormationChanges,
    subscribeRoomLayoutEvents,
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
        onChange: (listener, options = {}) => subscribeRoomFormationChanges(observation, listener, options),
        onLayout: (listener) => subscribeRoomLayoutEvents(observation, listener)
    };
}

function toList<T>(value: T | readonly T[]): readonly T[] {
    return Array.isArray(value) ? value : [value as T];
}
