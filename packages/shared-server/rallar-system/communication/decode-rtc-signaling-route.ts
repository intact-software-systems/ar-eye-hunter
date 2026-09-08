import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import { decodeRtcSignalingEnvelope } from '@shared/webrtc/decode-rtc-signaling-message.ts';

export interface RtcSignalingRoute {
    readonly toId: string;
}

export function decodeRtcSignalingRoute(message: ALMessage): Either<ALMessageRejection, RtcSignalingRoute> {
    return decodeRtcSignalingEnvelope(message).fold(
        (rejection) => Either.ofLeft(rejection),
        (signal) => Either.ofRight({ toId: signal.toId })
    );
}

export function validateRtcSignalingMessage(message: ALMessage): Either<ALMessageRejection, ALMessage> {
    return decodeRtcSignalingRoute(message).fold(
        (rejection) => Either.ofLeft(rejection),
        () => Either.ofRight(message)
    );
}
