import { createRallarCallsFacade, type RallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import { createRallarDirectorFacade, type RallarDirectorFacade } from '@shared-web/browser/rallar-director-facade.ts';
import { createRallarPeopleFacade, type RallarPeopleFacade } from '@shared-web/browser/rallar-people-facade.ts';
import { createRallarCallsController } from '@shared-web/browser/rallar-runtime/calls.ts';
import {
    createRallarDirectorController,
    type RallarDirectorController
} from '@shared-web/browser/rallar-runtime/director.ts';
import { createRallarPeopleController } from '@shared-web/browser/rallar-runtime/people.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { createRallarStatsController } from '@shared-web/browser/rallar-runtime/stats.ts';
import { createRallarStatsFacade, type RallarStatsFacade } from '@shared-web/browser/rallar-stats-facade.ts';
import { createBrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import { createRallarRoomsFacade, type RallarRoomsFacade } from '@shared-web/browser/rooms/rallar-rooms-facade.ts';
import { readSession } from '@shared/api/auth.ts';
import type { RallarTargetedChannelDefinition } from '../../rallar-facade-contract.ts';

import type { BrowserMessagingComposition, BrowserRealtimeComposition } from './browser-communication-composition.ts';
import type { BrowserStateComposition, BrowserStateEventComposition } from './browser-runtime-composition.ts';

export interface BrowserRoomPeopleStatsComposition {
    readonly rooms: RallarRoomsFacade;
    readonly people: RallarPeopleFacade;
    readonly stats: RallarStatsFacade;
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
    readonly readSessionController: () => RallarSessionController;
}

export interface CreateBrowserCallsDirectorCompositionInput {
    readonly state: BrowserStateComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeComposition;
    readonly products: BrowserRoomPeopleStatsComposition;
    readonly readSessionController: () => RallarSessionController;
}

export function createBrowserRoomPeopleStatsComposition(
    input: CreateBrowserRoomPeopleStatsCompositionInput
): BrowserRoomPeopleStatsComposition {
    const rooms = createRallarRoomsFacade(
        createBrowserRallarRooms({
            stateStore: input.state.roomStateStore,
            roomEvents: input.stateEvents.roomEvents,
            messages: input.messaging.messages,
            realtime: input.realtime.realtime,
            connect: async (options) => await input.readSessionController().connect(options),
            requireSession: () => input.readSessionController().requireSession(),
            resolveOperationOptions: (options) => input.readSessionController().resolveOperationOptions(options),
            resolveOperationScope: (scope) => input.readSessionController().resolveOperationScope(scope),
            resolveDefaultRoom: input.state.resolveDefaultRoom,
            resolveDefaultRoomRef: input.state.resolveDefaultRoomRef,
            runAuthAwareOperation: async (operation) =>
                await input.readSessionController().runAuthAwareOperation(operation),
            acceptSnapshots: async (context, clients, groups, scope) =>
                await input.state.stateStore.acceptSnapshots(context, clients, groups, scope)
        })
    );
    const peopleController = createRallarPeopleController({
        stateStore: input.state.stateStore,
        stateEvents: input.stateEvents.stateEvents,
        resolveOperationOptions: (options) => input.readSessionController().resolveOperationOptions(options),
        resolveOperationScope: (scope) => input.readSessionController().resolveOperationScope(scope),
        runAuthAwareOperation: async (operation) =>
            await input.readSessionController().runAuthAwareOperation(operation),
        connect: async (options) => await input.readSessionController().connect(options),
        acceptSnapshots: async (context, clients, groups, scope) =>
            await input.state.stateStore.acceptSnapshots(context, clients, groups, scope)
    });
    const people = createRallarPeopleFacade(peopleController.operations);
    const statsController = createRallarStatsController({
        resolveOperationOptions: (options) => input.readSessionController().resolveOperationOptions(options),
        resolveOperationScope: (scope) => input.readSessionController().resolveOperationScope(scope),
        requireSession: () => input.readSessionController().requireSession(),
        runAuthAwareOperation: async (operation) => await input.readSessionController().runAuthAwareOperation(operation)
    });
    const stats = createRallarStatsFacade(statsController.operations);
    return {
        rooms,
        people,
        stats
    };
}

export function createBrowserCallsDirectorComposition(
    input: CreateBrowserCallsDirectorCompositionInput
): BrowserCallsDirectorComposition {
    const callsController = createRallarCallsController({
        connect: async () => await input.readSessionController().connect(),
        readMiddleware: () => input.readSessionController().readMiddleware(),
        readSession,
        requireSession: () => input.readSessionController().requireSession(),
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
        requireSession: () => input.readSessionController().requireSession(),
        connect: async (options) => await input.readSessionController().connect(options),
        resolveOperationOptions: (options) => input.readSessionController().resolveOperationOptions(options),
        resolveOperationScope: (scope) => input.readSessionController().resolveOperationScope(scope),
        resolveDefaultRoom: input.state.resolveDefaultRoom,
        runAuthAwareOperation: async (operation) =>
            await input.readSessionController().runAuthAwareOperation(operation),
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
