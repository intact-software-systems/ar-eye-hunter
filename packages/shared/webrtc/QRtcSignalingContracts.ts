import {ALMessage} from "../al-contracts/al-contract.ts";

export enum QRtcSignalingType {
    Offer = 'Offer',
    Answer = 'Answer',
    IceCandidate = 'IceCandidate',
}

export enum QRtcSignalingChannel {
    RtcSignal = "RtcSignal",
}

export enum QRtcSignalingMsgType {
    Signal = "Signal",
}

export type QRtcSignalingMessage = {
    channel: QRtcSignalingChannel.RtcSignal;
    type: QRtcSignalingMsgType.Signal;
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
