export type ApiConfig = {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly endpoints: {
        readonly createWs: string;
    };
};

export const chatTopicId = "chat";
export const rtcSignalingTopicId = "rtc-signaling";
export const clientTopicId = "client";

export const allTopicIds = new Set([chatTopicId, rtcSignalingTopicId, clientTopicId]);

export type ClientData = {
    readonly clientId: string;
    readonly sessionId: string;
}

export type IceConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
};
