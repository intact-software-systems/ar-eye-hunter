import {
  createRallarAuthFacade,
  type RallarAuthFacade,
} from '@shared-web/browser/rallar-auth-facade.ts';
import {
  createRallarConnectionFacade,
  type RallarConnectionFacade,
} from '@shared-web/browser/rallar-connection-facade.ts';
import { createRallarCrdtFacade, type RallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import { createRallarDataFacade, type RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type {
  RallarAuthRuntimePort,
  RallarConnectionRuntimePort,
  RallarLifecycleCoordinator,
  RallarStatePort,
  RallarStateRuntimePort,
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import {
  createRallarSessionController,
  type RallarSessionController,
} from '@shared-web/browser/rallar-runtime/session.ts';
import {
  createRallarStartupController,
  type RallarStartupController,
} from '@shared-web/browser/rallar-runtime/startup.ts';

import type { BrowserMessagingComposition } from './browser-communication-composition.ts';
import type { BrowserRoomPeopleStatsComposition } from './browser-product-composition.ts';
import type { BrowserStateComposition } from './browser-runtime-composition.ts';

export interface BrowserSessionComposition {
  readonly data: RallarDataFacade;
  readonly sessionController: RallarSessionController;
  readonly connection: RallarConnectionFacade;
  readonly auth: RallarAuthFacade;
  readonly startupController: RallarStartupController;
  readonly crdt: RallarCrdtFacade;
}

export interface CreateBrowserSessionCompositionInput {
  readonly connectionRuntime: RallarConnectionRuntimePort;
  readonly authRuntime: RallarAuthRuntimePort;
  readonly stateRuntime: RallarStateRuntimePort;
  readonly lifecycle: RallarLifecycleCoordinator;
  readonly state: BrowserStateComposition;
  readonly messaging: BrowserMessagingComposition;
  readonly products: BrowserRoomPeopleStatsComposition;
  readonly bindSessionController: (sessionController: RallarSessionController) => void;
}

export function createBrowserSessionComposition(
  input: CreateBrowserSessionCompositionInput,
): BrowserSessionComposition {
  let sessionController!: RallarSessionController;
  let startupController!: RallarStartupController;
  const data = createRallarDataFacade({
    resolveScopeKey: (scope) => sessionController.resolveDataScopeKey(String(scope)),
  });
  sessionController = createRallarSessionController({
    connectionRuntime: input.connectionRuntime,
    authRuntime: input.authRuntime,
    stateRuntime: input.stateRuntime,
    lifecycle: input.lifecycle,
    start: async (options) => await startupController.start(options),
    emitState: () => input.state.stateStore.emit(),
    closeDataScopes: async (session) => {
      await Promise.all([
        data.closeScope(`session:${session.sessionId}`),
        data.closeScope(`principal:${session.clientId}`),
      ]);
    },
  });
  input.bindSessionController(sessionController);
  const connection = createRallarConnectionFacade(sessionController.connectionOperations);
  const auth = createRallarAuthFacade(sessionController.authOperations);
  startupController = createRallarStartupController({
    connection,
    auth,
    rooms: input.products.rooms,
    people: input.products.people,
    waitForAuthEnd: () => sessionController.waitForAuthEnd(),
    resolveOperationOptions: (options) => sessionController.resolveOperationOptions(options),
  });
  const crdt = createRallarCrdtFacade({
    data,
    readDefaults: input.state.readDefaults,
    readTransport: () => input.messaging.messagesController.toCrdtMessageTransport(),
  });
  return { data, sessionController, connection, auth, startupController, crdt };
}
