import { createRallarCrdtFacade } from '@shared-web/browser/crdt/create-rallar-crdt-facade.ts';
import type { RallarCrdtFacade } from '@shared-web/browser/crdt/rallar-crdt-contracts.ts';
import type { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import { createRallarDataFacade, type RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type { RallarAuthFacade } from '@shared-web/browser/session/rallar-auth-facade.ts';
import {
    createRallarSessionController,
    type RallarSessionController
} from '@shared-web/browser/session/rallar-session-controller.ts';
import {
    createRallarStartupController,
    type RallarStartupController
} from '@shared-web/browser/session/rallar-startup-controller.ts';
import {
    createRallarSessionIdentity,
    type RallarSessionIdentity
} from '@shared-web/browser/session/session-identity.ts';
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    AL_PUBLICATION_STAGE_LIMITS,
    type ALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import type { ALInboundResyncRequired } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { readSession } from '@shared/api/auth.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';
import type { RtcPublicationProofVerifierPort } from '@shared/multicast/publication/rtc-publication-proof-verifier-port.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';

import type { BrowserMessagingComposition } from './browser-communication-composition.ts';
import type { BrowserPeopleStatsComposition, BrowserRoomsComposition } from './browser-product-composition.ts';
import type { BrowserRuntimeFoundation, BrowserStateComposition } from './browser-runtime-composition.ts';

export interface BrowserSessionCoreComposition {
    readonly data: RallarDataFacade;
    readonly identity: RallarSessionIdentity;
    readonly session: RallarSessionController;
    readonly connection: RallarConnectionOperations;
    readonly auth: RallarAuthFacade;
}

export interface BrowserStartupComposition {
    readonly startup: RallarStartupController;
}

export interface BrowserCrdtComposition {
    readonly crdt: RallarCrdtFacade;
}

/** What a composition root decides for its sessions: the application's QoS inputs and the two limit read ports. */
export interface BrowserSessionQosInputs {
    readonly qosProvider: ALQosInputProvider;
    /** Read once per session initialisation (D74). */
    readonly readVolatileSessionLimits: () => ALVolatileSessionLimits;
    /** Read once per session initialisation (D477). */
    readonly readPublicationStageLimits: () => ALPublicationStageLimits;
}

export interface CreateBrowserSessionCoreCompositionInput extends BrowserSessionQosInputs {
    readonly sessionDeliveries: BrowserSessionDeliveries;
    /** Each connect's inbound runtimes hand their resynchronizations here. */
    readonly onResyncRequired: (resync: ALInboundResyncRequired, storage: ALStorageEventSink) => void;
    readonly foundation: BrowserRuntimeFoundation;
    readonly state: BrowserStateComposition;
    readonly grantedTopics: RtcGrantedTopicReader;
    readonly topicSubscriptions: RtcTopicSubscriptionReader;
    readonly publicationVerifier: RtcPublicationProofVerifierPort;
}

export interface CreateBrowserStartupCompositionInput {
    readonly session: BrowserSessionCoreComposition;
    readonly rooms: BrowserRoomsComposition;
    readonly peopleStats: BrowserPeopleStatsComposition;
}

export interface CreateBrowserCrdtCompositionInput {
    readonly session: BrowserSessionCoreComposition;
    readonly state: BrowserStateComposition;
    readonly messaging: BrowserMessagingComposition;
}

/** The product's inputs: no application QoS, the shipped volatile bound and publication stage limits. */
export function createDefaultBrowserSessionQosInputs(): BrowserSessionQosInputs {
    return {
        qosProvider: {},
        readVolatileSessionLimits: () => AL_VOLATILE_SESSION_LIMITS,
        readPublicationStageLimits: () => AL_PUBLICATION_STAGE_LIMITS
    };
}

export function createBrowserSessionCoreComposition(
    input: CreateBrowserSessionCoreCompositionInput
): BrowserSessionCoreComposition {
    const identity = createRallarSessionIdentity({ readSession });
    const data = createRallarDataFacade({
        manager: defaultRepositoryManager,
        resolveScopeKey: identity.resolveDataScopeKey
    });
    const session = createRallarSessionController({
        qosProvider: input.qosProvider,
        readVolatileSessionLimits: input.readVolatileSessionLimits,
        readPublicationStageLimits: input.readPublicationStageLimits,
        sessionDeliveries: input.sessionDeliveries,
        onResyncRequired: input.onResyncRequired,
        connectionRuntime: input.foundation.connectionRuntime,
        transportRuntime: input.foundation.transportRuntime,
        authRuntime: input.foundation.authRuntime,
        stateRuntime: input.foundation.runtime,
        lifecycle: input.foundation.lifecycle,
        subtle: input.foundation.subtle,
        publicationKeyStore: input.foundation.publicationKeyStore,
        publicationVerifier: input.publicationVerifier,
        grantedTopics: input.grantedTopics,
        topicSubscriptions: input.topicSubscriptions,
        emitState: () => input.state.stateStore.emit(),
        closeDataScopes: async (authSession) => {
            await Promise.all([
                data.closeScope(`session:${authSession.sessionId}`),
                data.closeScope(`principal:${authSession.clientId}`)
            ]);
        }
    });

    return {
        data,
        identity,
        session,
        connection: session.connectionOperations,
        auth: session.auth
    };
}

export function createBrowserStartupComposition(
    input: CreateBrowserStartupCompositionInput
): BrowserStartupComposition {
    const startup = createRallarStartupController({
        connection: input.session.connection,
        auth: input.session.auth,
        rooms: input.rooms.rooms,
        people: input.peopleStats.people,
        waitForAuthEnd: input.session.session.waitForAuthEnd,
        resolveOperationOptions: input.session.session.resolveOperationOptions
    });
    return { startup };
}

export function createBrowserCrdtComposition(
    input: CreateBrowserCrdtCompositionInput
): BrowserCrdtComposition {
    const crdt = createRallarCrdtFacade({
        data: input.session.data,
        readDefaults: input.state.readDefaults,
        readTransport: () => input.messaging.messagesController.crdtTransport
    });
    return { crdt };
}
