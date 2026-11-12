import {
    createBrowserRealtimeCoreComposition,
    type BrowserMessagingComposition,
    type BrowserRealtimeCoreComposition
} from './browser-communication-composition.ts';
import type { browserDeliveryComposition } from './browser-delivery-composition.ts';
import {
    createBrowserStateComposition,
    type BrowserRuntimeFoundation,
    type BrowserStateComposition,
    type BrowserStateEventComposition
} from './browser-runtime-composition.ts';
import type { BrowserSessionCoreComposition, BrowserSessionQosInputs } from './browser-session-composition.ts';
import { createBrowserSessionMessaging } from './create-browser-session-messaging.ts';

export interface BrowserParticipantCore {
    readonly state: BrowserStateComposition;
    readonly session: BrowserSessionCoreComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
}

export interface CreateBrowserParticipantCoreInput extends BrowserSessionQosInputs {
    readonly foundation: BrowserRuntimeFoundation;
    readonly delivery: typeof browserDeliveryComposition;
}

export function createBrowserParticipantCore(input: CreateBrowserParticipantCoreInput): BrowserParticipantCore {
    const { foundation, delivery } = input;
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const { session, stateEvents, messaging } = createBrowserSessionMessaging({
        foundation,
        state,
        delivery,
        qosProvider: input.qosProvider,
        readVolatileSessionLimits: input.readVolatileSessionLimits,
        readPublicationStageLimits: input.readPublicationStageLimits
    });
    const realtime = createBrowserRealtimeCoreComposition({
        runtime: foundation.runtime,
        transportRuntime: foundation.transportRuntime,
        state,
        session: session.session
    });
    return { state, session, stateEvents, messaging, realtime };
}
