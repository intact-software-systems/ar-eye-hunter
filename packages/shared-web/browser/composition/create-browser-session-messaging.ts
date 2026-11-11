import {
    createBrowserMessagingComposition,
    createBrowserResyncRecoveryComposition,
    createDefaultBrowserGrantedTopics,
    createDefaultBrowserTopicSubscriptions,
    createDefaultRtcPublicationProofVerifier,
    readBrowserSessionInboundDiagnostics,
    type BrowserMessagingComposition
} from './browser-communication-composition.ts';
import type { browserDeliveryComposition } from './browser-delivery-composition.ts';
import {
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

export interface BrowserSessionMessagingComposition {
    readonly session: BrowserSessionCoreComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
}

export interface CreateBrowserSessionMessagingInput extends BrowserSessionQosInputs {
    readonly foundation: BrowserRuntimeFoundation;
    readonly state: BrowserStateComposition;
    readonly delivery: typeof browserDeliveryComposition;
}

export function createBrowserSessionMessaging(
    input: CreateBrowserSessionMessagingInput
): BrowserSessionMessagingComposition {
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
