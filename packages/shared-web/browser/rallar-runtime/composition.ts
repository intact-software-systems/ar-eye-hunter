import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';

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
import { createBrowserSessionComposition } from './composition/browser-session-composition.ts';

export function createBrowserRallarFacade(): RallarFacade {
    const foundation = createBrowserRuntimeFoundation();
    let sessionController!: RallarSessionController;
    const readSessionController = () => sessionController;
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const stateEvents = createBrowserStateEventComposition({ readSessionController });
    const messaging = createBrowserMessagingComposition({
        wsInbox: stateEvents.wsInbox,
        state,
        readSessionController
    });
    const realtime = createBrowserRealtimeComposition({
        runtime: foundation.runtime,
        state,
        readSessionController
    });
    const products = createBrowserRoomPeopleStatsComposition({
        state,
        stateEvents,
        messaging,
        realtime,
        readSessionController
    });
    const callsDirector = createBrowserCallsDirectorComposition({
        state,
        messaging,
        realtime,
        products,
        readSessionController
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
    const session = createBrowserSessionComposition({
        connectionRuntime: foundation.connectionRuntime,
        authRuntime: foundation.authRuntime,
        stateRuntime: foundation.stateRuntime,
        lifecycle: foundation.lifecycle,
        state,
        messaging,
        products,
        bindSessionController: (controller) => (sessionController = controller)
    });
    return createBrowserFacadeAssembly({ session, messaging, realtime, products, callsDirector });
}
