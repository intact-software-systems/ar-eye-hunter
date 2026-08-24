import type { RallarDirectorController } from '@shared-web/browser/rallar-runtime/director.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import type { RallarMediaPort } from '@shared-web/browser/rallar-runtime/media.ts';
import type { RallarMessagesController } from '@shared-web/browser/rallar-runtime/messages.ts';
import type { RallarRealtimeController } from '@shared-web/browser/rallar-runtime/realtime.ts';
import type { RallarRtcController } from '@shared-web/browser/rallar-runtime/rtc.ts';
import type { RallarStatePort } from '@shared-web/browser/rallar-runtime/state-store.ts';
import type { RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import type { RallarWsController } from '@shared-web/browser/rallar-runtime/ws.ts';

export interface RegisterBrowserStateLifecycleInput {
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly directorController: RallarDirectorController;
    readonly stateStore: RallarStatePort;
}

export interface RegisterBrowserTransportLifecycleInput {
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly messagesController: RallarMessagesController;
    readonly wsInbox: RallarWsInbox;
    readonly wsController: RallarWsController;
    readonly realtimeController: RallarRealtimeController;
    readonly rtcController: RallarRtcController;
    readonly mediaController: RallarMediaPort;
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
        attach: (context) => input.messagesController.attachRtc(context),
        detach: (context) => input.messagesController.detachRtc(context)
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
        attach: (context) => input.realtimeController.attachPeerLifecycle(context),
        detach: (context) => input.realtimeController.detachPeerLifecycle(context)
    });
    input.lifecycle.register({
        id: 'rtc-status',
        order: 70,
        attach: (context) => input.rtcController.attach(context),
        connected: () => input.rtcController.connected(),
        detach: (context) => input.rtcController.detach(context),
        disconnected: () => input.rtcController.disconnected()
    });
    input.lifecycle.register({
        id: 'realtime-lanes',
        order: 80,
        attach: () => input.realtimeController.attachLaneCallbacks(),
        detach: (context) => input.realtimeController.detachLaneCallbacks(context)
    });
    input.lifecycle.register({
        id: 'media',
        order: 90,
        attach: () => input.mediaController.attachRemoteStreamCallback(),
        detach: (context) => input.mediaController.stopForDisconnect(context)
    });
}
