import { resolveBrowserRtcOverlayALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    createBrowserMessagingComposition,
    createBrowserRealtimeCoreComposition,
    createBrowserResyncRecoveryComposition,
    type BrowserMessagingComposition,
    type BrowserRealtimeCoreComposition
} from '@shared-web/browser/composition/browser-communication-composition.ts';
import { browserDeliveryComposition } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import {
    registerBrowserStateLifecycle,
    registerBrowserTransportLifecycle
} from '@shared-web/browser/composition/browser-lifecycle-composition.ts';
import {
    createBrowserDirectorComposition,
    createBrowserRoomsComposition,
    type BrowserDirectorComposition,
    type BrowserRoomsComposition
} from '@shared-web/browser/composition/browser-product-composition.ts';
import {
    createBrowserRuntimeFoundation,
    createBrowserStateComposition,
    createBrowserStateEventComposition,
    type BrowserRuntimeFoundation,
    type BrowserStateComposition,
    type BrowserStateEventComposition
} from '@shared-web/browser/composition/browser-runtime-composition.ts';
import {
    createBrowserCrdtComposition,
    createBrowserSessionCoreComposition,
    type BrowserCrdtComposition,
    type BrowserSessionCoreComposition
} from '@shared-web/browser/composition/browser-session-composition.ts';
import type { BrowserRallarCrdtFacade } from '@shared-web/browser/crdt/create-rallar-crdt-facade.ts';
import type {
    RallarDirectorFacade,
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type {
    RallarConnectionOperations
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarAuthFacade } from '@shared-web/browser/rallar-core.ts';
import type {
    RallarRealtimeFacade,
    RallarWsFacade
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomFormation } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import type { RoomSendFence } from '@shared-web/browser/rooms/room-state-store.ts';
import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALVolatileSessionLimits } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { resolveRallarGroupLeaderSessionId } from '@shared/api/group-director.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    createScriptedStorageFaultPort,
    type ScriptedStorageFaultPort
} from '@shared/persistence/storage-fault-port.ts';
import {
    createScriptedTransportFaultPort,
    type ScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type {
    BlackBoxRallarControlSubmitInput,
    BlackBoxRallarDirectorOutputRecord,
    BlackBoxRallarEvent
} from './black-box-rallar-operation-contracts.ts';
import { computeAlmConformanceQosDefaults } from './messaging/compute-alm-conformance-qos-defaults.ts';
import {
    replayBlackBoxCapturedMessage,
    type BlackBoxCapturedMessageReplay
} from './messaging/replay-black-box-captured-message.ts';
import { submitBlackBoxRawControl, type SubmitBlackBoxRawControl } from './messaging/submit-black-box-raw-control.ts';
import {
    refreshBlackBoxBrowserRoomState,
    type BlackBoxRoomStateRefreshOptions
} from './refresh-black-box-browser-room-state.ts';

export namespace BlackBoxBrowserRallarRuntimeDependency {
    export interface ConnectCompletion {
        readonly rtcCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>;
        captureOwnershipFailure(): ReturnType<BrowserSessionDeliveries['captureOwnershipFailure']>;
    }
}

// The runner awaits these effects but deliberately does not expose browser middleware or room handles.
export interface BlackBoxBrowserRallarRuntimeDependency
    extends
        Pick<
            RallarConnectionOperations,
            'configure' | 'setDefaults' | 'status' | 'isConnected' | 'session' | 'rtcCapture'
        > {
    connect(
        options?: Parameters<RallarConnectionOperations['connect']>[0]
    ): Promise<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion>;
    disconnect(): Promise<void>;
    refreshRoomState(
        roomRef: GroupRef,
        options: BlackBoxRoomStateRefreshOptions
    ): Promise<void>;
    readRtcMessageNacks(messageId: string): Promise<readonly ALNackPayload[]>;
    readonly auth: BlackBoxBrowserAuthDependency;
    readonly rooms: BlackBoxBrowserRoomsDependency;
    readonly messages: BlackBoxBrowserMessagesDependency;
    readonly realtime: BlackBoxBrowserRealtimeDependency;
    readonly ws: BlackBoxBrowserWsDependency;
    readonly rtc: BlackBoxBrowserRtcDependency;
    readonly crdt: BlackBoxBrowserCrdtDependency;
    readonly director: BlackBoxBrowserDirectorDependency;
    readonly diagnostics: BlackBoxBrowserDiagnosticsDependency;
    readonly deliveries: BlackBoxBrowserDeliveriesDependency;
    readonly peers: BlackBoxBrowserPeersDependency;
}

export interface BlackBoxBrowserAuthDependency
    extends Pick<RallarAuthFacade, 'login' | 'registerAndLogin' | 'logout' | 'restore'> {}

export interface BlackBoxBrowserRoomsDependency {
    join(
        room: Parameters<BrowserRallarRooms['join']>[0],
        options?: Parameters<BrowserRallarRooms['join']>[1]
    ): Promise<void>;
    leave(input?: Parameters<BrowserRallarRooms['leave']>[0]): Promise<void>;
    refresh(input?: Parameters<BrowserRallarRooms['refresh']>[0]): Promise<void>;
    formation(
        room: Parameters<BrowserRallarRooms['formation']>[0]
    ): RallarRoomFormation;
}

export interface BlackBoxBrowserMessagesDependency extends Pick<RallarMessagesOperations, 'room' | 'rtc' | 'ws'> {}

/** The session registry that the facade senders open handles in, so the ledger holds none of its own. */
export interface BlackBoxBrowserDeliveriesDependency extends Pick<BrowserRallarDeliveryRegistry, 'getHandle'> {
    replayCapturedMessage(replay: BlackBoxCapturedMessageReplay): Promise<ALDeliveryAdmissionVerdict>;
    submitRawControl(control: BlackBoxRallarControlSubmitInput): Promise<SubmitBlackBoxRawControl.Submission>;
    /** The fence the product stamps on a room send that states no floor: the sender's cached room and roster versions. */
    resolveRoomSendFence(roomRef: GroupRef): RoomSendFence;
}

/** What the page reads to name a peer by its lane role: the WS server's id, its own session and the room's roster. */
export interface BlackBoxBrowserPeersDependency extends Pick<RallarConnectionOperations, 'serverPeerId' | 'session'> {
    /** Undefined while the page holds no snapshot of the room. */
    getRoomSessions(roomRef: GroupRef): readonly GroupPresenceSession[] | undefined;
    /** Undefined while the page holds no snapshot of the room, or the room has no active director. */
    getRoomLeaderSessionId(roomRef: GroupRef): string | undefined;
}

/** The scripted ports the runtime hands the browser facade and reads back for fault and storage commands. */
export interface BlackBoxBrowserDiagnosticsDependency {
    readonly faults: ScriptedTransportFaultPort;
    readonly storage: CountingIndexedDbOperationObserver;
    /** Decides each IndexedDB operation after `storage` has counted it. */
    readonly storageFaults: ScriptedStorageFaultPort;
}

export interface BlackBoxBrowserRealtimeDependency
    extends Pick<RallarRealtimeFacade, 'sendJson' | 'onJson' | 'health'> {}

export interface BlackBoxBrowserWsDependency extends Pick<RallarWsFacade, 'status' | 'onLifecycle'> {}

export interface BlackBoxBrowserRtcDependency extends
    Pick<
        RallarRtcFacade,
        | 'status'
        | 'diagnostics'
        | 'onLifecycle'
        | 'roomStatus'
        | 'waitForRoom'
        | 'onStatus'
    > {}

export interface BlackBoxBrowserCrdtDependency extends Pick<BrowserRallarCrdtFacade, 'open'> {}

export interface BlackBoxBrowserDirectorDependency extends Pick<RallarDirectorFacade, 'appoint' | 'resign' | 'status'> {
    createRelay(
        config: RallarDirectorRelayConfig<
            BlackBoxRallarEvent['data'],
            BlackBoxRallarDirectorOutputRecord,
            BlackBoxRallarEvent['data']
        >
    ): RallarDirectorRelayHandle<
        BlackBoxRallarEvent['data'],
        BlackBoxRallarDirectorOutputRecord,
        BlackBoxRallarEvent['data']
    >;
}

export interface CreateBlackBoxBrowserRallarRuntimeDependencyInput {
    /** Read once per session initialisation (D74); a connect sets what it returns before it connects. */
    readonly readVolatileSessionLimits: () => ALVolatileSessionLimits;
}

export function createBlackBoxBrowserRallarRuntimeDependency(
    input: CreateBlackBoxBrowserRallarRuntimeDependencyInput
): BlackBoxBrowserRallarRuntimeDependency {
    const faults = createScriptedTransportFaultPort();
    const storage = createCountingIndexedDbOperationObserver();
    const storageFaults = createScriptedStorageFaultPort();
    const { foundation, state, session, stateEvents, messaging, realtime } = createBlackBoxBrowserTransportComposition(
        input.readVolatileSessionLimits
    );
    const rooms = createBrowserRoomsComposition({
        state,
        stateEvents,
        messaging,
        realtime,
        session: session.session
    });
    const director = createBrowserDirectorComposition({
        state,
        messaging,
        session: session.session
    });
    registerBlackBoxBrowserRallarLifecycle({
        foundation,
        state,
        stateEvents,
        messaging,
        realtime,
        director
    });
    const crdt = createBrowserCrdtComposition({
        session,
        state,
        messaging
    });
    return toBlackBoxBrowserRuntimeDependency({
        session,
        rooms,
        messaging,
        realtime,
        crdt,
        director,
        diagnostics: { faults, storage, storageFaults },
        ...toBlackBoxBrowserMessagingPorts({ session, state })
    });
}

interface BlackBoxBrowserMessagingPortsInput {
    readonly session: BrowserSessionCoreComposition;
    readonly state: BrowserStateComposition;
}

function toBlackBoxBrowserMessagingPorts(
    input: BlackBoxBrowserMessagingPortsInput
): Pick<BlackBoxBrowserRuntimeComponents, 'deliveries' | 'peers'> {
    const { session, state } = input;
    return {
        deliveries: {
            getHandle: (msgId) => browserDeliveryComposition.deliveries.getHandle(msgId),
            replayCapturedMessage: async (replay) =>
                await replayBlackBoxCapturedMessage({
                    ...replay,
                    sessionId: session.connection.session()?.sessionId,
                    context: session.session.readMiddleware()
                }),
            submitRawControl: async (control) =>
                await submitBlackBoxRawControl({
                    control,
                    sessionId: session.connection.session()?.sessionId,
                    context: session.session.readMiddleware(),
                    nowMs: Date.now()
                }),
            resolveRoomSendFence: (roomRef) => state.roomStateStore.resolveRoomSendFence(roomRef)
        },
        peers: {
            serverPeerId: () => session.connection.serverPeerId(),
            session: () => session.connection.session(),
            getRoomSessions: (roomRef) => state.roomStateStore.findGroupSnapshot(roomRef)?.activeSessions,
            getRoomLeaderSessionId: (roomRef) => {
                const snapshot = state.roomStateStore.findGroupSnapshot(roomRef);
                return snapshot === undefined ? undefined : resolveRallarGroupLeaderSessionId(snapshot);
            }
        }
    };
}

export async function readBlackBoxRtcMessageNacks(
    sessionId: string | undefined,
    messageId: string
): Promise<readonly ALNackPayload[]> {
    if (!sessionId) {
        throw new Error(
            'RTC message diagnostics require an authenticated session.'
        );
    }
    const { admissionStore } = resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId);
    if (!admissionStore) {
        throw new Error('RTC outbound admission diagnostics are unavailable.');
    }
    const observation = await admissionStore.readRepairMessage(
        messageId,
        (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: []
        })
    );
    return observation.nacks;
}

