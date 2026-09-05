import type { GroupRef, RoomFormationCommand } from '../room-group-state-translation.ts';
import {
    commandRoomFormation,
    connectRoomFormation,
    type RoomFormationCommandPorts
} from './command-room-formation.ts';
import type { RallarRoomFormation, RallarRoomFormationCommandOptions } from './rallar-room-formation-contracts.ts';
import { readRoomFormationStatus } from './room-formation-observation.ts';

export interface CreateRoomFormationInput extends RoomFormationCommandPorts {
    readonly roomRef: GroupRef;
}

export function createRoomFormation(input: CreateRoomFormationInput): RallarRoomFormation {
    const submit = async (
        command: RoomFormationCommand,
        options: RallarRoomFormationCommandOptions = {}
    ) => await commandRoomFormation({ roomRef: input.roomRef, command, options, ports: input });

    return {
        roomRef: input.roomRef,
        status: () => readRoomFormationStatus(input),
        plan: async (options) => await submit({ command: 'plan' }, options),
        connect: async (options = {}) => await connectRoomFormation({ roomRef: input.roomRef, options, ports: input }),
        activate: async (options) => await submit({ command: 'activate' }, options),
        reconfigure: async (options = {}) =>
            await submit({ command: 'reconfigure', landing: options.landing }, options),
        pause: async (options) => await submit({ command: 'pause' }, options),
        resume: async (options) => await submit({ command: 'resume' }, options),
        reset: async (options) => await submit({ command: 'reset' }, options),
        start: async (options) => await submit({ command: 'start' }, options)
    };
}
