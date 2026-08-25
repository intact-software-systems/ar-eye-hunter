import { BrowserCallLifecycleRuntime } from '@shared-web/browser/calls/browser-call-lifecycle-runtime.ts';
import { BrowserCallSignalRuntime } from '@shared-web/browser/calls/browser-call-signal-runtime.ts';
import { BrowserDirectorAppointmentRuntime } from '@shared-web/browser/director/browser-director-appointment-runtime.ts';
import { BrowserDirectorRelayRuntime } from '@shared-web/browser/director/browser-director-relay-runtime.ts';
import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import { BrowserDirectorStatusRuntime } from '@shared-web/browser/director/browser-director-status-runtime.ts';
import type { RallarDirectorFacade } from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserRallarPeopleRuntime } from '@shared-web/browser/people/browser-rallar-people-runtime.ts';
import type { RallarPeopleOperations } from '@shared-web/browser/people/rallar-people-contracts.ts';
import type { RallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { createBrowserRallarRooms, type BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import { BrowserRallarStatsRuntime } from '@shared-web/browser/stats/browser-rallar-stats-runtime.ts';
import type { RallarStatsOperations } from '@shared-web/browser/stats/rallar-stats-operations.ts';
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
    readonly people: RallarPeopleOperations;
    readonly stats: RallarStatsOperations;
}

export interface BrowserCallsComposition {
    readonly calls: RallarCallsFacade;
}

export interface BrowserDirectorComposition {
    readonly directorRelays: BrowserDirectorRelayRuntime;
    readonly directorStatus: BrowserDirectorStatusRuntime;
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
    const people = new BrowserRallarPeopleRuntime({
        stateStore: input.state.stateStore,
        stateEvents: input.stateEvents.stateEvents,
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        connect: async (options) => await input.session.connect(options),
        acceptSnapshots: async (snapshotInput) => await input.state.stateStore.acceptSnapshots(snapshotInput)
    });
    const stats = new BrowserRallarStatsRuntime({
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        requireSession: input.session.requireSession,
        runAuthAwareOperation: input.session.runAuthAwareOperation
    });
    return {
        people,
        stats
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
    const directorStatus = new BrowserDirectorStatusRuntime({
        roomStateStore: input.state.roomStateStore,
        readSession,
        resolveDefaultRoom: input.state.resolveDefaultRoom
    });
    const directorAppointments = new BrowserDirectorAppointmentRuntime({
        roomStateStore: input.state.roomStateStore,
        rooms: input.rooms.rooms,
        status: directorStatus,
        requireSession: input.session.requireSession,
        connect: async (options) => await input.session.connect(options),
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveDefaultRoom: input.state.resolveDefaultRoom,
        runAuthAwareOperation: input.session.runAuthAwareOperation,
        acceptSnapshots: async (snapshotInput) => await input.state.stateStore.acceptSnapshots(snapshotInput)
    });
    const relayTransport = new BrowserDirectorRelayTransport({
        messages: input.messaging.messages,
        readSession,
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            input.realtime.realtimeTargeted.create<T>(definition),
        sendWsUnicast: async (sendInput) => await input.messaging.messagesController.sender.sendWsUnicast(sendInput)
    });
    const directorRelays = new BrowserDirectorRelayRuntime({
        status: directorStatus,
        transport: relayTransport,
        messages: input.messaging.messages,
        realtime: input.realtime.realtime,
        readSession
    });
    const director: RallarDirectorFacade = {
        appoint: async (room, options) => await directorAppointments.appoint(room, options),
        resign: async (room, options) => await directorAppointments.resign(room, options),
        status: (room, options) => directorStatus.read(room, options),
        onStatus: (listener) => directorStatus.onStatus(listener),
        createRelay: (config) => directorRelays.create(config)
    };
    input.state.stateStore.onAfterEmit(() => directorStatus.emit());
    return { directorRelays, directorStatus, director };
}
