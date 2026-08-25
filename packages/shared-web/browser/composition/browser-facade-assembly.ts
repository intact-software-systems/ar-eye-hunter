import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarFacade, RallarTargetedChannelDefinition } from '@shared-web/browser/rallar-facade-contract.ts';
import type { BrowserTargetedRealtimeRuntime } from '@shared-web/browser/realtime/browser-targeted-realtime-runtime.ts';

import type {
    BrowserMediaComposition,
    BrowserMessagingComposition,
    BrowserRealtimeCoreComposition
} from './browser-communication-composition.ts';
import type {
    BrowserCallsComposition,
    BrowserDirectorComposition,
    BrowserPeopleStatsComposition,
    BrowserRoomsComposition
} from './browser-product-composition.ts';
import type {
    BrowserCrdtComposition,
    BrowserSessionCoreComposition,
    BrowserStartupComposition
} from './browser-session-composition.ts';

/** Completed feature capabilities needed to expose the aggregate browser facade. */
export interface CreateBrowserFacadeAssemblyInput {
    readonly session: BrowserSessionCoreComposition;
    readonly startup: BrowserStartupComposition;
    readonly crdt: BrowserCrdtComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly media: BrowserMediaComposition;
    readonly rooms: BrowserRoomsComposition;
    readonly peopleStats: BrowserPeopleStatsComposition;
    readonly calls: BrowserCallsComposition;
    readonly director: BrowserDirectorComposition;
}

export function createBrowserFacadeAssembly(input: CreateBrowserFacadeAssemblyInput): RallarFacade {
    const channels = createBrowserFacadeChannels(input.realtime.realtimeTargeted);
    const { connection, session } = input.session;
    return {
        ...connection,
        setup: input.startup.startup.setup,
        start: input.startup.startup.start,
        data: input.session.data,
        crdt: input.crdt.crdt,
        auth: input.session.auth,
        rooms: input.rooms.rooms,
        people: input.peopleStats.people,
        stats: input.peopleStats.stats,
        director: input.director.director,
        messages: input.messaging.messages,
        channels,
        rtc: input.realtime.rtc,
        calls: input.calls.calls,
        ws: input.realtime.wsController.facade,
        realtime: input.realtime.realtime,
        media: input.media.media,
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
