import { BrowserCallLifecycleRuntime } from '@shared-web/browser/calls/browser-call-lifecycle-runtime.ts';
import { BrowserCallSignalRuntime } from '@shared-web/browser/calls/browser-call-signal-runtime.ts';
import {
    BrowserRallarDirectorController,
    type RallarDirectorController
} from '@shared-web/browser/director/browser-rallar-director-controller.ts';
import type { RallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarDirectorFacade } from '@shared-web/browser/rallar-director-facade.ts';
import {
    createRallarPeopleController,
    type RallarPeopleController
} from '@shared-web/browser/rallar-runtime/people.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { BrowserRallarStatsController, type RallarStatsController } from '@shared-web/browser/rallar-runtime/stats.ts';
import { createBrowserRallarRooms, type BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import { readSession } from '@shared/api/auth.ts';
import type { RallarTargetedChannelDefinition } from '../../rallar-facade-contract.ts';

import type {
    BrowserMediaComposition,
    BrowserMessagingComposition,
    BrowserRealtimeCoreComposition
} from './browser-communication-composition.ts';
import type { BrowserStateComposition, BrowserStateEventComposition } from './browser-runtime-composition.ts';

export interface BrowserRoomsComposition {
    readonly rooms: BrowserRallarRooms;
}

export interface BrowserPeopleStatsComposition {
    readonly people: RallarPeopleController['operations'];
    readonly stats: RallarStatsController['operations'];
}

export interface BrowserCallsComposition {
    readonly calls: RallarCallsFacade;
}

export interface BrowserDirectorComposition {
    readonly directorController: RallarDirectorController;
    readonly director: RallarDirectorFacade;
}

export interface CreateBrowserRoomsCompositionInput {
    readonly state: BrowserStateComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly session: RallarSessionController;
}

export interface CreateBrowserPeopleStatsCompositionInput {
    readonly state: BrowserStateComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly session: RallarSessionController;
}

export interface CreateBrowserCallsCompositionInput {
    readonly state: BrowserStateComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly media: BrowserMediaComposition;
    readonly session: RallarSessionController;
}

export interface CreateBrowserDirectorCompositionInput {
    readonly state: BrowserStateComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly rooms: BrowserRoomsComposition;
    readonly session: RallarSessionController;
}

export function createBrowserRoomsComposition(
    input: CreateBrowserRoomsCompositionInput
): BrowserRoomsComposition {
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
        acceptSnapshots: async (snapshotInput) => await input.state.stateStore.acceptSnapshots(snapshotInput)
    });
    return { rooms };
}

export function createBrowserPeopleStatsComposition(
    input: CreateBrowserPeopleStatsCompositionInput
): BrowserPeopleStatsComposition {
    const peopleController = createRallarPeopleController({
        stateStore: input.state.stateStore,
        stateEvents: input.stateEvents.stateEvents,
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        connect: async (options) => await input.session.connect(options),
        acceptSnapshots: async (snapshotInput) => await input.state.stateStore.acceptSnapshots(snapshotInput)
    });
    const statsController = new BrowserRallarStatsController({
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        requireSession: input.session.requireSession,
        runAuthAwareOperation: input.session.runAuthAwareOperation
    });
    return {
        people: peopleController.operations,
        stats: statsController.operations
    };
}

export function createBrowserCallsComposition(
    input: CreateBrowserCallsCompositionInput
): BrowserCallsComposition {
    const callLifecycle = new BrowserCallLifecycleRuntime({
        connect: async () => await input.session.connect(),
        readMiddleware: input.session.readMiddleware,
        resolveTargetPeerIds: (target) => input.realtime.realtimeTargeted.resolvePeerIds(target),
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            input.realtime.realtimeTargeted.create<T>(definition),
        rtc: input.realtime.rtc,
        media: input.media.media,
        readSourceStatuses: () => input.media.localMediaSources.readStatuses()
    });
    const callSignals = new BrowserCallSignalRuntime({
        connect: async () => await input.session.connect(),
        readSession,
        requireSession: input.session.requireSession,
        resolveRoomRef: (room) => input.state.roomStateStore.resolveRoomRef(room),
        resolveTargetPeerIds: (target) => input.realtime.realtimeTargeted.resolvePeerIds(target),
        messages: input.messaging.messages,
        readSourceStatus: (kind) => input.media.localMediaSources.readStatus(kind),
        sendWsUnicast: async ({ peerId, payload, typeId, route }) =>
            await input.messaging.messagesController.sender.sendWsUnicast({ peerId, payload, typeId, route }),
        startCall: async (startInput) => await callLifecycle.start(startInput)
    });
    const calls: RallarCallsFacade = {
        start: async (startInput) => await callLifecycle.start(startInput),
        invite: async (inviteInput) => await callSignals.invite(inviteInput),
        onInvite: (listener) => callSignals.onInvite(listener),
        onSignal: (listener) => callSignals.onSignal(listener)
    };
    return { calls };
}

export function createBrowserDirectorComposition(
    input: CreateBrowserDirectorCompositionInput
): BrowserDirectorComposition {
    const directorController = new BrowserRallarDirectorController({
        roomStateStore: input.state.roomStateStore,
        rooms: input.rooms.rooms,
        messages: input.messaging.messages,
        realtime: input.realtime.realtime,
        readSession,
        requireSession: input.session.requireSession,
        connect: async (options) => await input.session.connect(options),
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveDefaultRoom: input.state.resolveDefaultRoom,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        acceptSnapshots: async (snapshotInput) => await input.state.stateStore.acceptSnapshots(snapshotInput),
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            input.realtime.realtimeTargeted.create<T>(definition),
        sendWsUnicast: async (sendInput) =>
            await input.messaging.messagesController.sender.sendWsUnicast(sendInput)
    });
    const director = directorController.operations;
    input.state.stateStore.onAfterEmit(() => directorController.onStateChanged());
    return { directorController, director };
}
