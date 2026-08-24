import { createRallarCallsFacade, type RallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import { createRallarDirectorFacade, type RallarDirectorFacade } from '@shared-web/browser/rallar-director-facade.ts';
import { createRallarCallsController } from '@shared-web/browser/rallar-runtime/calls.ts';
import {
    createRallarDirectorController,
    type RallarDirectorController
} from '@shared-web/browser/rallar-runtime/director.ts';
import {
    createRallarPeopleController,
    type RallarPeopleController
} from '@shared-web/browser/rallar-runtime/people.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { createRallarStatsController, type RallarStatsController } from '@shared-web/browser/rallar-runtime/stats.ts';
import { createBrowserRallarRooms, type BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import { readSession } from '@shared/api/auth.ts';
import type { RallarTargetedChannelDefinition } from '../../rallar-facade-contract.ts';

import type { BrowserMessagingComposition, BrowserRealtimeComposition } from './browser-communication-composition.ts';
import type { BrowserStateComposition, BrowserStateEventComposition } from './browser-runtime-composition.ts';

export interface BrowserRoomPeopleStatsComposition {
    readonly rooms: BrowserRallarRooms;
    readonly people: RallarPeopleController['operations'];
    readonly stats: RallarStatsController['operations'];
}

export interface BrowserCallsDirectorComposition {
    readonly calls: RallarCallsFacade;
    readonly directorController: RallarDirectorController;
    readonly director: RallarDirectorFacade;
}

export interface CreateBrowserRoomPeopleStatsCompositionInput {
    readonly state: BrowserStateComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeComposition;
    readonly session: RallarSessionController;
}

export interface CreateBrowserCallsDirectorCompositionInput {
    readonly state: BrowserStateComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeComposition;
    readonly products: BrowserRoomPeopleStatsComposition;
    readonly session: RallarSessionController;
}

export function createBrowserRoomPeopleStatsComposition(
    input: CreateBrowserRoomPeopleStatsCompositionInput
): BrowserRoomPeopleStatsComposition {
    const rooms = createBrowserRallarRooms({
        stateStore: input.state.roomStateStore,
        roomEvents: input.stateEvents.roomEvents,
        messages: input.messaging.messages,
        realtime: input.realtime.realtime,
        connect: async (options) => await input.session.connect(options),
        requireSession: input.session.requireSession,
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        resolveDefaultRoom: input.state.resolveDefaultRoom,
        resolveDefaultRoomRef: input.state.resolveDefaultRoomRef,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        acceptSnapshots: async (context, clients, groups, scope) =>
            await input.state.stateStore.acceptSnapshots(context, clients, groups, scope)
    });
    const peopleController = createRallarPeopleController({
        stateStore: input.state.stateStore,
        stateEvents: input.stateEvents.stateEvents,
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        connect: async (options) => await input.session.connect(options),
        acceptSnapshots: async (context, clients, groups, scope) =>
            await input.state.stateStore.acceptSnapshots(context, clients, groups, scope)
    });
    const statsController = createRallarStatsController({
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        requireSession: input.session.requireSession,
        runAuthAwareOperation: input.session.runAuthAwareOperation
    });
    return {
        rooms,
        people: peopleController.operations,
        stats: statsController.operations
    };
}

export function createBrowserCallsDirectorComposition(
    input: CreateBrowserCallsDirectorCompositionInput
): BrowserCallsDirectorComposition {
    const callsController = createRallarCallsController({
        connect: async () => await input.session.connect(),
        readMiddleware: input.session.readMiddleware,
        readSession,
        requireSession: input.session.requireSession,
        resolveRoomRef: (room) => input.state.roomStateStore.resolveRoomRef(room),
        resolveTargetPeerIds: (target) => input.realtime.realtimeController.resolveTargetPeerIds(target),
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            input.realtime.realtimeController.createTargetedChannel<T>(definition),
        messages: input.messaging.messages,
        rtc: input.realtime.rtc,
        media: input.realtime.media,
        mediaController: input.realtime.mediaController,
        sendWsUnicast: async (peerId, payload, typeId, route) =>
            await input.messaging.messagesController.sendWsUnicast(peerId, payload, typeId, route)
    });
    const calls = createRallarCallsFacade(callsController.operations);
    const directorController = createRallarDirectorController({
        stateStore: input.state.stateStore,
        rooms: input.products.rooms,
        messages: input.messaging.messages,
        realtime: input.realtime.realtime,
        readSession,
        requireSession: input.session.requireSession,
        connect: async (options) => await input.session.connect(options),
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        resolveDefaultRoom: input.state.resolveDefaultRoom,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        acceptSnapshots: async (context, groups, scope) =>
            await input.state.stateStore.acceptSnapshots(context, [], groups, scope),
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            input.realtime.realtimeController.createTargetedChannel<T>(definition),
        sendWsUnicast: async (peerId, payload, typeId, route) =>
            await input.messaging.messagesController.sendWsUnicast(peerId, payload, typeId, route)
    });
    const director = createRallarDirectorFacade(directorController.operations);
    input.state.stateStore.onAfterEmit(() => directorController.onStateChanged());
    return { calls, directorController, director };
}
