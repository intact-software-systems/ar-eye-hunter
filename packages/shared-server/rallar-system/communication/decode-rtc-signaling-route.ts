import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType
} from '@shared/webrtc/QRtcSignalingContracts.ts';

import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';

export interface RtcSignalingRoute {
    readonly toId: string;
}

export function decodeRtcSignalingRoute(serialized: string): RtcSignalingRoute {
    const message = requireRecord(
        decodeJsonWireValue(JSON.parse(serialized), 'RTC signaling message'),
        'RTC signaling message'
    );
    requireExactKeys(message, [
        'channel',
        'type',
        'fromId',
        'toId',
        'sessionId',
        'token',
        'signalType',
        'payload'
    ], 'RTC signaling message');
    if (message.channel !== QRtcSignalingChannel.RtcSignal) {
        throw new TypeError('RTC signaling channel is invalid');
    }
    if (message.type !== QRtcSignalingMsgType.Signal) {
        throw new TypeError('RTC signaling message type is invalid');
    }
    requireString(message.fromId, 'RTC signaling sender');
    requireString(message.toId, 'RTC signaling recipient');
    requireString(message.sessionId, 'RTC signaling session');
    requireString(message.token, 'RTC signaling ticket');
    requireOneOf(message.signalType, Object.values(QRtcSignalingType), 'RTC signaling signal type');

    return { toId: message.toId };
}
