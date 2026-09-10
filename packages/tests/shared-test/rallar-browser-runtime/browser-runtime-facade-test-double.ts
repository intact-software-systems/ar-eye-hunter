import {
    createBlackBoxDiagnosticsRelay,
    type BlackBoxBrowserAuthDependency,
    type BlackBoxBrowserCrdtDependency,
    type BlackBoxBrowserDiagnosticsDependency,
    type BlackBoxBrowserDirectorDependency,
    type BlackBoxBrowserMessagesDependency,
    type BlackBoxBrowserRallarRuntimeDependency,
    type BlackBoxBrowserRealtimeDependency,
    type BlackBoxBrowserRoomsDependency,
    type BlackBoxBrowserRtcDependency,
    type BlackBoxBrowserWsDependency,
    type BlackBoxDiagnosticsRelay
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type {
    RallarMessageHandler,
    RallarMessagePayload,
    RallarMessageSendResult,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel,
    RallarTypedMessageSendOptions,
    RallarTypedPayloadHandler
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarCrdtDocument,
    RallarCrdtOpenOptions
} from '@shared-web/browser/rallar-crdt.ts';
import type { RallarRealtimeHandler } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarRoomFormation } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALStorageResetEvent } from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarCrdtOperationBatch } from '@shared/crdt/mod.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    createScriptedTransportFaultPort,
    type ScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { vi } from 'vitest';

export interface BrowserRuntimeFacadeRecords {
    readonly configurationWrites: Array<Parameters<BlackBoxBrowserRallarRuntimeDependency['configure']>[0]>;
    readonly defaultWrites: Array<Parameters<BlackBoxBrowserRallarRuntimeDependency['setDefaults']>[0]>;
    readonly loginAttempts: Array<Parameters<BlackBoxBrowserAuthDependency['login']>>;
    readonly registrationAttempts: Array<Parameters<BlackBoxBrowserAuthDependency['registerAndLogin']>>;
    readonly logoutAttempts: Array<Parameters<BlackBoxBrowserAuthDependency['logout']>>;
    restoreCount: number;
    readonly connectionAttempts: Array<Parameters<BlackBoxBrowserRallarRuntimeDependency['connect']>>;
    disconnectCount: number;
    wsLifecycleUnsubscribeCount: number;
    rtcLifecycleUnsubscribeCount: number;
    readonly roomStateRefreshes: Array<[GroupRef, RallarScopedOperationOptions]>;
    readonly roomJoins: Array<Parameters<BlackBoxBrowserRoomsDependency['join']>>;
    readonly roomLeaves: Array<Parameters<BlackBoxBrowserRoomsDependency['leave']>>;
    readonly roomRefreshes: Array<Parameters<BlackBoxBrowserRoomsDependency['refresh']>>;
    readonly realtimeSubscriptions: Array<[
        Parameters<BlackBoxBrowserRealtimeDependency['onJson']>[0],
        RallarRealtimeHandler<never>
    ]>;
    realtimeUnsubscribeCount: number;
    readonly realtimeSends: Array<Parameters<BlackBoxBrowserRealtimeDependency['sendJson']>>;
    readonly rtcMessageSubscriptions: Array<[
        Parameters<BlackBoxBrowserMessagesDependency['rtc']['onMessage']>[0],
        RallarMessageHandler<RallarMessagePayload>
    ]>;
    rtcMessageUnsubscribeCount: number;
    readonly rtcMessageSends: Array<Parameters<BlackBoxBrowserMessagesDependency['rtc']['send']>>;
    readonly wsMessageSubscriptions: Array<[
        Parameters<BlackBoxBrowserMessagesDependency['ws']['onMessage']>[0],
        RallarMessageHandler<RallarMessagePayload>
    ]>;
    wsMessageUnsubscribeCount: number;
    readonly wsMessageSends: Array<Parameters<BlackBoxBrowserMessagesDependency['ws']['send']>>;
    readonly typedChannelOpens: RallarRoomMessageChannelDefinition[];
    readonly typedSends: Array<[
        RallarMessagePayload,
        RallarTypedMessageSendOptions<RallarMessagePayload> | undefined
    ]>;
    readonly typedWsHandlers: Array<RallarTypedPayloadHandler<RallarMessagePayload>>;
    readonly typedRtcHandlers: Array<RallarTypedPayloadHandler<RallarMessagePayload>>;
    typedUnsubscribeCount: number;
    readonly rtcDiagnosticsReads: Array<Parameters<BlackBoxBrowserRtcDependency['diagnostics']>>;
    readonly rtcRoomWaits: Array<Parameters<BlackBoxBrowserRtcDependency['waitForRoom']>>;
    readonly crdtOpens: Array<Parameters<BlackBoxBrowserCrdtDependency['open']>>;
    readonly directorAppointments: Array<Parameters<BlackBoxBrowserDirectorDependency['appoint']>>;
}

