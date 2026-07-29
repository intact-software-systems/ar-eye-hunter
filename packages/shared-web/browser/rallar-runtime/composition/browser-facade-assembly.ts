import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
  RallarFacade,
  RallarTargetedChannelDefinition,
} from '@shared-web/browser/rallar-facade-contract.ts';
import type { RallarRealtimeController } from '@shared-web/browser/rallar-runtime/realtime.ts';

import type {
  BrowserMessagingComposition,
  BrowserRealtimeComposition,
} from './browser-communication-composition.ts';
import type {
  BrowserCallsDirectorComposition,
  BrowserRoomPeopleStatsComposition,
} from './browser-product-composition.ts';
import type { BrowserSessionComposition } from './browser-session-composition.ts';

export interface CreateBrowserFacadeAssemblyInput {
  readonly session: BrowserSessionComposition;
  readonly messaging: BrowserMessagingComposition;
  readonly realtime: BrowserRealtimeComposition;
  readonly products: BrowserRoomPeopleStatsComposition;
  readonly callsDirector: BrowserCallsDirectorComposition;
}

export function createBrowserFacadeAssembly(input: CreateBrowserFacadeAssemblyInput): RallarFacade {
  const channels = createBrowserFacadeChannels(input.realtime.realtimeController);
  const { sessionController, connection, startupController } = input.session;
  return {
    configure: (config) => connection.configure(config),
    setDefaults: (defaults) => connection.setDefaults(defaults),
    defaults: () => connection.defaults(),
    setup: async (setupInput) => await startupController.setup(setupInput),
    connect: async (options) => await connection.connect(options),
    start: async (options) => await startupController.start(options),
    disconnect: async () => await connection.disconnect(),
    status: () => connection.status(),
    isConnected: () => connection.isConnected(),
    session: () => connection.session(),
    subscriptions: () => connection.subscriptions(),
    flow: <K, V>(policies = {}) => connection.flow<K, V>(policies),
    data: input.session.data,
    crdt: input.session.crdt,
    auth: input.session.auth,
    rooms: input.products.rooms,
    people: input.products.people,
    stats: input.products.stats,
    director: input.callsDirector.director,
    messages: input.messaging.messages,
    channels,
    rtc: input.realtime.rtc,
    calls: input.callsDirector.calls,
    ws: input.realtime.wsController.facade,
    realtime: input.realtime.realtime,
    media: input.realtime.media,
    advanced: {
      middleware: (): ApiMiddleware => sessionController.requireMiddleware(),
    },
  };
}

function createBrowserFacadeChannels(
  realtimeController: RallarRealtimeController,
): RallarFacade['channels'] {
  return {
    targeted: <T>(definition: RallarTargetedChannelDefinition) =>
      realtimeController.createTargetedChannel<T>(definition),
    room: <T>(definition: Omit<RallarTargetedChannelDefinition, 'peerId' | 'peerIds'>) =>
      realtimeController.createTargetedChannel<T>({
        ...definition,
        membership: definition.membership ?? 'live',
      }),
  };
}
