import type {
    BlackBoxBrowserAuthDependency,
    BlackBoxBrowserCrdtDependency,
    BlackBoxBrowserDirectorDependency,
    BlackBoxBrowserMessagesDependency,
    BlackBoxBrowserRallarRuntimeDependency,
    BlackBoxBrowserRealtimeDependency,
    BlackBoxBrowserRoomsDependency,
    BlackBoxBrowserRoomSessionDependency,
    BlackBoxBrowserRtcDependency,
    BlackBoxBrowserWsDependency
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarDirectorOutputRecord } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/contracts.ts';
import type { RallarCrdtDocument, RallarCrdtOpenOptions } from '@shared-web/browser/rallar-crdt.ts';
import type { RallarDirectorRelayConfig, RallarDirectorRelayHandle } from '@shared-web/browser/rallar-director-facade.ts';
import type { RallarMessagePayload, RallarMessageSendResult } from '@shared-web/browser/rallar-message-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtOperationBatch } from '@shared/crdt/crdt-types.ts';

interface BrowserRuntimeDirectorRelayBehavior {
    (
        config: RallarDirectorRelayConfig<RallarMessagePayload, BlackBoxRallarDirectorOutputRecord, RallarMessagePayload>
    ): RallarDirectorRelayHandle<RallarMessagePayload, BlackBoxRallarDirectorOutputRecord, RallarMessagePayload>;
}
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
    readonly roomJoins: Array<Parameters<BlackBoxBrowserRoomsDependency['join']>>;
    readonly roomLeaves: Array<Parameters<BlackBoxBrowserRoomsDependency['leave']>>;
    readonly roomRefreshes: Array<Parameters<BlackBoxBrowserRoomsDependency['refresh']>>;
    readonly roomSessions: Array<Parameters<BlackBoxBrowserRoomsDependency['session']>>;
    readonly currentRoomRefreshes: Array<Parameters<BlackBoxBrowserRoomSessionDependency['refresh']>>;
    readonly realtimeSubscriptions: Array<Parameters<BlackBoxBrowserRealtimeDependency['onJson']>>;
    realtimeUnsubscribeCount: number;
    readonly realtimeSends: Array<Parameters<BlackBoxBrowserRealtimeDependency['sendJson']>>;
    readonly rtcMessageSubscriptions: Array<Parameters<BlackBoxBrowserMessagesDependency['rtc']['onMessage']>>;
    rtcMessageUnsubscribeCount: number;
    readonly rtcMessageSends: Array<Parameters<BlackBoxBrowserMessagesDependency['rtc']['send']>>;
    readonly wsMessageSubscriptions: Array<Parameters<BlackBoxBrowserMessagesDependency['ws']['onMessage']>>;
    wsMessageUnsubscribeCount: number;
    readonly wsMessageSends: Array<Parameters<BlackBoxBrowserMessagesDependency['ws']['send']>>;
    readonly rtcDiagnosticsReads: Array<Parameters<BlackBoxBrowserRtcDependency['diagnostics']>>;
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
    roomJoins: [],
    roomLeaves: [],
    roomRefreshes: [],
    roomSessions: [],
    currentRoomRefreshes: [],
    realtimeSubscriptions: [],
    realtimeUnsubscribeCount: 0,
    realtimeSends: [],
    rtcMessageSubscriptions: [],
    rtcMessageUnsubscribeCount: 0,
    rtcMessageSends: [],
    wsMessageSubscriptions: [],
    wsMessageUnsubscribeCount: 0,
    wsMessageSends: [],
    rtcDiagnosticsReads: [],
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
    roomJoin: vi.fn<BlackBoxBrowserRoomsDependency['join']>(),
    roomLeave: vi.fn<BlackBoxBrowserRoomsDependency['leave']>(),
    roomRefresh: vi.fn<BlackBoxBrowserRoomsDependency['refresh']>(),
    currentRoomRefresh: vi.fn<BlackBoxBrowserRoomSessionDependency['refresh']>(),
    realtimeHealth: vi.fn<BlackBoxBrowserRealtimeDependency['health']>(),
    realtimeSend: vi.fn<BlackBoxBrowserRealtimeDependency['sendJson']>(),
    realtimeOnJson: vi.fn<BlackBoxBrowserRealtimeDependency['onJson']>(),
    rtcStatus: vi.fn<BlackBoxBrowserRtcDependency['status']>(),
    rtcDiagnostics: vi.fn<BlackBoxBrowserRtcDependency['diagnostics']>(),
    rtcMessageSend: vi.fn<BlackBoxBrowserMessagesDependency['rtc']['send']>(),
    rtcMessageOnMessage: vi.fn<BlackBoxBrowserMessagesDependency['rtc']['onMessage']>(),
    wsMessageSend: vi.fn<BlackBoxBrowserMessagesDependency['ws']['send']>(),
    wsMessageOnMessage: vi.fn<BlackBoxBrowserMessagesDependency['ws']['onMessage']>(),
    crdtOpen: vi.fn<BlackBoxBrowserCrdtDependency['open']>(),
    directorAppoint: vi.fn<BlackBoxBrowserDirectorDependency['appoint']>(),
    directorResign: vi.fn<BlackBoxBrowserDirectorDependency['resign']>(),
    directorStatus: vi.fn<BlackBoxBrowserDirectorDependency['status']>(),
    directorCreateRelay: vi.fn<BrowserRuntimeDirectorRelayBehavior>()
};

