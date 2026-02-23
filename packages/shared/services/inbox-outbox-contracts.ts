import {ResourceEntry} from "../queuebox/ResourceEntry.ts";
import {JsonWebSocketClient} from "./JsonWebSocketClient.ts";
import {JsonWebSocketServer} from "./JsonWebSocketServer.ts";

export interface OnOutboxWebSocketMessageCallback {
    onMessage: (entry: ResourceEntry, client: JsonWebSocketClient) => Promise<void>
}

export interface OnInboxWebSocketMessageCallback<T> {
    onMessage: (value: T, entry: ResourceEntry, server: JsonWebSocketServer) => Promise<void>
}

export interface OnMessageCallback {
    onMessage: (entry: ResourceEntry) => Promise<void>
}
