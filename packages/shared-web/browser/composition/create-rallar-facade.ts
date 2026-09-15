import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import { browserDeliveryComposition } from './browser-delivery-composition.ts';

import {
    createBrowserMediaComposition,
    createBrowserMessagingComposition,
    createBrowserRealtimeCoreComposition,
    type BrowserMediaComposition,
    type BrowserMessagingComposition,
    type BrowserRealtimeCoreComposition
} from './browser-communication-composition.ts';
import { createBrowserFacadeAssembly } from './browser-facade-assembly.ts';
import {
    registerBrowserMediaLifecycle,
    registerBrowserStateLifecycle,
    registerBrowserTransportLifecycle
} from './browser-lifecycle-composition.ts';
import {
    createBrowserCallsComposition,
    createBrowserDirectorComposition,
    createBrowserPeopleStatsComposition,
    createBrowserRoomsComposition,
    type BrowserCallsComposition,
    type BrowserDirectorComposition,
    type BrowserPeopleStatsComposition,
    type BrowserRoomsComposition
} from './browser-product-composition.ts';
import {
    createBrowserRuntimeFoundation,
    createBrowserStateComposition,
    createBrowserStateEventComposition,
    type BrowserRuntimeFoundation,
    type BrowserStateComposition,
    type BrowserStateEventComposition
} from './browser-runtime-composition.ts';
import {
    createBrowserCrdtComposition,
    createBrowserSessionCoreComposition,
    createBrowserStartupComposition,
    type BrowserCrdtComposition,
    type BrowserSessionCoreComposition,
    type BrowserStartupComposition
} from './browser-session-composition.ts';

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
    const delivery = browserDeliveryComposition;
    const compositions = createBrowserFacadeCompositions(foundation, state, delivery);
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
    state: BrowserStateComposition,
    delivery: typeof browserDeliveryComposition
): BrowserFacadeCompositions {
    const { session, stateEvents, messaging } = createBrowserSessionMessaging(foundation, state, delivery);
    const sessionPort = session.session;
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
        startup: createBrowserStartupComposition({ session, rooms, peopleStats }),
        crdt: createBrowserCrdtComposition({ session, state, messaging })
    };
}

function registerBrowserFacadeLifecycle(
    foundation: BrowserRuntimeFoundation,
    state: BrowserStateComposition,
    compositions: BrowserFacadeCompositions
): void {
    registerBrowserStateLifecycle({
        lifecycle: foundation.lifecycle,
        directorRelays: compositions.director.directorRelays,
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

function createBrowserSessionMessaging(
    foundation: BrowserRuntimeFoundation,
    state: BrowserStateComposition,
    delivery: typeof browserDeliveryComposition
): Pick<BrowserFacadeCompositions, 'session' | 'stateEvents' | 'messaging'> {
    const { nowMs, deliveries, sessionDeliveries } = delivery;
    const session = createBrowserSessionCoreComposition({ foundation, state, sessionDeliveries });
    const sessionPort = session.session;
    const stateEvents = createBrowserStateEventComposition({
        connectionRuntime: foundation.connectionRuntime,
        session: sessionPort
    });
    const messaging = createBrowserMessagingComposition({
        wsInbox: stateEvents.wsInbox,
        deliveries,
        sessionDeliveries,
        nowMs,
        state,
        session: sessionPort
    });
    return { session, stateEvents, messaging };
}
