import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    toALControlRecipientPeerId,
    type ALAckPayload,
    type ALNackPayload,
    type ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

/** Who an inbound runtime receives for: itself, and the origins whose receiver ACKs it aggregates. */
export interface ALInboundReceiver {
    readonly selfPeerId: string;
    /**
     * Why a receiver's ACK addressed to its origin may not be admitted here as that origin's aggregating
     * relay hop; undefined admits it. The WS server answers for the broadcasts it aggregates.
     */
    readonly readRelayedAckRejection: (
        ack: ALAckPayload,
        controlIdentity?: ALMessage['id']
    ) => ALMessageRejection | undefined;
    /**
     * Why a session's NACK or repair addressed to another session, the origin of a track this receiver relays, may
     * not be admitted here for that origin's row; undefined admits it. The WS server answers for the rows it relays.
     */
    readonly readRelayedRepairRequestRejection: (
        request: ALNackPayload | ALRepairPayload,
        requesterPeerId: string
    ) => Promise<ALMessageRejection | undefined>;
}

const NOT_THIS_RECEIVER: ALMessageRejection = {
    code: 'unauthorized',
    message: 'Control is addressed to another local receiver'
};

export function toALInboundReceiver(
    selfPeerId: string,
    readRelayedAckRejection: ALInboundReceiver['readRelayedAckRejection'] | undefined,
    readRelayedRepairRequestRejection: ALInboundReceiver['readRelayedRepairRequestRejection'] | undefined
): ALInboundReceiver {
    return {
        selfPeerId,
        readRelayedAckRejection: readRelayedAckRejection ?? (() => NOT_THIS_RECEIVER),
        readRelayedRepairRequestRejection: readRelayedRepairRequestRejection ??
            (() => Promise.resolve(NOT_THIS_RECEIVER))
    };
}

export async function readALInboundMessageAuthorization(
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    receiver: ALInboundReceiver
): Promise<Either<ALMessageRejection, ALMessage>> {
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
    if (
        source.kind === 'rtc-peer' && msg.targets?.mode === 'multicast' &&
        !resolveALFrozenMulticastAudience(msg.targets)
    ) {
        return Either.ofLeft({ code: 'malformed', message: 'RTC room multicast carries no frozen audience' });
    }
    if (msg.payload.typeId.startsWith('al.control.')) {
        const rejection = await readALInboundControlRejection(msg, source, receiver);
        if (rejection) {
            return Either.ofLeft(rejection);
        }
    }
    return Either.ofRight(msg);
}

/**
 * A receipt is the server's word, so only the trusted server speaks one. A WS session never relays, so
 * its ACK or NACK speaks only for itself, whoever it is addressed to. Any other control is for this receiver,
 * or a session's receiver ACK, NACK or repair a relaying WS server admits for the origin it names.
 */
async function readALInboundControlRejection(
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    receiver: ALInboundReceiver
): Promise<ALMessageRejection | undefined> {
    const decoded = decodeALControlMessage(msg);
    if (decoded.left) {
        return decoded.left;
    }
    const control = decoded.right!;
    if (control.type === 'receipt' && source.kind !== 'trusted-server') {
        return { code: 'unauthorized', message: 'AL receipt control comes only from the trusted server' };
    }
    if (
        (control.type === 'ack' || control.type === 'nack') && source.kind === 'ws-client' &&
        control.payload.fromPeerId !== control.payload.logicalRecipientPeerId
    ) {
        const controlName = control.type === 'ack' ? 'acknowledgement' : 'NACK';
        return {
            code: 'unauthorized',
            message: `AL ${controlName} from a WS session speaks for another recipient than its sender`
        };
    }
    if (toALControlRecipientPeerId(control) === receiver.selfPeerId) {
        return undefined;
    }
    if (source.kind !== 'ws-client' || control.type === 'receipt') {
        return NOT_THIS_RECEIVER;
    }
    return control.type === 'ack'
        ? receiver.readRelayedAckRejection(control.payload, msg.id)
        : await receiver.readRelayedRepairRequestRejection(control.payload, msg.id.senderId);
}
