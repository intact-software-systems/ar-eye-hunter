import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { WsServerInboundAuthorization } from './ws-queue-box-server-contracts.ts';

export interface ToWsQueueBoxServerAddresseeAuthorizationInput {
    readonly message: ALMessage;
    readonly serverPeerId: string;
    /** The wrapped authorizer's own NACK policy (`WsServerInboundAuthorizer.sendNacks`), so both refusals agree. */
    readonly sendNack: boolean;
    readonly authorization: WsServerInboundAuthorization;
}

/**
 * A room unicast to a session outside the audience its room admitted is refused before admission, with a NACK the
 * origin states (Q5, C3): admitted, its receipt would expect nobody and complete at once. A unicast to the server,
 * and a message the authorizer resolved no room audience for, keep their authorization.
 */
export function toWsQueueBoxServerAddresseeAuthorization(
    input: ToWsQueueBoxServerAddresseeAuthorizationInput
): WsServerInboundAuthorization {
    const { message, authorization } = input;
    const targets = message.targets;
    if (
        !authorization.authorized || authorization.roomAudience === undefined ||
        targets?.mode !== 'unicast'
    ) {
        return authorization;
    }
    const addressable = targets.toPeerId === input.serverPeerId ||
        (targets.toPeerId !== message.id.senderId &&
            authorization.roomAudience.recipientPeerIds.includes(targets.toPeerId));
    return addressable ? authorization : {
        authorized: false,
        reason: 'unauthorized',
        rejectionCode: 'unauthorized',
        logMessage:
            `AL unicast ${message.id.msgId} addresses ${targets.toPeerId}, who is not in the audience its room admitted`,
        sendNack: input.sendNack
    };
}
