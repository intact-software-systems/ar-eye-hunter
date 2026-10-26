import { RELIC_TOPICS, RELIC_TYPES, type RelicServerEvent } from '@relic-hunters/mod.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rallar-room-directory.ts';
import { RallarRecentRooms, RallarRoomEntry } from '@shared-web/browser/rallar-room-entry.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { fetchRelicSnapshot, resetRelicGame, sendRelicCommand } from './api.ts';
import { createRelicAuthorityClientBridge } from './rallar-game-authority-adapter.ts';
import type { RelicHuntersRuntime } from './relic-hunters-runtime.ts';
import { sendRelicWsCommand } from './send-relic-ws-command.ts';
import { subscribeRelicHunterEvents } from './subscribe-relic-hunter-events.ts';
import { subscribeRelicRoundTransitions } from './subscribe-relic-round-transitions.ts';

export const RELIC_ROOM_SCOPE = { applicationId: 'rallar-server', workspaceId: 'default' };
const SNAPSHOT_CHANNEL = { topicId: RELIC_TOPICS.snapshot, typeId: RELIC_TYPES.snapshot };

/** The browser facade owns admission and transport; the runtime owns the expedition page lifecycle. */
export function browserRelicRuntimeDeps(): RelicHuntersRuntime.Dependencies {
    const authority = createRelicAuthorityClientBridge(rallar);
    const roomEntry = RallarRoomEntry.createBrowser(rallar, { scope: RELIC_ROOM_SCOPE });
    const recentRooms = RallarRecentRooms.createBrowser(rallar, roomEntry, { scope: RELIC_ROOM_SCOPE });
    return {
        roomEntry,
        recentRooms,
        directory: RallarRoomDirectory.createBrowser(rallar, {
            scope: RELIC_ROOM_SCOPE,
            request: { kind: 'room', q: 'relic hunters', limit: 50, includeEmpty: false, order: 'online-members' },
            refreshIntervalMs: 30_000,
            timeoutMs: 10_000,
            maxAttempts: 1
        }),
        timers: createDefaultTimers(),
        restoreSession: () => rallar.auth.restore(),
        login: (username, password) => rallar.auth.login({ username, password }),
        register: (username, password, displayName) =>
            rallar.auth.registerAndLogin({ username, password, displayName: displayName || username }),
        logout: () => rallar.auth.logout(),
        onAuthChange: (listener) => rallar.auth.onChange(listener, { emitCurrent: true }),
        start: (options) => rallar.start(options),
        subscriptions: () => rallar.subscriptions(),
        roomState: () => rallar.rooms.state(),
        refreshRooms: () => rallar.rooms.refresh(),
        waitForPresence: (roomId, options) => rallar.rooms.waitForPresence(roomId, options),
        onRoomsChange: (handler) => rallar.rooms.onChange(handler),
        onSnapshotMessage: (handler) =>
            rallar.messages.ws.onMessage<RelicServerEvent>(SNAPSHOT_CHANNEL, (message) => handler(message.payload)),
        onRtcSnapshotMessage: (handler) =>
            rallar.messages.rtc.onMessage<RelicServerEvent>(SNAPSHOT_CHANNEL, (message) => handler(message.payload)),
        onAuthoritySnapshotMessage: (handler) => authority.start(handler),
        onRoundTransitionMessage: (roomId, subscription) =>
            subscribeRelicRoundTransitions(rallar, roomId, subscription),
        onHunterEventMessage: (roomId, subscription) => subscribeRelicHunterEvents(rallar, roomId, subscription),
        authorityStatus: () => authority.status(),
        publishRtcSnapshot: (snapshot) => authority.publishSnapshotRepair(snapshot),
        createRoom: (displayName, joinMode, directoryListing) =>
            rallar.rooms.createAndSwitch({
                displayName,
                joinMode,
                directoryListing,
                retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
            }),
        joinRoom: async (roomId) => {
            await rallar.rooms.enter(roomId);
        },
        fetchSnapshot: (roomId) => fetchRelicSnapshot(roomId),
        sendWsCommand: (roomId, command) => sendRelicWsCommand(rallar, roomId, command),
        sendRestCommand: (roomId, command) => sendRelicCommand(roomId, command),
        resetGame: (roomId) => resetRelicGame(roomId)
    };
}
