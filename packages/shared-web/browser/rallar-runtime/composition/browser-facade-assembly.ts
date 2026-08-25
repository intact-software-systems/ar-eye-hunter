import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarFacade, RallarTargetedChannelDefinition } from '@shared-web/browser/rallar-facade-contract.ts';
import type { BrowserTargetedRealtimeRuntime } from '@shared-web/browser/realtime/browser-targeted-realtime-runtime.ts';

import type { BrowserMessagingComposition, BrowserRealtimeComposition } from './browser-communication-composition.ts';
import type {
    BrowserCallsDirectorComposition,
    BrowserRoomPeopleStatsComposition
} from './browser-product-composition.ts';
import type { BrowserSessionCoreComposition, BrowserSessionProductComposition } from './browser-session-composition.ts';

export interface CreateBrowserFacadeAssemblyInput {
    readonly session: BrowserSessionCoreComposition;
    readonly sessionProducts: BrowserSessionProductComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeComposition;
    readonly products: BrowserRoomPeopleStatsComposition;
    readonly callsDirector: BrowserCallsDirectorComposition;
}

export function createBrowserFacadeAssembly(input: CreateBrowserFacadeAssemblyInput): RallarFacade {
    const channels = createBrowserFacadeChannels(input.realtime.realtimeTargeted);
    const { connection, session } = input.session;
    return {
        ...connection,
        setup: input.sessionProducts.startup.setup,
        start: input.sessionProducts.startup.start,
        data: input.session.data,
        crdt: input.sessionProducts.crdt,
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
            middleware: (): ApiMiddleware => session.requireMiddleware()
        }
    };
}

function createBrowserFacadeChannels(
    realtimeTargeted: BrowserTargetedRealtimeRuntime
): RallarFacade['channels'] {
    return {
        targeted: <T>(definition: RallarTargetedChannelDefinition) => realtimeTargeted.create<T>(definition),
        room: <T>(definition: Omit<RallarTargetedChannelDefinition, 'peerId' | 'peerIds'>) =>
            realtimeTargeted.create<T>({
                ...definition,
                membership: definition.membership ?? 'live'
            })
    };
}