const records: BrowserRuntimeFacadeRecords = {
    configurationWrites: [],
    defaultWrites: [],
    loginAttempts: [],
    registrationAttempts: [],
    logoutAttempts: [],
    restoreCount: 0,
    connectionAttempts: [],
    disconnectCount: 0,
    wsLifecycleUnsubscribeCount: 0,
    rtcLifecycleUnsubscribeCount: 0,
    roomStateRefreshes: [],
    roomJoins: [],
    roomLeaves: [],
    roomRefreshes: [],
    realtimeSubscriptions: [],
    realtimeUnsubscribeCount: 0,
    realtimeSends: [],
    rtcMessageSubscriptions: [],
    rtcMessageUnsubscribeCount: 0,
    rtcMessageSends: [],
    wsMessageSubscriptions: [],
    wsMessageUnsubscribeCount: 0,
    wsMessageSends: [],
    typedChannelOpens: [],
    typedSends: [],
    typedWsHandlers: [],
    typedRtcHandlers: [],
    typedUnsubscribeCount: 0,
    rtcDiagnosticsReads: [],
    rtcRoomWaits: [],
    crdtOpens: [],
    directorAppointments: []
};

export const facadeSession: AuthSession = {
    clientId: 'client-1',
    accessToken: 'access-token-1',
    username: 'alice',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000
};

export const facadeBehavior = {
    configure: vi.fn<BlackBoxBrowserRallarRuntimeDependency['configure']>(),
    setDefaults: vi.fn<BlackBoxBrowserRallarRuntimeDependency['setDefaults']>(),
    login: vi.fn<BlackBoxBrowserAuthDependency['login']>(),
    registerAndLogin: vi.fn<BlackBoxBrowserAuthDependency['registerAndLogin']>(),
    logout: vi.fn<BlackBoxBrowserAuthDependency['logout']>(),
    restore: vi.fn<BlackBoxBrowserAuthDependency['restore']>(),
    connect: vi.fn<BlackBoxBrowserRallarRuntimeDependency['connect']>(),
    disconnect: vi.fn<BlackBoxBrowserRallarRuntimeDependency['disconnect']>(),
    messageAdmission: vi.fn<BlackBoxBrowserRallarRuntimeDependency['hasMessageAdmission']>(),
    roomStateRefresh: vi.fn<BlackBoxBrowserRallarRuntimeDependency['refreshRoomState']>(),
    roomJoin: vi.fn<BlackBoxBrowserRoomsDependency['join']>(),
    roomLeave: vi.fn<BlackBoxBrowserRoomsDependency['leave']>(),
    roomRefresh: vi.fn<BlackBoxBrowserRoomsDependency['refresh']>(),
    roomFormation: vi.fn<BlackBoxBrowserRoomsDependency['formation']>(),
    realtimeHealth: vi.fn<BlackBoxBrowserRealtimeDependency['health']>(),
    realtimeSend: vi.fn<BlackBoxBrowserRealtimeDependency['sendJson']>(),
    realtimeOnJson: vi.fn<
        (
            laneId: Parameters<BlackBoxBrowserRealtimeDependency['onJson']>[0],
            handler: RallarRealtimeHandler<never>
        ) => () => void
    >(),
    rtcStatus: vi.fn<BlackBoxBrowserRtcDependency['status']>(),
    rtcOnStatus: vi.fn<BlackBoxBrowserRtcDependency['onStatus']>(),
    rtcRoomStatus: vi.fn<BlackBoxBrowserRtcDependency['roomStatus']>(),
    rtcWaitForRoom: vi.fn<BlackBoxBrowserRtcDependency['waitForRoom']>(),
    rtcOnLifecycle: vi.fn<BlackBoxBrowserRtcDependency['onLifecycle']>(),
    wsOnLifecycle: vi.fn<BlackBoxBrowserWsDependency['onLifecycle']>(),
    rtcDiagnostics: vi.fn<BlackBoxBrowserRtcDependency['diagnostics']>(),
    rtcMessageSend: vi.fn<BlackBoxBrowserMessagesDependency['rtc']['send']>(),
    rtcMessageOnMessage: vi.fn<
        (
            selector: Parameters<BlackBoxBrowserMessagesDependency['rtc']['onMessage']>[0],
            handler: RallarMessageHandler<RallarMessagePayload>
        ) => () => void
    >(),
    wsMessageSend: vi.fn<BlackBoxBrowserMessagesDependency['ws']['send']>(),
    wsMessageOnMessage: vi.fn<
        (
            selector: Parameters<BlackBoxBrowserMessagesDependency['ws']['onMessage']>[0],
            handler: RallarMessageHandler<RallarMessagePayload>
        ) => () => void
    >(),
    typedSend: vi.fn<
        (
            payload: RallarMessagePayload,
            options: RallarTypedMessageSendOptions<RallarMessagePayload> | undefined
        ) => Promise<RallarMessageSendResult>
    >(),
    crdtOpen: vi.fn<BlackBoxBrowserCrdtDependency['open']>(),
    directorAppoint: vi.fn<BlackBoxBrowserDirectorDependency['appoint']>(),
    directorResign: vi.fn<BlackBoxBrowserDirectorDependency['resign']>(),
    directorStatus: vi.fn<BlackBoxBrowserDirectorDependency['status']>(),
    directorCreateRelay: vi.fn<BlackBoxBrowserDirectorDependency['createRelay']>()
};

