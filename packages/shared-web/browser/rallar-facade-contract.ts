import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarAuthFacade } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { RallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import type {
    RallarConnectionFacade,
    RallarSetupInput,
    RallarStartResult
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import type { RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type { RallarDirectorFacade } from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type {
    RallarRealtimeFacade,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarWsFacade
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarPeopleOperations } from '@shared-web/browser/people/rallar-people-contracts.ts';
import type { RallarStatsOperations } from '@shared-web/browser/stats/rallar-stats-operations.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';

export type * from '@shared-web/browser/session/rallar-auth-facade.ts';
export type * from '@shared-web/browser/rallar-calls-facade.ts';
export type * from '@shared-web/browser/rallar-connection-facade.ts';
export type * from '@shared-web/browser/director/rallar-director-facade.ts';
export type * from '@shared-web/browser/rallar-media-facade.ts';
export type * from '@shared-web/browser/messages/rallar-message-contracts.ts';
export type {
    RallarMessageSelector,
    RallarMessageSelectorInput
} from '@shared-web/browser/messages/rallar-message-selectors.ts';
export type {
    RallarOperationOptions,
    RallarOperationRetryPredicate
} from '@shared-web/browser/rallar-operation-options.ts';
export type * from '@shared-web/browser/people/rallar-people-contracts.ts';
export type * from '@shared-web/browser/stats/rallar-stats-operations.ts';
export type * from '@shared-web/browser/rallar-realtime-facade.ts';
export type * from '@shared-web/browser/rallar-rtc-facade.ts';
export type * from '@shared-web/browser/rallar-shared-contracts.ts';
export type * from '@shared-web/browser/rooms/rallar-room-contracts.ts';

export interface RallarChannelsFacade {
    targeted<T>(
        definition: RallarTargetedChannelDefinition
    ): RallarTargetedChannel<T>;
    room<T>(
        definition: Omit<RallarTargetedChannelDefinition, 'peerId' | 'peerIds'>
    ): RallarTargetedChannel<T>;
}

export interface RallarAdvancedFacade {
    middleware(): ApiMiddleware;
}

export interface RallarProductFacade {
    setup(input: RallarSetupInput): Promise<RallarStartResult>;
    readonly data: RallarDataFacade;
    readonly crdt: RallarCrdtFacade;
    readonly auth: RallarAuthFacade;
    readonly rooms: BrowserRallarRooms;
    readonly people: RallarPeopleOperations;
    readonly stats: RallarStatsOperations;
    readonly director: RallarDirectorFacade;
    readonly messages: RallarMessagesOperations;
    readonly channels: RallarChannelsFacade;
    readonly rtc: RallarRtcFacade;
    readonly calls: RallarCallsFacade;
    readonly ws: RallarWsFacade;
    readonly realtime: RallarRealtimeFacade;
    readonly media: RallarMediaFacade;
    readonly advanced: RallarAdvancedFacade;
}

export type RallarFacade = RallarConnectionFacade & RallarProductFacade;
