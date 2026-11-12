import {
    createBrowserMessagingComposition,
    createBrowserRealtimeCoreComposition,
    createBrowserResyncRecoveryComposition,
    createDefaultBrowserGrantedTopics,
    createDefaultBrowserTopicSubscriptions,
    createDefaultRtcPublicationProofVerifier,
    readBrowserSessionInboundDiagnostics,
    type BrowserMessagingComposition,
    type BrowserRealtimeCoreComposition
} from './browser-communication-composition.ts';
import type { browserDeliveryComposition } from './browser-delivery-composition.ts';
import {
    createBrowserStateComposition,
    createBrowserStateEventComposition,
    type BrowserRuntimeFoundation,
    type BrowserStateComposition,
    type BrowserStateEventComposition
} from './browser-runtime-composition.ts';
import {
    createBrowserSessionCoreComposition,
    type BrowserSessionCoreComposition,
    type BrowserSessionQosInputs
} from './browser-session-composition.ts';

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

interface CreateBrowserParticipantSessionMessagingInput extends CreateBrowserParticipantCoreInput {
    readonly state: BrowserStateComposition;
}

export function createBrowserParticipantCore(input: CreateBrowserParticipantCoreInput): BrowserParticipantCore {
    const { foundation } = input;
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const { session, stateEvents, messaging } = createBrowserParticipantSessionMessaging({ ...input, state });
    const realtime = createBrowserRealtimeCoreComposition({
        runtime: foundation.runtime,
        transportRuntime: foundation.transportRuntime,
        state,
        session: session.session
    });
    return { state, session, stateEvents, messaging, realtime };
}

function createBrowserParticipantSessionMessaging(
    input: CreateBrowserParticipantSessionMessagingInput
): Pick<BrowserParticipantCore, 'session' | 'stateEvents' | 'messaging'> {
    const { foundation, state, delivery } = input;
    const { nowMs, publicationStages, deliveries, sessionDeliveries } = delivery;
    const recovery = createBrowserResyncRecoveryComposition({ nowMs });
    const grantedTopics = createDefaultBrowserGrantedTopics(state);
    const topicSubscriptions = createDefaultBrowserTopicSubscriptions();
    const publicationVerifier = createDefaultRtcPublicationProofVerifier(foundation, state);
    const session = createBrowserSessionCoreComposition({
        foundation,
        state,
        grantedTopics,
        topicSubscriptions,
        publicationVerifier,
        sessionDeliveries,
        qosProvider: input.qosProvider,
        readVolatileSessionLimits: input.readVolatileSessionLimits,
        readPublicationStageLimits: input.readPublicationStageLimits,
        onResyncRequired: (resync, storage) => recovery.resyncRecovery.onResyncRequired(resync, storage)
    });
    const sessionPort = session.session;
    const stateEvents = createBrowserStateEventComposition({
        connectionRuntime: foundation.connectionRuntime,
        session: sessionPort
    });
    const messaging = createBrowserMessagingComposition({
        wsInbox: stateEvents.wsInbox,
        deliveries,
        sessionDeliveries,
        publicationStages,
        nowMs,
        recoveryOwners: recovery.recoveryOwners,
        state,
        session: sessionPort,
        grantedTopics,
        topicSubscriptions,
        readInboundDiagnostics: () => readBrowserSessionInboundDiagnostics(foundation)
    });
    return { session, stateEvents, messaging };
}
