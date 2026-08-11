import { ALMessage } from '../al-contracts/al-contract.ts';

export const QRtcSignalingType = {
    Offer: 'Offer',
    Answer: 'Answer',
    IceCandidate: 'IceCandidate',
} as const;

export type QRtcSignalingType = (typeof QRtcSignalingType)[keyof typeof QRtcSignalingType];

export const QRtcSignalingChannel = {
    RtcSignal: 'RtcSignal',
} as const;

export type QRtcSignalingChannel = (typeof QRtcSignalingChannel)[keyof typeof QRtcSignalingChannel];

export const QRtcSignalingMsgType = {
    Signal: 'Signal',
} as const;

export type QRtcSignalingMsgType = (typeof QRtcSignalingMsgType)[keyof typeof QRtcSignalingMsgType];

export type QRtcSignalingMessage = {
    channel: typeof QRtcSignalingChannel.RtcSignal;
    type: typeof QRtcSignalingMsgType.Signal;
    fromId: string;
    toId: string;
    sessionId: string;
    token: string;
    signalType: QRtcSignalingType;
    payload: unknown;
};

export type QRtcSignalingTransportCallbacks = {
    onOpen: (sessionId: string, token: string) => Promise<void>;
    onError: (sessionId: string, token: string, message: string) => Promise<void>;
    onClose: (sessionId: string, token: string) => Promise<void>;
    onMessage: (sessionId: string, token: string, data: ALMessage) => Promise<void>;
};

export type QRtcSignalingTransportInputDto = {
    readonly callbacks: QRtcSignalingTransportCallbacks
    readonly sessionId: string
    readonly token: string
}

export interface QRtcSignalingSender {
    send(payload: QRtcSignalingMessage): Promise<void>;
}

export interface QRtcSignalingTransport extends QRtcSignalingSender {
    connect(input: QRtcSignalingTransportInputDto): Promise<void>;
}
