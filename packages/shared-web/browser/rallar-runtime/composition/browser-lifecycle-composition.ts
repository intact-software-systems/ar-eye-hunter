import type { RallarDirectorController } from '@shared-web/browser/director/browser-rallar-director-controller.ts';
import type { BrowserLocalMediaSourceRuntime } from '@shared-web/browser/media/browser-local-media-source-runtime.ts';
import type { BrowserRemoteMediaStreamRuntime } from '@shared-web/browser/media/browser-remote-media-stream-runtime.ts';
import type { BrowserRallarMessageSubscriptions } from '@shared-web/browser/messages/browser-rallar-message-subscriptions.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import type { RallarStatePort } from '@shared-web/browser/rallar-runtime/state-store.ts';
import type { BrowserRealtimeReceiveRuntime } from '@shared-web/browser/realtime/browser-realtime-receive-runtime.ts';
import type { BrowserRtcLifecycleRuntime } from '@shared-web/browser/rtc/browser-rtc-lifecycle-runtime.ts';
import type { RallarWsController } from '@shared-web/browser/websocket/browser-rallar-ws-controller.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';

export interface RegisterBrowserStateLifecycleInput {
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly directorController: RallarDirectorController;
    readonly stateStore: RallarStatePort;
}

export interface RegisterBrowserTransportLifecycleInput {
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly messageSubscriptions: BrowserRallarMessageSubscriptions;
    readonly wsInbox: BrowserWebSocketInbox;
    readonly wsController: RallarWsController;
    readonly realtimeReceive: BrowserRealtimeReceiveRuntime;
    readonly rtcLifecycle: BrowserRtcLifecycleRuntime;
}

export interface RegisterBrowserMediaLifecycleInput {
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly localMediaSources: BrowserLocalMediaSourceRuntime;
    readonly remoteMediaStreams: BrowserRemoteMediaStreamRuntime;
}

export function registerBrowserStateLifecycle(input: RegisterBrowserStateLifecycleInput): void {
    input.lifecycle.register({
        id: 'director-relays',
        order: 10,
        detach: () => input.directorController.stopRelays()
    });
    input.lifecycle.register({
        id: 'state-cache',
        order: 20,
        attach: () => input.stateStore.attachCache(),
        connected: () => input.stateStore.emit(),
        detach: () => input.stateStore.detachCache(),
        disconnected: () => input.stateStore.emit()
    });
}

export function registerBrowserTransportLifecycle(
    input: RegisterBrowserTransportLifecycleInput
): void {
    input.lifecycle.register({
        id: 'rtc-message-inbox',
        order: 30,
        attach: (context) => input.messageSubscriptions.attachRtc(context),
        detach: (context) => input.messageSubscriptions.detachRtc(context)
    });
    input.lifecycle.register({
        id: 'ws-inbox',
        order: 40,
        attach: (context) => input.wsInbox.attach(context),
        detach: (context) => input.wsInbox.detach(context)
    });
    input.lifecycle.register({
        id: 'ws-status',
        order: 50,
        attach: (context) => input.wsController.attach(context),
        connected: () => input.wsController.connected(),
        detach: (context) => input.wsController.detach(context),
        disconnected: () => input.wsController.disconnected()
    });
    input.lifecycle.register({
        id: 'realtime-peer-lifecycle',
        order: 60,
        attach: (context) => input.realtimeReceive.attachPeerLifecycle(context),
        detach: (context) => input.realtimeReceive.detachPeerLifecycle(context)
    });
    input.lifecycle.register({
        id: 'rtc-status',
        order: 70,
        attach: (context) => input.rtcLifecycle.attach(context),
        connected: () => input.rtcLifecycle.connected(),
        detach: (context) => input.rtcLifecycle.detach(context),
        disconnected: () => input.rtcLifecycle.disconnected()
    });
    input.lifecycle.register({
        id: 'realtime-lanes',
        order: 80,
        attach: () => input.realtimeReceive.attachLaneCallbacks(),
        detach: (context) => input.realtimeReceive.detachLaneCallbacks(context)
    });
}

export function registerBrowserMediaLifecycle(
    input: RegisterBrowserMediaLifecycleInput
): void {
    input.lifecycle.register({
        id: 'media',
        order: 90,
        attach: () => input.remoteMediaStreams.attach(),
        detach: (context) => {
            input.remoteMediaStreams.stopForDisconnect(context);
            input.localMediaSources.stopForDisconnect();
        }
    });
}
