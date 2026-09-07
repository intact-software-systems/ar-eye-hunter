import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export function validateALInboundMessage(
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    selfPeerId: string
): Either<ALMessageRejection, ALMessage> {
    if (
        source.kind !== 'trusted-server' &&
        (source.kind === 'ws-client' || msg.targets?.mode === 'unicast') &&
        msg.id.senderId !== source.peerId
    ) {
        return Either.ofLeft({ code: 'unauthorized', message: 'AL origin does not match the authenticated peer' });
    }
    if (source.kind === 'rtc-peer' && msg.targets?.mode === 'unicast' && msg.targets.toPeerId !== selfPeerId) {
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
        if (control.right!.payload.toPeerId !== selfPeerId) {
            return Either.ofLeft({ code: 'unauthorized', message: 'Control is addressed to another local receiver' });
        }
    }
    return Either.ofRight(msg);
}
