import {
    createBrowserMessagingComposition,
    createBrowserRealtimeCoreComposition
} from '@shared-web/browser/composition/browser-communication-composition.ts';
import {
    registerBrowserStateLifecycle,
    registerBrowserTransportLifecycle
} from '@shared-web/browser/composition/browser-lifecycle-composition.ts';
import {
    createBrowserDirectorComposition,
    createBrowserRoomsComposition
} from '@shared-web/browser/composition/browser-product-composition.ts';
import {
    createBrowserRuntimeFoundation,
    createBrowserStateComposition,
    createBrowserStateEventComposition
} from '@shared-web/browser/composition/browser-runtime-composition.ts';
import {
    createBrowserCrdtComposition,
    createBrowserSessionCoreComposition
} from '@shared-web/browser/composition/browser-session-composition.ts';
import type {
    RallarDirectorFacade,
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarAuthFacade } from '@shared-web/browser/rallar-core.ts';
import type { RallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import type { RallarRealtimeFacade, RallarWsFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomSession } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { BlackBoxRallarDirectorOutputRecord, BlackBoxRallarEvent } from './contracts.ts';

export interface BlackBoxBrowserRallarRuntimeDependency extends
    Pick<
        RallarConnectionOperations,
        | 'configure'
        | 'setDefaults'
        | 'status'
        | 'isConnected'
        | 'session'
    > {
    connect(options?: Parameters<RallarConnectionOperations['connect']>[0]): Promise<object>;
    disconnect(): Promise<void>;
    readonly auth: BlackBoxBrowserAuthDependency;
    readonly rooms: BlackBoxBrowserRoomsDependency;
    readonly messages: BlackBoxBrowserMessagesDependency;
    readonly realtime: BlackBoxBrowserRealtimeDependency;
    readonly ws: BlackBoxBrowserWsDependency;
    readonly rtc: BlackBoxBrowserRtcDependency;
    readonly crdt: BlackBoxBrowserCrdtDependency;
    readonly director: BlackBoxBrowserDirectorDependency;
}

export interface BlackBoxBrowserAuthDependency
    extends Pick<RallarAuthFacade, 'login' | 'registerAndLogin' | 'logout' | 'restore'> {}

export interface BlackBoxBrowserRoomsDependency {
    join(
        room: Parameters<BrowserRallarRooms['join']>[0],
        options?: Parameters<BrowserRallarRooms['join']>[1]
    ): Promise<object>;
    leave(input?: Parameters<BrowserRallarRooms['leave']>[0]): Promise<object | undefined>;
    refresh(input?: Parameters<BrowserRallarRooms['refresh']>[0]): Promise<object>;
    session(room?: Parameters<BrowserRallarRooms['session']>[0]): BlackBoxBrowserRoomSessionDependency;
}

export interface BlackBoxBrowserRoomSessionDependency {
    refresh(options?: Parameters<RallarRoomSession['refresh']>[0]): Promise<object>;
}

export interface BlackBoxBrowserMessagesDependency extends Pick<RallarMessagesOperations, 'rtc' | 'ws'> {}

export interface BlackBoxBrowserRealtimeDependency
    extends Pick<RallarRealtimeFacade, 'sendJson' | 'onJson' | 'health'> {}

export interface BlackBoxBrowserWsDependency extends Pick<RallarWsFacade, 'status'> {}

export interface BlackBoxBrowserRtcDependency extends Pick<RallarRtcFacade, 'status' | 'diagnostics'> {}

export interface BlackBoxBrowserCrdtDependency extends Pick<RallarCrdtFacade, 'open'> {}

export interface BlackBoxBrowserDirectorDependency extends Pick<RallarDirectorFacade, 'appoint' | 'resign' | 'status'> {
    createRelay(
        config: RallarDirectorRelayConfig<
            BlackBoxRallarEvent['data'],
            BlackBoxRallarDirectorOutputRecord,
            BlackBoxRallarEvent['data']
        >
    ): RallarDirectorRelayHandle<
        BlackBoxRallarEvent['data'],
        BlackBoxRallarDirectorOutputRecord,
        BlackBoxRallarEvent['data']
    >;
}

export function createBlackBoxBrowserRallarRuntimeDependency(): BlackBoxBrowserRallarRuntimeDependency {
    const foundation = createBrowserRuntimeFoundation();
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const session = createBrowserSessionCoreComposition({ foundation, state });
    const stateEvents = createBrowserStateEventComposition({
        connectionRuntime: foundation.connectionRuntime,
        session: session.session
    });
    const messaging = createBrowserMessagingComposition({
        wsInbox: stateEvents.wsInbox,
        state,
        session: session.session
    });
    const realtime = createBrowserRealtimeCoreComposition({
        runtime: foundation.runtime,
        state,
        session: session.session
    });
    const rooms = createBrowserRoomsComposition({
        state,
        stateEvents,
        messaging,
        realtime,
        session: session.session
    });
    const director = createBrowserDirectorComposition({
        state,
        messaging,
        realtime,
        rooms,
        session: session.session
    });
    registerBlackBoxBrowserRallarLifecycle({
        foundation,
        state,
        stateEvents,
        messaging,
        realtime,
        director
    });
    const crdt = createBrowserCrdtComposition({
        session,
        state,
        messaging
    });
    return {
        ...session.connection,
        auth: session.auth,
        rooms: rooms.rooms,
        messages: messaging.messages,
        realtime: realtime.realtime,
        ws: realtime.wsController.facade,
        rtc: realtime.rtc,
        crdt: crdt.crdt,
        director: director.director
    };
}

interface RegisterBlackBoxBrowserRallarLifecycleInput {
    readonly foundation: ReturnType<typeof createBrowserRuntimeFoundation>;
    readonly state: ReturnType<typeof createBrowserStateComposition>;
    readonly stateEvents: ReturnType<typeof createBrowserStateEventComposition>;
    readonly messaging: ReturnType<typeof createBrowserMessagingComposition>;
    readonly realtime: ReturnType<typeof createBrowserRealtimeCoreComposition>;
    readonly director: ReturnType<typeof createBrowserDirectorComposition>;
}

function registerBlackBoxBrowserRallarLifecycle(
    input: RegisterBlackBoxBrowserRallarLifecycleInput
): void {
    registerBrowserStateLifecycle({
        lifecycle: input.foundation.lifecycle,
        directorRelays: input.director.directorRelays,
        stateStore: input.state.stateStore
    });
    registerBrowserTransportLifecycle({
        lifecycle: input.foundation.lifecycle,
        messageSubscriptions: input.messaging.messagesController.subscriptions,
        wsInbox: input.stateEvents.wsInbox,
        wsController: input.realtime.wsController,
        realtimeReceive: input.realtime.realtimeReceive,
        rtcLifecycle: input.realtime.rtcController.lifecycle
    });
}
