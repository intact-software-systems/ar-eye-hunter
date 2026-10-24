import {
    type RelicCommand,
    type RelicGameState,
    type RelicHunterEvent
} from '@relic-hunters/mod.ts';
import type { RelicCommandSender } from './relic-command-sender.ts';

/** The action a submitted plan recorded for the round it was submitted in; undefined for every other command. */
export function toRelicActionRecordedEvent(
    previous: RelicGameState,
    command: RelicCommand,
    sender: RelicCommandSender
): RelicHunterEvent | undefined {
    if (command.kind !== 'submit-action') {
        return undefined;
    }
    return {
        protocolVersion: previous.protocolVersion,
        gameId: previous.gameId,
        principalId: sender.clientId,
        playerId: sender.sessionId,
        kind: 'action-recorded',
        round: previous.round,
        action: command.action
    };
}

/** The text of the rule that refused the command, which the server's acknowledgement of a WS command never carried. */
export function toRelicCommandRefusedEvent(
    command: RelicCommand,
    sender: RelicCommandSender,
    error: Error
): RelicHunterEvent {
    return {
        protocolVersion: command.protocolVersion,
        gameId: command.gameId,
        principalId: sender.clientId,
        playerId: sender.sessionId,
        kind: 'command-refused',
        command: command.kind,
        text: error.message
    };
}
