import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageRejection } from '../al-contracts/al-message-persistence-validation.ts';
import {
    decodePersistedALRecord,
    requirePersistedALFields
} from '../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { validateALMessageResourceLimits } from '../al-contracts/al-message-resource-limits.ts';
import { Either } from '../resilience/Either.ts';
import { toError } from '../resilience/to-error.ts';
import { QRtcDataExchanged } from './qrtc-peer-connection.ts';
import {
    QRtcSignalingMessage,
    QRtcSignalingType
} from './QRtcSignalingContracts.ts';

export interface DecodedRtcSignalingMessage extends QRtcSignalingMessage {
    readonly payload: QRtcDataExchanged;
}

export class RtcSignalingDecodeError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = 'RtcSignalingDecodeError';
    }
}

export function decodeRtcSignalingEnvelope(message: ALMessage): Either<ALMessageRejection, DecodedRtcSignalingMessage> {
    const issues = validateALMessageResourceLimits(message);
    if (issues.length > 0) {
        return Either.ofLeft({ code: issues[0].code, message: 'Invalid RTC signaling message' });
    }
    try {
        const signal = decodeRtcSignalingMessage(message.payload.resource);
        if (
            signal.fromId !== message.id.senderId || message.targets?.mode !== 'unicast' ||
            signal.toId !== message.targets.toPeerId
        ) {
            return Either.ofLeft({
                code: 'unauthorized',
                message: 'RTC signaling identity does not match its AL envelope'
            });
        }
        return Either.ofRight(signal);
    }
    catch {
        return Either.ofLeft({ code: 'malformed', message: 'Invalid RTC signaling message' });
    }
}

export function decodeRtcSignalingMessage(serialized: string): DecodedRtcSignalingMessage {
    try {
        const message = decodePersistedALRecord(serialized, 'RTC signaling message');
        const fields = ['channel', 'type', 'fromId', 'toId', 'sessionId', 'token', 'signalType', 'payload'];
        requirePersistedALFields(message, fields, fields);
        if (message.channel !== 'RtcSignal' || message.type !== 'Signal') {
            throw new RtcSignalingDecodeError('Invalid RTC signaling channel or type');
        }
        if (
            typeof message.fromId !== 'string' || message.fromId.length === 0 ||
            typeof message.toId !== 'string' || message.toId.length === 0 ||
            typeof message.sessionId !== 'string' || message.sessionId.length === 0 ||
            typeof message.token !== 'string' || message.token.length === 0
        ) {
            throw new RtcSignalingDecodeError('Invalid RTC signaling identity');
        }
        if (
            message.signalType !== 'Offer' && message.signalType !== 'Answer' && message.signalType !== 'IceCandidate'
        ) {
            throw new RtcSignalingDecodeError('Invalid RTC signaling operation');
        }
        return {
            channel: message.channel,
            type: message.type,
            fromId: message.fromId,
            toId: message.toId,
            sessionId: message.sessionId,
            token: message.token,
            signalType: message.signalType,
            payload: decodeRtcSignalingPayload(message.signalType, message.payload)
        };
    }
    catch (caught) {
        const error = toError(caught);
        if (error instanceof RtcSignalingDecodeError) {
            throw error;
        }
        // Native JSON parse errors may quote SDP or credentials from the input.
        throw new RtcSignalingDecodeError('Invalid RTC signaling message');
    }
}

export function decodeRtcSignalingPayload(signalType: QRtcSignalingType, value: unknown): QRtcDataExchanged {
    if (value === null || typeof value !== 'object' || !('description' in value) || !('candidate' in value)) {
        throw new RtcSignalingDecodeError('Invalid RTC signaling payload');
    }
    assertRtcSignalingFields(value, ['description', 'candidate']);
    if (signalType === 'IceCandidate') {
        if (value.description !== null) {
            throw new RtcSignalingDecodeError('Unexpected ICE description');
        }
        return { description: null, candidate: decodeIceCandidate(value.candidate) };
    }
    if (value.candidate !== null) {
        throw new RtcSignalingDecodeError('Unexpected description candidate');
    }
    const description = value.description;
    const expectedType = signalType === 'Offer' ? 'offer' : 'answer';
    if (
        description === null || typeof description !== 'object' || !('type' in description) ||
        description.type !== expectedType || !('sdp' in description) || typeof description.sdp !== 'string'
    ) {
        throw new RtcSignalingDecodeError('Invalid RTC session description');
    }
    assertRtcSignalingFields(description, ['type', 'sdp']);
    return { description: { type: expectedType, sdp: description.sdp }, candidate: null };
}

function decodeIceCandidate(value: unknown): RTCIceCandidateInit {
    if (value === null || typeof value !== 'object' || !('candidate' in value) || typeof value.candidate !== 'string') {
        throw new RtcSignalingDecodeError('Invalid RTC ICE candidate');
    }
    assertRtcSignalingFields(value, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
    const sdpMid = 'sdpMid' in value ? value.sdpMid : undefined;
    const sdpMLineIndex = 'sdpMLineIndex' in value ? value.sdpMLineIndex : undefined;
    const usernameFragment = 'usernameFragment' in value ? value.usernameFragment : undefined;
    if (sdpMid !== undefined && sdpMid !== null && typeof sdpMid !== 'string') {
        throw new RtcSignalingDecodeError('Invalid RTC ICE media identifier');
    }
    if (
        sdpMLineIndex !== undefined && sdpMLineIndex !== null &&
        (typeof sdpMLineIndex !== 'number' || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 ||
            sdpMLineIndex > 65535)
    ) {
        throw new RtcSignalingDecodeError('Invalid RTC ICE media index');
    }
    if (usernameFragment !== undefined && usernameFragment !== null && typeof usernameFragment !== 'string') {
        throw new RtcSignalingDecodeError('Invalid RTC ICE username fragment');
    }
    return {
        candidate: value.candidate,
        ...(sdpMid !== undefined ? { sdpMid } : {}),
        ...(sdpMLineIndex !== undefined ? { sdpMLineIndex } : {}),
        ...(usernameFragment !== undefined ? { usernameFragment } : {})
    };
}

function assertRtcSignalingFields(value: object, allowed: readonly string[]): void {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new RtcSignalingDecodeError('Invalid RTC signaling payload record');
    }
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) {
            throw new RtcSignalingDecodeError('Invalid RTC signaling payload fields');
        }
    }
}