const defaultRtcMessageSendResult: RallarMessageSendResult = {
    transport: 'rtc',
    status: 'accepted',
    message: {
        id: { v: 2, msgId: 'test-message', ts: 0, senderId: 'client-1' },
        route: { topicId: 'test', contextId: 'test', resourceId: 'test' },
        payload: {
            typeId: 'test',
            contentType: 'application/json',
            resource: '{}'
        }
    },
    entries: []
};

const defaultWsMessageSendResult: RallarMessageSendResult = {
    ...defaultRtcMessageSendResult,
    transport: 'ws'
};

const auth: BlackBoxBrowserAuthDependency = {
    login: async (request, options) => {
        records.loginAttempts.push([request, options]);
        return await facadeBehavior.login(request, options);
    },
    registerAndLogin: async (request, options) => {
        records.registrationAttempts.push([request, options]);
        return await facadeBehavior.registerAndLogin(request, options);
    },
    logout: async (options) => {
        records.logoutAttempts.push([options]);
        await facadeBehavior.logout(options);
    },
    restore: () => {
        records.restoreCount += 1;
        return facadeBehavior.restore();
    }
};

const rooms: BlackBoxBrowserRoomsDependency = {
    join: async (room, options) => {
        records.roomJoins.push([room, options]);
        return await facadeBehavior.roomJoin(room, options);
    },
    leave: async (input) => {
        records.roomLeaves.push([input]);
        return await facadeBehavior.roomLeave(input);
    },
    refresh: async (input) => {
        records.roomRefreshes.push([input]);
        return await facadeBehavior.roomRefresh(input);
    },
    formation: (room) => facadeBehavior.roomFormation(room)
};

const realtime: BlackBoxBrowserRealtimeDependency = {
    sendJson: async (input) => {
        records.realtimeSends.push([input]);
        return await facadeBehavior.realtimeSend(input);
    },
    onJson: (laneId, handler) => {
        const recordedHandler = toRecordedRealtimeHandler(handler);
        records.realtimeSubscriptions.push([laneId, recordedHandler]);
        const unsubscribe = facadeBehavior.realtimeOnJson(laneId, recordedHandler);
        return () => {
            records.realtimeUnsubscribeCount += 1;
            unsubscribe();
        };
    },
    health: (options) => facadeBehavior.realtimeHealth(options)
};

