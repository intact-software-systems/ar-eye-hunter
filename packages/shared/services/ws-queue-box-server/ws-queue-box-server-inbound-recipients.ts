import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';

export namespace WsQueueBoxServerInboundRecipients {
    export interface Input {
        readonly message: ALMessage;
        readonly source: ALInboundMessageRuntime.Source;
        readonly resolvedPeerIds: readonly string[];
        readonly serverPeerId: string;
    }
}

export interface WsQueueBoxServerInboundRecipients {
    readonly recipientPeerIds: readonly string[];
    readonly groupMemberPeerIds: readonly string[];
}

export function resolveWsQueueBoxServerInboundRecipients(
    input: WsQueueBoxServerInboundRecipients.Input
): WsQueueBoxServerInboundRecipients {
    const admittedPeerIds = input.source.kind === 'ws-client' ? input.source.groupRecipientPeerIds : undefined;
    if (admittedPeerIds === undefined) {
        return { recipientPeerIds: input.resolvedPeerIds, groupMemberPeerIds: input.resolvedPeerIds };
    }
    const recipientPeerIds = input.resolvedPeerIds.filter((peerId) => admittedPeerIds.includes(peerId));
    // The router authorized this room message and owns its fanout, so the server receives an admitted multicast.
    return {
        recipientPeerIds,
        groupMemberPeerIds: input.message.targets?.mode === 'multicast'
            ? [...recipientPeerIds, input.serverPeerId]
            : recipientPeerIds
    };
}
