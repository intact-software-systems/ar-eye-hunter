import { ALMessage } from '../al-contracts/al-contract.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { QRtcDataChannel } from '../webrtc/QRtcDataChannel.ts';
import { JsonWebSocketClient } from '../websocket/JsonWebSocketClient.ts';
import { JsonWebSocketServer } from '../websocket/JsonWebSocketServer.ts';

export interface OnOutboxWebSocketMessageCallback {
    onMessage: (entry: ResourceEntry, client: JsonWebSocketClient) => Promise<void>;
}

export interface OnWebSocketServerMessageCallback<T> {
    onMessage: (value: T, entry: ResourceEntry, server: JsonWebSocketServer) => Promise<void>;
}

export interface OnMessageCallback {
    onMessage: (message: ALMessage, entry: ResourceEntry) => Promise<void>;
}

export interface OnOutboxWebRtcMessageCallback {
    onMessage: (entry: ResourceEntry, webRtcChannel: QRtcDataChannel) => Promise<void>;
}

export interface OnInboxWebRtcMessageCallback {
    onMessage: (entry: ResourceEntry, webRtcChannel: QRtcDataChannel) => Promise<void>;
}