const messages: BlackBoxBrowserMessagesDependency = {
    room: <T>(
        definition: RallarRoomMessageChannelDefinition
    ): RallarTypedMessageChannel<T> => {
        records.typedChannelOpens.push(definition);
        return createTypedChannelTestDouble<T>();
    },
    rtc: {
        send: async (input) => {
            records.rtcMessageSends.push([input]);
            return await facadeBehavior.rtcMessageSend(input);
        },
        onMessage: (selector, handler) => {
            const recordedHandler = toRecordedMessageHandler(handler);
            records.rtcMessageSubscriptions.push([selector, recordedHandler]);
            const unsubscribe = facadeBehavior.rtcMessageOnMessage(
                selector,
                recordedHandler
            );
            return () => {
                records.rtcMessageUnsubscribeCount += 1;
                unsubscribe();
            };
        }
    },
    ws: {
        send: async (input) => {
            records.wsMessageSends.push([input]);
            return await facadeBehavior.wsMessageSend(input);
        },
        onMessage: (selector, handler) => {
            const recordedHandler = toRecordedMessageHandler(handler);
            records.wsMessageSubscriptions.push([selector, recordedHandler]);
            const unsubscribe = facadeBehavior.wsMessageOnMessage(
                selector,
                recordedHandler
            );
            return () => {
                records.wsMessageUnsubscribeCount += 1;
                unsubscribe();
            };
        }
    }
};

const rtc: BlackBoxBrowserRtcDependency = {
    onLifecycle: (listener, options) => facadeBehavior.rtcOnLifecycle(listener, options),
    onStatus: (listener, options) => facadeBehavior.rtcOnStatus(listener, options),
    roomStatus: (room, options) => facadeBehavior.rtcRoomStatus(room, options),
    waitForRoom: async (room, options) => {
        records.rtcRoomWaits.push([room, options]);
        return await facadeBehavior.rtcWaitForRoom(room, options);
    },
    status: (options) => facadeBehavior.rtcStatus(options),
    diagnostics: async (options) => {
        records.rtcDiagnosticsReads.push([options]);
        return await facadeBehavior.rtcDiagnostics(options);
    }
};

const ws: BlackBoxBrowserWsDependency = {
    onLifecycle: (listener, options) => facadeBehavior.wsOnLifecycle(listener, options),
    status: () => ({
        connectState: 'idle',
        readyState: 'closed',
        isOpen: false,
        reconnecting: false,
        reconnectEnabled: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 0,
        reconnectExhausted: false
    })
};

const crdt: BlackBoxBrowserCrdtDependency = {
    open: openCrdtDocument
};

const director: BlackBoxBrowserDirectorDependency = {
    appoint: async (room, options) => {
        records.directorAppointments.push([room, options]);
        return await facadeBehavior.directorAppoint(room, options);
    },
    resign: async (room, options) => await facadeBehavior.directorResign(room, options),
    status: (room, options) => facadeBehavior.directorStatus(room, options),
    createRelay: facadeBehavior.directorCreateRelay
};

let scriptedFaults = createScriptedTransportFaultPort();
let countingStorage = createCountingIndexedDbOperationObserver();
let outboundDiagnosticsRelay = createBlackBoxDiagnosticsRelay<ALOutboundRuntimeDiagnosticsEvent>();
let inboundDiagnosticsRelay = createBlackBoxDiagnosticsRelay<ALInboundRuntimeDiagnosticsEvent>();
let storageResetRelay = createBlackBoxDiagnosticsRelay<ALStorageResetEvent>();

const diagnostics: BlackBoxBrowserDiagnosticsDependency = {
    get faults(): ScriptedTransportFaultPort {
        return scriptedFaults;
    },
    get storage(): CountingIndexedDbOperationObserver {
        return countingStorage;
    },
    get outboundDiagnostics(): BlackBoxDiagnosticsRelay<ALOutboundRuntimeDiagnosticsEvent> {
        return outboundDiagnosticsRelay;
    },
    get inboundDiagnostics(): BlackBoxDiagnosticsRelay<ALInboundRuntimeDiagnosticsEvent> {
        return inboundDiagnosticsRelay;
    },
    get storageReset(): BlackBoxDiagnosticsRelay<ALStorageResetEvent> {
        return storageResetRelay;
    }
};