interface RegisterBlackBoxBrowserRallarLifecycleInput {
    readonly foundation: BrowserRuntimeFoundation;
    readonly state: BrowserStateComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly director: BrowserDirectorComposition;
}

function registerBlackBoxBrowserRallarLifecycle(
    input: RegisterBlackBoxBrowserRallarLifecycleInput
): void {
    registerBrowserStateLifecycle({
        lifecycle: input.foundation.lifecycle,
        directorRelays: input.director.directorRelays,
        stateStore: input.state.stateStore
    });
    registerBrowserTransportLifecycle({
        lifecycle: input.foundation.lifecycle,
        messageSubscriptions: input.messaging.messagesController.subscriptions,
        wsInbox: input.stateEvents.wsInbox,
        wsController: input.realtime.wsController,
        realtimeReceive: input.realtime.realtimeReceive,
        rtcLifecycle: input.realtime.rtcController.lifecycle
    });
}

interface BlackBoxBrowserRuntimeComponents {
    readonly session: BrowserSessionCoreComposition;
    readonly rooms: BrowserRoomsComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
    readonly crdt: BrowserCrdtComposition;
    readonly director: BrowserDirectorComposition;
    readonly diagnostics: BlackBoxBrowserDiagnosticsDependency;
    readonly deliveries: BlackBoxBrowserDeliveriesDependency;
    readonly peers: BlackBoxBrowserPeersDependency;
}

