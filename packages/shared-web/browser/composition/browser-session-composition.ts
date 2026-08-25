import type {
    RallarAuthRuntimePort,
    RallarBrowserFacadeRuntimeContext,
    RallarConnectionRuntimePort
} from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import { createRallarCrdtFacade, type RallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import { createRallarDataFacade, type RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type { RallarAuthFacade } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { RallarLifecycleCoordinator } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
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
import { readSession } from '@shared/api/auth.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';

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

export interface CreateBrowserSessionCoreCompositionInput {
    readonly foundation: BrowserRuntimeFoundation;
    readonly state: BrowserStateComposition;
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

export function createBrowserSessionCoreComposition(
    input: CreateBrowserSessionCoreCompositionInput
): BrowserSessionCoreComposition {
    const identity = createRallarSessionIdentity({ readSession });
    const data = createRallarDataFacade({
        manager: defaultRepositoryManager,
        resolveScopeKey: identity.resolveDataScopeKey
    });
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
