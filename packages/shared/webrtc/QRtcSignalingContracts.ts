export enum QRtcSignalingRole {
    Initiator = 'Initiator',
    Responder = 'Responder',
}

export enum QRtcSignalingType {
    Offer = 'Offer',
    Answer = 'Answer',
    IceCandidate = 'IceCandidate',
}

export enum QRtcSignalingChannel {
    RtcSignal = "RtcSignal",
}

export enum QRtcSignalingClientMsgType {
    Hello = "Hello",
    Signal = "Signal",
}

export type QRtcSignalingClientMessage =
    |
    {
        channel: QRtcSignalingChannel.RtcSignal;
        type: QRtcSignalingClientMsgType.Hello;
        sessionId: string;
        token: string;
    }
    |
    {
        channel: QRtcSignalingChannel.RtcSignal;
        type: QRtcSignalingClientMsgType.Signal;
        sessionId: string;
        token: string;
        signalType: QRtcSignalingType;
        payload: unknown;
    };

export enum QRtcSignalingServerMsgType {
    Welcome = "Welcome",
    Signal = "Signal",
    Error = "Error",
}

export type QRtcSignalingServerMessage =
    |
    {
        channel: QRtcSignalingChannel.RtcSignal;
        type: QRtcSignalingServerMsgType.Welcome;
        sessionId: string;
        role: QRtcSignalingRole;
    }
    |
    {
        channel: QRtcSignalingChannel.RtcSignal;
        type: QRtcSignalingServerMsgType.Signal;
        sessionId: string;
        fromRole: QRtcSignalingRole;
        signalType: QRtcSignalingType;
        payload: unknown;
    }
    |
    {
        channel: QRtcSignalingChannel.RtcSignal;
        type: QRtcSignalingServerMsgType.Error;
        sessionId: string;
        message: string;
    };

export type QRtcSignalingClientStateCallbacks = {
    onOpen: (sessionId: string, token: string) => Promise<void>;
    onWelcome: (sessionId: string, token: string, role: QRtcSignalingRole) => Promise<void>;
    onSignal: (sessionId: string, token: string, m: { fromRole: QRtcSignalingRole; signalType: QRtcSignalingType; payload: unknown }) => Promise<void>;
    onError: (sessionId: string, token: string, message: string) => Promise<void>;
    onClose: (sessionId: string, token: string) => Promise<void>;
};

export type QRtcSignalingTransportCallbacks = {
    onOpen: (sessionId: string, token: string) => Promise<void>;
    onError: (sessionId: string, token: string, message: string) => Promise<void>;
    onClose: (sessionId: string, token: string) => Promise<void>;
    onMessage: (sessionId: string, token: string, data: unknown) => Promise<void>;
};

export type QRtcSignalingTransportInputDto = {
    readonly callbacks: QRtcSignalingTransportCallbacks
    readonly sessionId: string
    readonly token: string
}

export interface QRtcSignalingTransport {
    connect(input: QRtcSignalingTransportInputDto): Promise<void>;

    send(payload: QRtcSignalingClientMessage): void;
}
