import {
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readActiveGroupSessionRole } from '@shared/api/group-spectating.ts';
import { createRallarAiRoomNameSeed } from '@shared/rallar-ai/rallar-ai-room-names.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import {
    fetchRelicSnapshot,
    initializeRelicGame,
    resetRelicGame,
    sendRelicCommand
} from './api.ts';
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
        waitForPresence: (roomId, options) =>
            rallar.rooms.waitForPresence({ ...RELIC_ROOM_SCOPE, groupId: roomId }, options),
        onRoomsChange: (handler) => rallar.rooms.onChange(handler),
        onSnapshotMessage: (handler) =>
            rallar.messages.ws.onMessage<RelicServerEvent>(SNAPSHOT_CHANNEL, (message) => {
                const state = rallar.rooms.state();
                const target = readALTargetGroupRef(message.raw);
                const serverPeerId = rallar.serverPeerId();
                const session = rallar.auth.restore();
                if (
                    serverPeerId && message.senderId === serverPeerId && target && state.currentRoomRef &&
                    isSameGroupRef(target, state.currentRoomRef) && session &&
                    readActiveGroupSessionRole(state.currentRoom, session.sessionId, Date.now()) !== undefined
                ) {
                    handler(message.payload);
                }
            }),
        onAuthoritySnapshotMessage: (handler) => authority.start(handler),
        onRoundTransitionMessage: (roomId, subscription) =>
            subscribeRelicRoundTransitions(rallar, roomId, subscription),
        onHunterEventMessage: (roomId, subscription) => subscribeRelicHunterEvents(rallar, roomId, subscription),
        authorityStatus: () => authority.status(),
        publishRtcSnapshot: (snapshot) => authority.publishSnapshotRepair(snapshot),
        createRoomNameSeed: () => createRallarAiRoomNameSeed('relic-hunters'),
        createRoom: (displayName, joinMode, directoryListing) =>
            rallar.rooms.createAndSwitch({
                displayName,
                maxMembers: 4,
                maxSpectators: 16,
                joinMode,
                directoryListing,
                retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
            }),
        joinRoom: async (roomId, participation) => {
            await rallar.rooms.join({ ...RELIC_ROOM_SCOPE, groupId: roomId }, {
                ...(participation === 'preserve' ? {} : { participation }),
                leaveCurrent: true
            });
        },
        leaveRoom: async (roomId) => {
            await rallar.rooms.leave({ roomRef: { ...RELIC_ROOM_SCOPE, groupId: roomId } });
        },
        initializeGame: (roomId) => initializeRelicGame(roomId),
        fetchSnapshot: (roomId) => fetchRelicSnapshot(roomId),
        sendWsCommand: (roomId, command) => sendRelicWsCommand(rallar, roomId, command),
        sendRestCommand: (roomId, command) => sendRelicCommand(roomId, command),
        resetGame: (roomId) => resetRelicGame(roomId)
    };
}
