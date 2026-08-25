import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';

import {
    createBrowserMediaComposition,
    createBrowserMessagingComposition,
    createBrowserRealtimeCoreComposition,
    type BrowserMediaComposition,
    type BrowserMessagingComposition,
    type BrowserRealtimeCoreComposition
} from './composition/browser-communication-composition.ts';
import { createBrowserFacadeAssembly } from './composition/browser-facade-assembly.ts';
import {
    registerBrowserMediaLifecycle,
    registerBrowserStateLifecycle,
    registerBrowserTransportLifecycle
} from './composition/browser-lifecycle-composition.ts';
import {
    createBrowserCallsComposition,
    createBrowserDirectorComposition,
    createBrowserPeopleStatsComposition,
    createBrowserRoomsComposition,
    type BrowserCallsComposition,
    type BrowserDirectorComposition,
    type BrowserPeopleStatsComposition,
    type BrowserRoomsComposition
} from './composition/browser-product-composition.ts';
import {
    createBrowserRuntimeFoundation,
    createBrowserStateComposition,
    createBrowserStateEventComposition,
    type BrowserRuntimeFoundation,
    type BrowserStateComposition,
    type BrowserStateEventComposition
} from './composition/browser-runtime-composition.ts';
import {
    createBrowserCrdtComposition,
    createBrowserSessionCoreComposition,
    createBrowserStartupComposition,
    type BrowserCrdtComposition,
    type BrowserSessionCoreComposition,
    type BrowserStartupComposition
} from './composition/browser-session-composition.ts';

interface BrowserFacadeCompositions {
    readonly session: BrowserSessionCoreComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly media: BrowserMediaComposition;
    readonly rooms: BrowserRoomsComposition;
    readonly peopleStats: BrowserPeopleStatsComposition;
    readonly calls: BrowserCallsComposition;
    readonly director: BrowserDirectorComposition;
    readonly startup: BrowserStartupComposition;
    readonly crdt: BrowserCrdtComposition;
}

export function createRallarFacade(): RallarFacade {
    const foundation = createBrowserRuntimeFoundation();
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const compositions = createBrowserFacadeCompositions(foundation, state);
    registerBrowserFacadeLifecycle(foundation, state, compositions);
    return createBrowserFacadeAssembly({
        session: compositions.session,
        startup: compositions.startup,
        crdt: compositions.crdt,
        messaging: compositions.messaging,
        realtime: compositions.realtime,
        media: compositions.media,
        rooms: compositions.rooms,
        peopleStats: compositions.peopleStats,
        calls: compositions.calls,
        director: compositions.director
    });
}

function createBrowserFacadeCompositions(
    foundation: BrowserRuntimeFoundation,
    state: BrowserStateComposition
): BrowserFacadeCompositions {
    const session = createBrowserSessionCoreComposition({ foundation, state });
    const sessionPort = session.session;
    const stateEvents = createBrowserStateEventComposition({
        connectionRuntime: foundation.connectionRuntime,
        session: sessionPort
    });
    const messaging = createBrowserMessagingComposition({
        wsInbox: stateEvents.wsInbox,
        state,
        session: sessionPort
    });
    const realtime = createBrowserRealtimeCoreComposition({ runtime: foundation.runtime, state, session: sessionPort });
    const media = createBrowserMediaComposition({ session: sessionPort });
    const rooms = createBrowserRoomsComposition({
        state,
        stateEvents,
        messaging,
        realtime,
        session: sessionPort
    });
    const peopleStats = createBrowserPeopleStatsComposition({
        state,
        stateEvents,
        session: sessionPort
    });
    const calls = createBrowserCallsComposition({
        state,
        messaging,
        realtime,
        media,
        session: sessionPort
    });
    const director = createBrowserDirectorComposition({
        state,
        messaging,
        realtime,
        rooms,
        session: sessionPort
    });
    const startup = createBrowserStartupComposition({ session, rooms, peopleStats });
    const crdt = createBrowserCrdtComposition({ session, state, messaging });

    return {
        session,
        stateEvents,
        messaging,
        realtime,
        media,
        rooms,
        peopleStats,
        calls,
        director,
        startup,
        crdt
    };
}

function registerBrowserFacadeLifecycle(
    foundation: BrowserRuntimeFoundation,
    state: BrowserStateComposition,
    compositions: BrowserFacadeCompositions
): void {
    registerBrowserStateLifecycle({
        lifecycle: foundation.lifecycle,
        directorController: compositions.director.directorController,
        stateStore: state.stateStore
    });
    registerBrowserTransportLifecycle({
        lifecycle: foundation.lifecycle,
        messageSubscriptions: compositions.messaging.messagesController.subscriptions,
        wsInbox: compositions.stateEvents.wsInbox,
        wsController: compositions.realtime.wsController,
        realtimeReceive: compositions.realtime.realtimeReceive,
        rtcLifecycle: compositions.realtime.rtcController.lifecycle
    });
    registerBrowserMediaLifecycle({
        lifecycle: foundation.lifecycle,
        localMediaSources: compositions.media.localMediaSources,
        remoteMediaStreams: compositions.media.remoteMediaStreams
    });
}
