import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';

import {
    createBrowserMessagingComposition,
    createBrowserRealtimeComposition,
    type BrowserMessagingComposition,
    type BrowserRealtimeComposition
} from './composition/browser-communication-composition.ts';
import { createBrowserFacadeAssembly } from './composition/browser-facade-assembly.ts';
import {
    registerBrowserMediaLifecycle,
    registerBrowserStateLifecycle,
    registerBrowserTransportLifecycle
} from './composition/browser-lifecycle-composition.ts';
import {
    createBrowserCallsDirectorComposition,
    createBrowserRoomPeopleStatsComposition,
    type BrowserCallsDirectorComposition,
    type BrowserRoomPeopleStatsComposition
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
    createBrowserSessionCoreComposition,
    createBrowserSessionProductComposition,
    type BrowserSessionCoreComposition
} from './composition/browser-session-composition.ts';

interface BrowserFacadeCompositions {
    readonly session: BrowserSessionCoreComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeComposition;
    readonly products: BrowserRoomPeopleStatsComposition;
    readonly callsDirector: BrowserCallsDirectorComposition;
}

export function createBrowserRallarFacade(): RallarFacade {
    const foundation = createBrowserRuntimeFoundation();
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const compositions = createBrowserFacadeCompositions(foundation, state);
    registerBrowserFacadeLifecycle(foundation, state, compositions);
    const sessionProducts = createBrowserSessionProductComposition({
        session: compositions.session,
        state,
        messaging: compositions.messaging,
        products: compositions.products
    });
    return createBrowserFacadeAssembly({
        session: compositions.session,
        sessionProducts,
        messaging: compositions.messaging,
        realtime: compositions.realtime,
        products: compositions.products,
        callsDirector: compositions.callsDirector
    });
}

function createBrowserFacadeCompositions(
    foundation: BrowserRuntimeFoundation,
    state: BrowserStateComposition
): BrowserFacadeCompositions {
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
    const realtime = createBrowserRealtimeComposition({
        runtime: foundation.runtime,
        state,
        session: session.session
    });
    const products = createBrowserRoomPeopleStatsComposition({
        state,
        stateEvents,
        messaging,
        realtime,
        session: session.session
    });
    const callsDirector = createBrowserCallsDirectorComposition({
        state,
        messaging,
        realtime,
        products,
        session: session.session
    });

    return {
        session,
        stateEvents,
        messaging,
        realtime,
        products,
        callsDirector
    };
}

function registerBrowserFacadeLifecycle(
    foundation: BrowserRuntimeFoundation,
    state: BrowserStateComposition,
    compositions: BrowserFacadeCompositions
): void {
    registerBrowserStateLifecycle({
        lifecycle: foundation.lifecycle,
        directorController: compositions.callsDirector.directorController,
        stateStore: state.stateStore
    });
    registerBrowserTransportLifecycle({
        lifecycle: foundation.lifecycle,
        messagesController: compositions.messaging.messagesController,
        wsInbox: compositions.stateEvents.wsInbox,
        wsController: compositions.realtime.wsController,
        realtimeReceive: compositions.realtime.realtimeReceive,
        rtcController: compositions.realtime.rtcController
    });
    registerBrowserMediaLifecycle({
        lifecycle: foundation.lifecycle,
        mediaController: compositions.realtime.mediaController
    });
}
