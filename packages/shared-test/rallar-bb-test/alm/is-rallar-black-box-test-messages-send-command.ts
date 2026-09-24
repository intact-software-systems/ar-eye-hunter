import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../rallar-black-box-test-contracts.ts';

/** An ordinary `messages.send`: one that names its own carrier, type and payload rather than a replay. */
export function isRallarBlackBoxTestMessagesSendCommand(
    command: RallarBlackBoxTestCommand
): command is RallarBlackBoxTestMessagesSendCommand {
    return command.kind === 'messages.send' && !('replayOnCarrier' in command);
}