function toBlackBoxBrowserRuntimeDependency(
    components: BlackBoxBrowserRuntimeComponents
): BlackBoxBrowserRallarRuntimeDependency {
    const { session, rooms, messaging, realtime, crdt, director, diagnostics, deliveries, peers } = components;
    return {
        ...session.connection,
        connect: async (options) => {
            const connected = await session.session.connectWithRtcCapture(options);
            return Object.freeze({
                rtcCapture: connected.rtcCapture,
                captureOwnershipFailure: () =>
                    browserDeliveryComposition.sessionDeliveries.captureOwnershipFailure(connected.middleware)
            });
        },
        readRtcMessageNacks: async (messageId) =>
            await readBlackBoxRtcMessageNacks(
                session.connection.session()?.sessionId,
                messageId
            ),
        refreshRoomState: async (roomRef, options) =>
            await refreshBlackBoxBrowserRoomState({
                roomRef,
                options,
                rooms: rooms.rooms,
                session: session.session
            }),
        auth: session.auth,
        rooms: {
            join: async (room, options) => {
                await rooms.rooms.join(room, options);
            },
            leave: async (options) => {
                await rooms.rooms.leave(options);
            },
            refresh: async (options) => {
                await rooms.rooms.refresh(options);
            },
            formation: (room) => rooms.rooms.formation(room)
        },
        messages: messaging.messages,
        realtime: realtime.realtime,
        ws: realtime.wsController.facade,
        rtc: realtime.rtc,
        crdt: crdt.crdt,
        director: director.director,
        diagnostics,
        deliveries,
        peers
    };
}

