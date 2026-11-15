import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toNestedCommands } from './to-nested-commands.ts';

export function toWaitCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestWaitCommand[] {
    return toNestedCommands(commands).filter((command): command is RallarBlackBoxTestWaitCommand => command.kind === 'wait');
}
