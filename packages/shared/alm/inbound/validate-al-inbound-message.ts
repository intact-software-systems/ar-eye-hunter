import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    toALControlRecipientPeerId,
    type ALParsedControlMessage
} from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

/** Who an inbound runtime receives for: itself, and the origins whose receiver ACKs it aggregates. */
export interface ALInboundReceiver {
    readonly selfPeerId: string;
    /**
     * An origin this runtime relays for: a receiver's ACK addressed to it is admitted here as its
     * aggregating relay hop. The WS server answers for the origins whose broadcasts it aggregates.
     */
    readonly relaysForPeerId: (peerId: string) => boolean;
}

export function toALInboundReceiver(
    selfPeerId: string,
    relaysForPeerId: ((peerId: string) => boolean) | undefined
): ALInboundReceiver {
    return { selfPeerId, relaysForPeerId: relaysForPeerId ?? (() => false) };
}

export function validateALInboundMessage(
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    receiver: ALInboundReceiver
): Either<ALMessageRejection, ALMessage> {
    if (
        source.kind !== 'trusted-server' &&
        (source.kind === 'ws-client' || msg.targets?.mode === 'unicast') &&
        msg.id.senderId !== source.peerId
    ) {
        return Either.ofLeft({ code: 'unauthorized', message: 'AL origin does not match the authenticated peer' });
    }
    if (source.kind === 'rtc-peer' && msg.targets?.mode === 'unicast' && msg.targets.toPeerId !== receiver.selfPeerId) {
        return Either.ofLeft({
            code: 'unauthorized',
            message: 'Direct RTC envelope is addressed to another recipient'
        });
    }
    if (msg.targets?.mode === 'multicast' && msg.targets.membershipEpoch !== undefined) {
        return Either.ofLeft({ code: 'unsupported', message: 'Authoritative membership fencing is not implemented' });
    }
    if (msg.payload.typeId.startsWith('al.control.')) {
        const control = decodeALControlMessage(msg);
        if (control.left) {
            return Either.ofLeft(control.left);
        }
        const rejection = validateALInboundControlAddress(control.right!, source, receiver);
        if (rejection) {
            return Either.ofLeft(rejection);
        }
    }
    return Either.ofRight(msg);
}

/**
 * A receipt is the server's word, so only the trusted server speaks one. Any other control is for
 * this receiver, or a receiver ACK a relaying WS server admits for the origin it names.
 */
function validateALInboundControlAddress(
    control: ALParsedControlMessage,
    source: ALInboundMessageRuntime.Source,
    receiver: ALInboundReceiver
): ALMessageRejection | undefined {
    if (control.type === 'receipt' && source.kind !== 'trusted-server') {
        return { code: 'unauthorized', message: 'AL receipt control comes only from the trusted server' };
    }
    const recipientPeerId = toALControlRecipientPeerId(control);
    if (recipientPeerId === receiver.selfPeerId) {
        return undefined;
    }
    return control.type === 'ack' && source.kind === 'ws-client' && receiver.relaysForPeerId(recipientPeerId)
        ? undefined
        : { code: 'unauthorized', message: 'Control is addressed to another local receiver' };
}
