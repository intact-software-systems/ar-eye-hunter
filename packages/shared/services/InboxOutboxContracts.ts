import {ResourceEntry} from "../queuebox/ResourceEntry.ts";
import {JsonWebSocketClient} from "../websocket/JsonWebSocketClient.ts";
import {JsonWebSocketServer} from "../websocket/JsonWebSocketServer.ts";
import {MyWebRtcChannel} from "../webrtc/MyWebRtcChannel.ts";

export interface OnOutboxWebSocketMessageCallback {
    onMessage: (entry: ResourceEntry, client: JsonWebSocketClient) => Promise<void>
}

export interface OnInboxWebSocketMessageCallback<T> {
    onMessage: (value: T, entry: ResourceEntry, server: JsonWebSocketServer) => Promise<void>
}

export interface OnMessageCallback {
    onMessage: (entry: ResourceEntry) => Promise<void>
}

export interface OnOutboxWebRtcMessageCallback {
    onMessage: (entry: ResourceEntry, webRtcChannel: MyWebRtcChannel) => Promise<void>
}

export interface OnInboxWebRtcMessageCallback {
    onMessage: (entry: ResourceEntry, webRtcChannel: MyWebRtcChannel) => Promise<void>
}
