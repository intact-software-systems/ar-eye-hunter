import { ALMessage } from '../al-contracts/al-contract.ts';

export const QRtcSignalingType = {
    Offer: 'Offer',
    Answer: 'Answer',
    IceCandidate: 'IceCandidate'
} as const;

export type QRtcSignalingType = (typeof QRtcSignalingType)[keyof typeof QRtcSignalingType];

export const QRtcSignalingChannel = {
    RtcSignal: 'RtcSignal'
} as const;

export type QRtcSignalingChannel = (typeof QRtcSignalingChannel)[keyof typeof QRtcSignalingChannel];

export const QRtcSignalingMsgType = {
    Signal: 'Signal'
} as const;

export type QRtcSignalingMsgType = (typeof QRtcSignalingMsgType)[keyof typeof QRtcSignalingMsgType];

export type QRtcSignal =
    | {
        readonly signalType: 'Offer';
        readonly offerId: string;
        readonly payload: {
            readonly description: { readonly type: 'offer'; readonly sdp: string; };
            readonly candidate: null;
        };
    }
    | {
        readonly signalType: 'Answer';
        readonly offerId: string;
        readonly payload: {
            readonly description: { readonly type: 'answer'; readonly sdp: string; };
            readonly candidate: null;
        };
    }
    | {
        readonly signalType: 'IceCandidate';
        readonly payload: { readonly description: null; readonly candidate: RTCIceCandidateInit; };
    };

export type QRtcSignalingMessage = QRtcSignal & {
    channel: typeof QRtcSignalingChannel.RtcSignal;
    type: typeof QRtcSignalingMsgType.Signal;
    fromId: string;
    toId: string;
    sessionId: string;
    token: string;
};

export interface QRtcSignalingTransportCallbacks {
    onOpen: (sessionId: string, token: string) => Promise<void>;
    onError: (sessionId: string, token: string, message: string) => Promise<void>;
    onClose: (sessionId: string, token: string) => Promise<void>;
    onMessage: (sessionId: string, token: string, data: ALMessage) => Promise<void | 'retry'>;
}

export interface QRtcSignalingTransportInputDto {
    readonly callbacks: QRtcSignalingTransportCallbacks;
    readonly sessionId: string;
    readonly token: string;
}

export interface QRtcSignalingSender {
    send(payload: QRtcSignalingMessage): Promise<void>;
}

export interface QRtcSignalingTransport extends QRtcSignalingSender {
    connect(input: QRtcSignalingTransportInputDto): Promise<void>;
}
