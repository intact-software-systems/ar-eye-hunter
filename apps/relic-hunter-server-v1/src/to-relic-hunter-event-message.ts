import {
    RELIC_TOPICS,
    RELIC_TYPES,
    toRelicRoomGroupRef,
    type RelicCommand,
    type RelicGameState,
    type RelicHunterEvent
} from '@relic-hunters/mod.ts';
import {
    newALPrincipalBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { RELIC_SNAPSHOT_TTL_MS } from './to-relic-snapshot-message.ts';

/** The action a submitted plan recorded for the round it was submitted in; undefined for every other command. */
export function toRelicActionRecordedEvent(
    previous: RelicGameState,
    command: RelicCommand,
    principalId: string
): RelicHunterEvent | undefined {
    if (command.kind !== 'submit-action') {
        return undefined;
    }
    return {
        protocolVersion: previous.protocolVersion,
        gameId: previous.gameId,
        principalId,
        kind: 'action-recorded',
        round: previous.round,
        action: command.action
    };
}

/** The text of the rule that refused the command, which the server's acknowledgement of a WS command never carried. */
export function toRelicCommandRefusedEvent(
    command: RelicCommand,
    principalId: string,
    error: Error
): RelicHunterEvent {
    return {
        protocolVersion: command.protocolVersion,
        gameId: command.gameId,
        principalId,
        kind: 'command-refused',
        command: command.kind,
        text: error.message
    };
}

/**
 * A hunter event reaches the acting hunter's own live sessions in the game's room and no one else's (D168); it stays
 * deliverable as long as a snapshot does.
 */
export function toRelicHunterEventMessage(roomId: string, event: RelicHunterEvent, serverPeerId: string): ALMessage {
    const groupRef = toRelicRoomGroupRef(roomId);
    return newALPrincipalBroadcastMessage(
        serverPeerId,
        newALRoute(RELIC_TOPICS.hunter, roomId, `${event.gameId}:${event.principalId}`),
        {
            groupRef,
            principalRef: {
                applicationId: groupRef.applicationId,
                workspaceId: groupRef.workspaceId,
                principalId: event.principalId
            }
        },
        RELIC_TYPES.hunter,
        event,
        { reliability: 'at-least-once', ack: 'receiver', ttlMs: RELIC_SNAPSHOT_TTL_MS }
    );
}
