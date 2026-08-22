import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarAuthFacade } from '@shared-web/browser/rallar-auth-facade.ts';
import type { RallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import type {
    RallarConnectionFacade,
    RallarSetupInput,
    RallarStartResult
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import type { RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type { RallarDirectorFacade } from '@shared-web/browser/rallar-director-facade.ts';
import type { RallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarMessagesFacade } from '@shared-web/browser/rallar-messages-facade.ts';
import type { RallarPeopleFacade } from '@shared-web/browser/rallar-people-facade.ts';
import type {
    RallarRealtimeFacade,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarWsLifecycleListener,
    RallarWsStatus,
    RallarWsStatusListener,
    RallarWsStatusSubscriptionOptions,
    RallarWsWaitForOpenResult
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade, RallarWaitForOpenOptions } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarStatsFacade } from '@shared-web/browser/rallar-stats-facade.ts';
import type { RallarRoomsFacade } from '@shared-web/browser/rooms/rallar-rooms-facade.ts';

export type * from '@shared-web/browser/rallar-auth-facade.ts';
export type * from '@shared-web/browser/rallar-calls-facade.ts';
export type * from '@shared-web/browser/rallar-connection-facade.ts';
export type * from '@shared-web/browser/rallar-director-facade.ts';
export type * from '@shared-web/browser/rallar-media-facade.ts';
export type {
    RallarMessageSelector,
    RallarMessageSelectorInput
} from '@shared-web/browser/rallar-message-selectors.ts';
export type * from '@shared-web/browser/rallar-messages-facade.ts';
export type {
    RallarOperationOptions,
    RallarOperationRetryPredicate
} from '@shared-web/browser/rallar-operation-options.ts';
export type * from '@shared-web/browser/rallar-people-facade.ts';
export type * from '@shared-web/browser/rallar-realtime-facade.ts';
export type * from '@shared-web/browser/rallar-rtc-facade.ts';
export type * from '@shared-web/browser/rallar-shared-contracts.ts';
export type * from '@shared-web/browser/rooms/rallar-room-contracts.ts';
export type * from '@shared-web/browser/rooms/rallar-rooms-facade.ts';

export type RallarFacade =
    & RallarConnectionFacade
    & Readonly<{
        setup(input: RallarSetupInput): Promise<RallarStartResult>;
        data: RallarDataFacade;
        crdt: RallarCrdtFacade;
        auth: RallarAuthFacade;
        rooms: RallarRoomsFacade;
        people: RallarPeopleFacade;
        stats: RallarStatsFacade;
        director: RallarDirectorFacade;
        messages: RallarMessagesFacade;
        channels: Readonly<{
            targeted<T>(definition: RallarTargetedChannelDefinition): RallarTargetedChannel<T>;
            room<T>(definition: Omit<RallarTargetedChannelDefinition, 'peerId' | 'peerIds'>): RallarTargetedChannel<T>;
        }>;
        rtc: RallarRtcFacade;
        calls: RallarCallsFacade;
        ws: Readonly<{
            status(): RallarWsStatus;
            onStatus(
                listener: RallarWsStatusListener,
                options?: RallarWsStatusSubscriptionOptions
            ): import('@shared-web/browser/rallar-shared-contracts.ts').RallarUnsubscribe;
            onLifecycle(
                listener: RallarWsLifecycleListener,
                options?: RallarWsStatusSubscriptionOptions
            ): import('@shared-web/browser/rallar-shared-contracts.ts').RallarUnsubscribe;
            waitForOpen(options?: RallarWaitForOpenOptions): Promise<RallarWsWaitForOpenResult>;
        }>;
        realtime: RallarRealtimeFacade;
        media: RallarMediaFacade;
        advanced: Readonly<{ middleware(): ApiMiddleware; }>;
    }>;
