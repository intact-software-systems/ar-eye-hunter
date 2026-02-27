export type ApiConfig = {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly endpoints: {
        readonly createWs: string;
    };
};

export const ChatTopicId = "chat";
export const RtcSignalingTopicId = "rtc-signaling";
export const ClientTopicId = "client";

export const allTopicIds = new Set([ChatTopicId, RtcSignalingTopicId, ClientTopicId]);

export type ClientData = {
    readonly clientId: string;
    readonly sessionId: string;
}
