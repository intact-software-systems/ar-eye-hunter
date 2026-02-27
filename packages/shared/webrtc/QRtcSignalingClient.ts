import {
    QRtcSignalingChannel,
    QRtcSignalingClientMsgType,
    QRtcSignalingClientStateCallbacks,
    QRtcSignalingServerMessage,
    QRtcSignalingServerMsgType,
    QRtcSignalingTransport,
    QRtcSignalingTransportCallbacks,
    QRtcSignalingTransportInputDto,
    QRtcSignalingType
} from "./QRtcSignalingContracts.ts";

export type QRtcSignalingClientInputDto = {
    readonly callbacks: QRtcSignalingClientStateCallbacks
    readonly sessionId: string
    readonly token: string
}

export class QRtcSignalingClient {
    public readonly transportInput: QRtcSignalingTransportInputDto;

    constructor(
        public readonly signaler: QRtcSignalingTransport,
        public readonly input: QRtcSignalingClientInputDto
    ) {
        this.transportInput = {
            sessionId: this.input.sessionId,
            token: this.input.token,
            callbacks: this.toSignalingProtocol(input.callbacks)
        }
    }

    private toSignalingProtocol(callbacks: QRtcSignalingClientStateCallbacks): QRtcSignalingTransportCallbacks {
        return {
            onOpen: async (sessionId: string, token: string) => {
                await callbacks.onOpen(sessionId, token);

                // TODO: Is it needed?
                //this.sendHello();
            },

            onError: async (sessionId: string, token: string, message: string) => {
                await callbacks.onError(sessionId, token, message);
            },

            onClose: async (sessionId: string, token: string) => {
                await callbacks.onClose(sessionId, token);
            },

            onMessage: async (sessionId: string, token: string, data: unknown) => {
                const msg: QRtcSignalingServerMessage = JSON.parse(data as string) as QRtcSignalingServerMessage

                switch (msg.type) {

                    case QRtcSignalingServerMsgType.Welcome: {
                        await callbacks.onWelcome(sessionId, token, msg.role)
                        break;
                    }

                    case QRtcSignalingServerMsgType.Signal: {
                        await callbacks.onSignal(
                            sessionId,
                            token,
                            {
                                fromRole: msg.fromRole,
                                signalType: msg.signalType,
                                payload: msg.payload
                            }
                        )
                        break;
                    }

                    case QRtcSignalingServerMsgType.Error: {
                        await callbacks.onError(
                            sessionId,
                            token,
                            msg.message
                        )
                        break;
                    }
                }
            }
        };
    }

    async connect(): Promise<void> {
        return await this.signaler.connect(this.transportInput)
    }

    sendHello() {
        this.signaler.send(
            {
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingClientMsgType.Hello,
                sessionId: this.input.sessionId,
                token: this.input.token
            }
        )
    }

    sendSignal(signalType: QRtcSignalingType, payload: unknown): void {
        this.signaler.send(
            {
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingClientMsgType.Signal,
                sessionId: this.transportInput.sessionId,
                token: this.transportInput.token,
                signalType: signalType,
                payload: payload,
            }
        );
    }
}