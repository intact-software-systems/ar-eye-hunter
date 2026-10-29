import {
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { rallar, type RallarJoinRoomOptions, type RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import { readActiveGroupSessionRole } from '@shared/api/group-spectating.ts';
import type { GroupJoinMode, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
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
    const roomEntry = RallarRoomEntry.createBrowser({
        auth: rallar.auth,
        session: () => rallar.session(),
        rooms: { onChange: (handler, options) => rallar.rooms.onChange(handler, options), join: joinRelicRoom }
    }, { scope: RELIC_ROOM_SCOPE });
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
        onSnapshotMessage: subscribeToServerSnapshots,
        onAuthoritySnapshotMessage: (handler) => authority.start(handler),
        onRoundTransitionMessage: (roomId, subscription) =>
            subscribeRelicRoundTransitions(rallar, roomId, subscription),
        onHunterEventMessage: (roomId, subscription) => subscribeRelicHunterEvents(rallar, roomId, subscription),
        authorityStatus: () => authority.status(),
        publishRtcSnapshot: (snapshot) => authority.publishSnapshotRepair(snapshot),
        createRoomNameSeed: () => createRallarAiRoomNameSeed('relic-hunters'),
        createRoom: createRelicRoom,
        joinRoom: async (roomId, participation) => {
            await joinRelicRoom({ ...RELIC_ROOM_SCOPE, groupId: roomId }, {
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

/** Only the configured authority may publish the current room's public snapshot. */
function subscribeToServerSnapshots(handler: (event: RelicServerEvent) => void): RallarUnsubscribe {
    return rallar.messages.ws.onMessage<RelicServerEvent>(SNAPSHOT_CHANNEL, (message) => {
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
    });
}

function createRelicRoom(
    displayName: string,
    joinMode: GroupJoinMode,
    directoryListing?: GroupDirectoryListing
): Promise<GroupSnapshot> {
    return rallar.rooms.createAndSwitch({
        displayName,
        maxMembers: 4,
        maxSpectators: 16,
        joinMode,
        directoryListing,
        retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
    });
}

/** Watching is admission, not an implicit exit for another live tab of the same hunter. */
async function joinRelicRoom(roomRef: GroupRef, options: RallarJoinRoomOptions): Promise<GroupSnapshot> {
    if (options.participation === 'spectator') {
        const session = rallar.session();
        const state = await rallar.rooms.refresh();
        if (
            options.signal?.aborted || !session || rallar.session()?.sessionId !== session.sessionId ||
            rallar.session()?.clientId !== session.clientId
        ) {
            throw new Error('Room entry changed while checking expedition participation.');
        }
        const room = state.rooms.find((candidate) => isSameGroupRef(candidate.roomRef, roomRef))?.snapshot;
        const member = room?.members.find((candidate) =>
            candidate.principalId === session?.clientId && candidate.status === 'active'
        );
        if (session && room && member && member.role !== 'spectator') {
            const playerIds = new Set([
                session.sessionId,
                ...room.activeSessions.filter((presence) =>
                    presence.principalId === session.clientId && presence.status === 'active' &&
                    presence.expiresAtEpochMs > Date.now()
                ).map((presence) => presence.sessionId)
            ]);
            const signal = options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
                : AbortSignal.timeout(10_000);
            const snapshot = await fetchRelicSnapshot(roomRef.groupId, signal);
            if (
                signal.aborted || rallar.session()?.sessionId !== session.sessionId ||
                rallar.session()?.clientId !== session.clientId
            ) {
                throw new Error('Room entry changed while checking expedition participation.');
            }
            if (
                snapshot && snapshot.phase !== 'finished' &&
                snapshot.players.some((player) =>
                    playerIds.has(player.playerId) && player.withdrawnAtEpochMs === undefined
                )
            ) {
                throw new Error('Leave the expedition room before watching another expedition.');
            }
        }
    }
    return await rallar.rooms.join(roomRef, options);
}
