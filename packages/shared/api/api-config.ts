export type ApiConfig = {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly endpoints: {
        readonly createWs: string;
    };
};

export const ChatTopicId = "chat";
export const RtcSignalingTopicId = "rtc-signaling";

export const allTopicIds = new Set([ChatTopicId, RtcSignalingTopicId]);


export type ClientData = {
    readonly clientId: string;
    readonly sessionId: string;
}