export const rallarFacadeTestDouble: BlackBoxBrowserRallarRuntimeDependency = {
    readRtcMessageNacks: async () => [],
    hasMessageAdmission: async (messageId, transport) => await facadeBehavior.messageAdmission(messageId, transport),
    configure: (config) => {
        records.configurationWrites.push(config);
        facadeBehavior.configure(config);
    },
    setDefaults: (defaults) => {
        records.defaultWrites.push(defaults);
        facadeBehavior.setDefaults(defaults);
    },
    connect: async (options) => {
        records.connectionAttempts.push([options]);
        return await facadeBehavior.connect(options);
    },
    disconnect: async () => {
        records.disconnectCount += 1;
        await facadeBehavior.disconnect();
    },
    refreshRoomState: async (roomRef, options) => {
        records.roomStateRefreshes.push([roomRef, options]);
        await facadeBehavior.roomStateRefresh(roomRef, options);
    },
    status: () => 'connected',
    isConnected: () => true,
    session: () => facadeSession,
    auth,
    rooms,
    realtime,
    messages,
    rtc,
    ws,
    crdt,
    director,
    diagnostics
};

export function resetBrowserRuntimeFacadeTestDouble(): void {
    vi.resetAllMocks();
    clearRecords();
    scriptedFaults = createScriptedTransportFaultPort();
    countingStorage = createCountingIndexedDbOperationObserver();
    outboundDiagnosticsRelay = createBlackBoxDiagnosticsRelay<ALOutboundRuntimeDiagnosticsEvent>();
    inboundDiagnosticsRelay = createBlackBoxDiagnosticsRelay<ALInboundRuntimeDiagnosticsEvent>();
    storageResetRelay = createBlackBoxDiagnosticsRelay<ALStorageResetEvent>();
    facadeBehavior.login.mockResolvedValue(facadeSession);
    facadeBehavior.registerAndLogin.mockResolvedValue(facadeSession);
    facadeBehavior.logout.mockResolvedValue(undefined);
    facadeBehavior.restore.mockReturnValue(undefined);
    facadeBehavior.connect.mockResolvedValue(undefined);
    facadeBehavior.disconnect.mockResolvedValue(undefined);
    facadeBehavior.messageAdmission.mockResolvedValue(false);
    facadeBehavior.roomStateRefresh.mockResolvedValue(undefined);
    facadeBehavior.roomJoin.mockResolvedValue(undefined);
    facadeBehavior.roomLeave.mockResolvedValue(undefined);
    facadeBehavior.roomRefresh.mockResolvedValue(undefined);
    // The runtime installs the formation diagnostics on every room-scoped connect, so the double
    // answers with a handle that holds no room and subscribes to nothing.
    facadeBehavior.roomFormation.mockImplementation(() => createIdleRoomFormation());
    facadeBehavior.rtcOnStatus.mockImplementation(() => () => {});
    facadeBehavior.rtcRoomStatus.mockImplementation(() => createIdleRoomTransportStatus());
    facadeBehavior.rtcWaitForRoom.mockImplementation(async () => createIdleRoomTransportStatus());
    facadeBehavior.realtimeHealth.mockReturnValue([]);
    facadeBehavior.rtcOnLifecycle.mockImplementation((listener, options) => {
        if (options?.emitCurrent) {
            void listener({ kind: 'snapshot', atEpochMs: 123, status: rtc.status() });
        }
        return () => {
            records.rtcLifecycleUnsubscribeCount += 1;
        };
    });
    facadeBehavior.wsOnLifecycle.mockImplementation((listener, options) => {
        if (options?.emitCurrent) {
            void listener({ kind: 'snapshot', atEpochMs: 123, status: ws.status() });
        }
        return () => {
            records.wsLifecycleUnsubscribeCount += 1;
        };
    });
    facadeBehavior.realtimeSend.mockResolvedValue([]);
    facadeBehavior.realtimeOnJson.mockReturnValue(() => undefined);
    facadeBehavior.rtcMessageSend.mockResolvedValue(defaultRtcMessageSendResult);
    facadeBehavior.rtcMessageOnMessage.mockReturnValue(() => undefined);
    facadeBehavior.wsMessageSend.mockResolvedValue(defaultWsMessageSendResult);
    facadeBehavior.wsMessageOnMessage.mockReturnValue(() => undefined);
    facadeBehavior.typedSend.mockResolvedValue(defaultWsMessageSendResult);
}