function createBlackBoxBrowserTransportComposition(
    readVolatileSessionLimits: () => ALVolatileSessionLimits
): BlackBoxBrowserTransportComposition {
    const foundation = createBrowserRuntimeFoundation();
    const state = createBrowserStateComposition({
        runtime: foundation.runtime,
        stateRuntime: foundation.stateRuntime
    });
    const recovery = createBrowserResyncRecoveryComposition({ connectionRuntime: foundation.connectionRuntime });
    const session = createBrowserSessionCoreComposition({
        qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },
        readVolatileSessionLimits,
        foundation,
        state,
        sessionDeliveries: browserDeliveryComposition.sessionDeliveries,
        onResyncRequired: (resync) => recovery.resyncRecovery.onResyncRequired(resync)
    });
    const stateEvents = createBrowserStateEventComposition({
        connectionRuntime: foundation.connectionRuntime,
        session: session.session
    });
    const messaging = createBrowserMessagingComposition({
        ...browserDeliveryComposition,
        wsInbox: stateEvents.wsInbox,
        recoveryOwners: recovery.recoveryOwners,
        state,
        session: session.session
    });
    const realtime = createBrowserRealtimeCoreComposition({
        runtime: foundation.runtime,
        state,
        session: session.session
    });

    return { foundation, state, session, stateEvents, messaging, realtime };
}

interface BlackBoxBrowserTransportComposition {
    readonly foundation: BrowserRuntimeFoundation;
    readonly state: BrowserStateComposition;
    readonly session: BrowserSessionCoreComposition;
    readonly stateEvents: BrowserStateEventComposition;
    readonly messaging: BrowserMessagingComposition;
    readonly realtime: BrowserRealtimeCoreComposition;
}