const defaultRtcMessageSendResult: RallarMessageSendResult = {
    transport: 'rtc',
    status: 'sent-immediate',
    message: {
        id: { v: 2, msgId: 'test-message', ts: 0, senderId: 'client-1' },
        route: { topicId: 'test', contextId: 'test', resourceId: 'test' },
        payload: { typeId: 'test', contentType: 'application/json', resource: '{}' }
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

const currentRoom: BlackBoxBrowserRoomSessionDependency = {
    refresh: async (options) => {
        records.currentRoomRefreshes.push([options]);
        return await facadeBehavior.currentRoomRefresh(options);
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
    session: (room) => {
        records.roomSessions.push([room]);
        return currentRoom;
    }
};

const realtime: BlackBoxBrowserRealtimeDependency = {
    sendJson: async (input) => {
        records.realtimeSends.push([input]);
        return await facadeBehavior.realtimeSend(input);
    },
    onJson: facadeBehavior.realtimeOnJson,
    health: (options) => facadeBehavior.realtimeHealth(options)
};

const messages: BlackBoxBrowserMessagesDependency = {
    rtc: {
        send: async (input) => {
            records.rtcMessageSends.push([input]);
            return await facadeBehavior.rtcMessageSend(input);
        },
        onMessage: facadeBehavior.rtcMessageOnMessage
    },
    ws: {
        send: async (input) => {
            records.wsMessageSends.push([input]);
            return await facadeBehavior.wsMessageSend(input);
        },
        onMessage: facadeBehavior.wsMessageOnMessage
    }
};

const rtc: BlackBoxBrowserRtcDependency = {
    status: (options) => facadeBehavior.rtcStatus(options),
    diagnostics: async (options) => {
        records.rtcDiagnosticsReads.push([options]);
        return await facadeBehavior.rtcDiagnostics(options);
    }
};

const ws: BlackBoxBrowserWsDependency = {
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
    open: openCrdtWithRecords
};

const director: BlackBoxBrowserDirectorDependency = {
    appoint: async (room, options) => {
        records.directorAppointments.push([room, options]);
        return await facadeBehavior.directorAppoint(room, options);
    },
    resign: async (room, options) => await facadeBehavior.directorResign(room, options),
    status: (room, options) => facadeBehavior.directorStatus(room, options),
    createRelay: createDirectorRelay
};

export const rallarFacadeTestDouble: BlackBoxBrowserRallarRuntimeDependency = {
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
    director
};

export function resetBrowserRuntimeFacadeTestDouble(): void {
    vi.resetAllMocks();
    clearRecords();
    facadeBehavior.login.mockResolvedValue(facadeSession);
    facadeBehavior.registerAndLogin.mockResolvedValue(facadeSession);
    facadeBehavior.logout.mockResolvedValue(undefined);
    facadeBehavior.restore.mockReturnValue(undefined);
    facadeBehavior.connect.mockResolvedValue({});
    facadeBehavior.disconnect.mockResolvedValue(undefined);
    facadeBehavior.roomJoin.mockResolvedValue({});
    facadeBehavior.roomLeave.mockResolvedValue({});
    facadeBehavior.roomRefresh.mockResolvedValue({});
    facadeBehavior.currentRoomRefresh.mockResolvedValue({});
    facadeBehavior.realtimeHealth.mockReturnValue([]);
    facadeBehavior.realtimeSend.mockResolvedValue([]);
    facadeBehavior.realtimeOnJson.mockImplementation((laneId, handler) => {
        records.realtimeSubscriptions.push([laneId, handler]);
        return () => {
            records.realtimeUnsubscribeCount += 1;
        };
    });
    facadeBehavior.rtcMessageSend.mockResolvedValue(defaultRtcMessageSendResult);
    facadeBehavior.rtcMessageOnMessage.mockImplementation((selector, handler) => {
        records.rtcMessageSubscriptions.push([selector, handler]);
        return () => {
            records.rtcMessageUnsubscribeCount += 1;
        };
    });
    facadeBehavior.wsMessageSend.mockResolvedValue(defaultWsMessageSendResult);
    facadeBehavior.wsMessageOnMessage.mockImplementation((selector, handler) => {
        records.wsMessageSubscriptions.push([selector, handler]);
        return () => {
            records.wsMessageUnsubscribeCount += 1;
        };
    });
}

function openCrdtWithRecords<TValue, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
    name: string,
    options?: RallarCrdtOpenOptions<TValue, TPayload>
): Promise<RallarCrdtDocument<TValue, TPayload>>;
async function openCrdtWithRecords(
    name: string,
    options?: RallarCrdtOpenOptions
): Promise<object> {
    records.crdtOpens.push([name, options]);
    return await facadeBehavior.crdtOpen(name, options);
}

function createDirectorRelay<TIntent, TOutput, TSnapshot = TOutput>(
    config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;
function createDirectorRelay(config: object): object {
    if (!isDirectorRelayConfig(config)) {
        throw new Error('The director relay test double received an invalid config.');
    }
    return facadeBehavior.directorCreateRelay(config);
}

function isDirectorRelayConfig(
    value: object
): value is RallarDirectorRelayConfig<RallarMessagePayload, BlackBoxRallarDirectorOutputRecord, RallarMessagePayload> {
    return 'intentTypeId' in value && typeof value.intentTypeId === 'string' &&
        'outputTypeId' in value && typeof value.outputTypeId === 'string' &&
        (!('readSnapshot' in value) || value.readSnapshot === undefined ||
            typeof value.readSnapshot === 'function') &&
        (!('onIntent' in value) || value.onIntent === undefined ||
            typeof value.onIntent === 'function') &&
        (!('onOutput' in value) || value.onOutput === undefined ||
            typeof value.onOutput === 'function') &&
        (!('onSnapshot' in value) || value.onSnapshot === undefined ||
            typeof value.onSnapshot === 'function') &&
        (!('onSyncRequest' in value) || value.onSyncRequest === undefined ||
            typeof value.onSyncRequest === 'function');
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
            records.roomJoins,
            records.roomLeaves,
            records.roomRefreshes,
            records.roomSessions,
            records.currentRoomRefreshes,
            records.realtimeSubscriptions,
            records.realtimeSends,
            records.rtcMessageSubscriptions,
            records.rtcMessageSends,
            records.wsMessageSubscriptions,
            records.wsMessageSends,
            records.rtcDiagnosticsReads,
            records.crdtOpens,
            records.directorAppointments
        ]
    ) {
        entries.length = 0;
    }
    records.restoreCount = 0;
    records.disconnectCount = 0;
    records.realtimeUnsubscribeCount = 0;
    records.rtcMessageUnsubscribeCount = 0;
    records.wsMessageUnsubscribeCount = 0;
}

export { records as facadeRecords };
