import { RELIC_TOPICS, RELIC_TYPES, type RelicCommand } from '@relic-hunters/mod.ts';
import type { ALDeliveryState, RallarFacade } from '@shared-web/browser/rallar.ts';

/** How long a command waits for the server's receipt: the `command` purpose's 30 s deadline (D52). */
export const RELIC_COMMAND_RECEIPT_WAIT_MS = 30_000;

export interface RelicWsCommandDelivery {
    readonly state: ALDeliveryState;
    /** Why the receipt ended unconfirmed; undefined once acknowledged or while it is still open. */
    readonly reason: string | undefined;
}

/**
 * A Relic command to the server itself on the `command` channel (D57 as applied): a unicast to the WS server's peer id,
 * receipted by the server's own ACK once it admits the command. Undefined when no server id is known yet, so the
 * runtime sends over REST instead (Q6, C13).
 */
export async function sendRelicWsCommand(
    facade: Pick<RallarFacade, 'serverPeerId' | 'messages'>,
    roomId: string,
    command: RelicCommand
): Promise<RelicWsCommandDelivery | undefined> {
    const serverPeerId = facade.serverPeerId();
    if (serverPeerId === undefined) {
        return undefined;
    }
    const handle = await facade.messages
        .room<RelicCommand>({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId,
            durability: 'local-outbox',
            onStorageUnavailable: 'refuse'
        })
        .sendWs(command, { peerId: serverPeerId });
    const outcome = await handle.wait({ timeoutMs: RELIC_COMMAND_RECEIPT_WAIT_MS });
    return { state: outcome.lifecycle.state, reason: outcome.lifecycle.evidence.reason };
}
