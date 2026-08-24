import type { RallarAuthFacade } from '@shared-web/browser/rallar-auth-facade.ts';
import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import { createRallarCrdtFacade, type RallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import { createRallarDataFacade, type RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type {
    RallarAuthRuntimePort,
    RallarBrowserFacadeRuntimeContext,
    RallarConnectionRuntimePort
} from '@shared-web/browser/rallar-runtime-context.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import {
    createRallarSessionController,
    type RallarSessionController
} from '@shared-web/browser/rallar-runtime/session.ts';
import {
    createRallarStartupController,
    type RallarStartupController
} from '@shared-web/browser/rallar-runtime/startup.ts';
import {
    createRallarSessionIdentity,
    type RallarSessionIdentity
} from '@shared-web/browser/session/session-identity.ts';
import { readSession } from '@shared/api/auth.ts';

import type { BrowserMessagingComposition } from './browser-communication-composition.ts';
import type { BrowserRoomPeopleStatsComposition } from './browser-product-composition.ts';
import type { BrowserRuntimeFoundation, BrowserStateComposition } from './browser-runtime-composition.ts';

export interface BrowserSessionCoreComposition {
    readonly data: RallarDataFacade;
    readonly identity: RallarSessionIdentity;
    readonly session: RallarSessionController;
    readonly connection: RallarConnectionOperations;
    readonly auth: RallarAuthFacade;
}

export interface BrowserSessionProductComposition {
    readonly startup: RallarStartupController;
    readonly crdt: RallarCrdtFacade;
}

export interface CreateBrowserSessionCoreCompositionInput {
    readonly foundation: BrowserRuntimeFoundation;
    readonly state: BrowserStateComposition;
}

export interface CreateBrowserSessionProductCompositionInput {
    readonly session: BrowserSessionCoreComposition;
    readonly state: BrowserStateComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly products: BrowserRoomPeopleStatsComposition;
}

export function createBrowserSessionCoreComposition(
    input: CreateBrowserSessionCoreCompositionInput
): BrowserSessionCoreComposition {
    const identity = createRallarSessionIdentity({ readSession });
    const data = createRallarDataFacade({ sessionIdentity: identity });
    const session = createRallarSessionController({
        connectionRuntime: input.foundation.connectionRuntime,
        transportRuntime: input.foundation.transportRuntime,
        authRuntime: input.foundation.authRuntime,
        stateRuntime: input.foundation.runtime,
        lifecycle: input.foundation.lifecycle,
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
        auth: session.authOperations
    };
}

export function createBrowserSessionProductComposition(
    input: CreateBrowserSessionProductCompositionInput
): BrowserSessionProductComposition {
    const startup = createRallarStartupController({
        connection: input.session.connection,
        auth: input.session.auth,
        rooms: input.products.rooms,
        people: input.products.people,
        waitForAuthEnd: input.session.session.waitForAuthEnd,
        resolveOperationOptions: input.session.session.resolveOperationOptions
    });
    const crdt = createRallarCrdtFacade({
        data: input.session.data,
        readDefaults: input.state.readDefaults,
        readTransport: () => input.messaging.messagesController.toCrdtMessageTransport()
    });

    return { startup, crdt };
}
