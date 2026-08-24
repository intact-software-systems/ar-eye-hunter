import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';

import {
    createBrowserMessagingComposition,
    createBrowserRealtimeComposition
} from './composition/browser-communication-composition.ts';
import { createBrowserFacadeAssembly } from './composition/browser-facade-assembly.ts';
import {
    registerBrowserStateLifecycle,
    registerBrowserTransportLifecycle
} from './composition/browser-lifecycle-composition.ts';
import {
    createBrowserCallsDirectorComposition,
    createBrowserRoomPeopleStatsComposition
} from './composition/browser-product-composition.ts';
import {
    createBrowserRuntimeFoundation,
    createBrowserStateComposition,
    createBrowserStateEventComposition
} from './composition/browser-runtime-composition.ts';
import {
    createBrowserSessionCoreComposition,
    createBrowserSessionProductComposition
} from './composition/browser-session-composition.ts';

export function createBrowserRallarFacade(): RallarFacade {
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
    registerBrowserStateLifecycle({
        lifecycle: foundation.lifecycle,
        directorController: callsDirector.directorController,
        stateStore: state.stateStore
    });
    registerBrowserTransportLifecycle({
        lifecycle: foundation.lifecycle,
        messagesController: messaging.messagesController,
        wsInbox: stateEvents.wsInbox,
        wsController: realtime.wsController,
        realtimeController: realtime.realtimeController,
        rtcController: realtime.rtcController,
        mediaController: realtime.mediaController
    });
    const sessionProducts = createBrowserSessionProductComposition({
        session,
        state,
        messaging,
        products
    });
    return createBrowserFacadeAssembly({
        session,
        sessionProducts,
        messaging,
        realtime,
        products,
        callsDirector
    });
}