function clearRecords(): void {
    for (
        const entries of [
            records.configurationWrites,
            records.defaultWrites,
            records.loginAttempts,
            records.registrationAttempts,
            records.logoutAttempts,
            records.connectionAttempts,
            records.roomStateRefreshes,
            records.roomJoins,
            records.roomLeaves,
            records.roomRefreshes,
            records.realtimeSubscriptions,
            records.realtimeSends,
            records.rtcMessageSubscriptions,
            records.rtcMessageSends,
            records.wsMessageSubscriptions,
            records.wsMessageSends,
            records.typedChannelOpens,
            records.typedSends,
            records.typedWsHandlers,
            records.typedRtcHandlers,
            records.rtcDiagnosticsReads,
            records.rtcRoomWaits,
            records.crdtOpens,
            records.directorAppointments
        ]
    ) {
        entries.length = 0;
    }
    records.restoreCount = 0;
    records.disconnectCount = 0;
    records.wsLifecycleUnsubscribeCount = 0;
    records.rtcLifecycleUnsubscribeCount = 0;
    records.realtimeUnsubscribeCount = 0;
    records.rtcMessageUnsubscribeCount = 0;
    records.wsMessageUnsubscribeCount = 0;
    records.typedUnsubscribeCount = 0;
}

function createTypedChannelTestDouble<T>(): RallarTypedMessageChannel<T> {
    const unsupported = (): never => {
        throw new Error(
            'The facade test double only drives typed channel send and subscribe.'
        );
    };
    return {
        send: async (payload, options) => {
            const sendOptions = options as RallarTypedMessageSendOptions<RallarMessagePayload> | undefined;
            records.typedSends.push([payload as RallarMessagePayload, sendOptions]);
            return await facadeBehavior.typedSend(
                payload as RallarMessagePayload,
                sendOptions
            );
        },
        sendRtc: unsupported,
        sendWs: unsupported,
        onWs: (handler) => {
            records.typedWsHandlers.push(
                handler as RallarTypedPayloadHandler<RallarMessagePayload>
            );
            return () => {
                records.typedUnsubscribeCount += 1;
            };
        },
        onRtc: (handler) => {
            records.typedRtcHandlers.push(
                handler as RallarTypedPayloadHandler<RallarMessagePayload>
            );
            return () => {
                records.typedUnsubscribeCount += 1;
            };
        }
    };
}

export { records as facadeRecords };

async function openCrdtDocument<TValue, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
    name: string,
    options?: RallarCrdtOpenOptions<TValue, TPayload>
): Promise<RallarCrdtDocument<TValue, TPayload>> {
    records.crdtOpens.push([name, options]);
    const document = await facadeBehavior.crdtOpen(name, options);
    return document as RallarCrdtDocument<TValue, TPayload>;
}

function toRecordedRealtimeHandler<T>(
    handler: RallarRealtimeHandler<T>
): RallarRealtimeHandler<never> {
    return handler as RallarRealtimeHandler<never>;
}

function toRecordedMessageHandler<T>(
    handler: RallarMessageHandler<T>
): RallarMessageHandler<RallarMessagePayload> {
    return handler as RallarMessageHandler<RallarMessagePayload>;
}

function createIdleRoomFormation(): RallarRoomFormation {
    const unsupported = (): never => {
        throw new Error('The facade test double does not drive room formation.');
    };
    return {
        roomRef: {
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'room'
        },
        status: () => undefined,
        readView: unsupported,
        plan: unsupported,
        connect: unsupported,
        activate: unsupported,
        reconfigure: unsupported,
        pause: unsupported,
        resume: unsupported,
        reset: unsupported,
        start: unsupported,
        waitForStage: unsupported,
        waitForCondition: unsupported,
        waitForLayout: unsupported,
        onChange: () => () => {},
        onLayout: () => () => {}
    };
}

function createIdleRoomTransportStatus(): RallarRoomTransportStatus {
    return {
        ws: ws.status(),
        rtc: {
            desired: false,
            mode: 'off',
            state: 'off',
            desiredPeerIds: [],
            knownPeerIds: [],
            activePeerIds: [],
            readyPeerIds: [],
            failedPeerIds: [],
            peers: [],
            laneId: 'lane'
        }
    };
}
