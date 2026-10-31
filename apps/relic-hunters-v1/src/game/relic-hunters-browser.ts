import {
    hasUnfinishedRelicParticipation,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { rallar, type RallarJoinRoomOptions, type RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
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
import { RelicExpeditionParticipation } from './runtime/relic-expedition-participation.ts';
import { sendRelicWsCommand } from './send-relic-ws-command.ts';
import { subscribeRelicHunterEvents } from './subscribe-relic-hunter-events.ts';
import { subscribeRelicRoundTransitions } from './subscribe-relic-round-transitions.ts';

export const RELIC_ROOM_SCOPE = { applicationId: 'rallar-server', workspaceId: 'default' };
const SNAPSHOT_CHANNEL = { topicId: RELIC_TOPICS.snapshot, typeId: RELIC_TYPES.snapshot };

/** The browser facade owns admission and transport; the runtime owns the expedition page lifecycle. */
export function browserRelicRuntimeDeps(): RelicHuntersRuntime.Dependencies {
    const expeditionParticipation = new RelicExpeditionParticipation({
        data: rallar.data,
        withParticipationLock: withRelicParticipationLock,
        sendRestCommand: sendRelicCommand,
        fetchSnapshot: fetchRelicSnapshot
    });
    const authority = createRelicAuthorityClientBridge(rallar);
    return {
        withParticipationLock: withRelicParticipationLock,
        data: rallar.data,
        ...createRelicRoomCapabilities(expeditionParticipation),
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
        createRoom: (displayName, joinMode, directoryListing) =>
            changeRelicRoom(expeditionParticipation, () => createRelicRoom(displayName, joinMode, directoryListing)),
        joinRoom: async (roomId, participation) => {
            await changeRelicRoom(
                expeditionParticipation,
                () =>
                    joinRelicRoom({ ...RELIC_ROOM_SCOPE, groupId: roomId }, {
                        ...(participation === 'preserve' ? {} : { participation }),
                        leaveCurrent: true
                    }),
                roomId
            );
        },
        leaveRoom: async (roomId) => {
            await rallar.rooms.leave({ roomRef: { ...RELIC_ROOM_SCOPE, groupId: roomId } });
        },
        initializeGame: (roomId) => initializeRelicGame(roomId),
        fetchSnapshot: (roomId) => fetchRelicSnapshot(roomId),
        sendWsCommand: (roomId, command) => sendRelicWsCommand(rallar, roomId, command),
        sendRestCommand: sendRelicCommand,
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

function withRelicParticipationLock<T>(roomId: string, sessionId: string, run: () => Promise<T>): Promise<T> {
    return navigator.locks.request(`relic-expedition:${JSON.stringify([roomId, sessionId])}`, run);
}

/** A second tab must not implicitly leave a hunter whose Join was committed after this tab's last snapshot. */
async function changeRelicRoom<T>(
    participation: RelicExpeditionParticipation,
    change: () => Promise<T>,
    destinationRoomId?: string
): Promise<T> {
    const session = rallar.session();
    const roomId = rallar.rooms.state().currentRoomId;
    if (!session || !roomId) {
        return await change();
    }
    return await withRelicParticipationLock(roomId, session.sessionId, async () => {
        if (rallar.session()?.sessionId !== session.sessionId || rallar.rooms.state().currentRoomId !== roomId) {
            throw new Error('Room entry changed while checking expedition participation.');
        }
        await participation.reconcile(roomId, session.sessionId);
        const snapshot = await fetchRelicSnapshot(roomId);
        if (rallar.session()?.sessionId !== session.sessionId || rallar.rooms.state().currentRoomId !== roomId) {
            throw new Error('Room entry changed while checking expedition participation.');
        }
        if (roomId !== destinationRoomId && hasUnfinishedRelicParticipation(snapshot, session.sessionId)) {
            throw new Error('Use Leave expedition before entering or watching another expedition.');
        }
        return await change();
    });
}

function createRelicRoomCapabilities(
    expeditionParticipation: RelicExpeditionParticipation
): Pick<RelicHuntersRuntime.Dependencies, 'roomEntry' | 'recentRooms' | 'roomMove' | 'directory'> {
    const roomEntry = RallarRoomEntry.createBrowser({
        auth: rallar.auth,
        session: () => rallar.session(),
        rooms: {
            onChange: (handler, options) => rallar.rooms.onChange(handler, options),
            join: (roomRef, options) =>
                changeRelicRoom(expeditionParticipation, () => joinRelicRoom(roomRef, options), roomRef.groupId)
        }
    }, { scope: RELIC_ROOM_SCOPE });
    const recentRooms = RallarRecentRooms.createBrowser(rallar, roomEntry, { scope: RELIC_ROOM_SCOPE });
    return {
        roomEntry,
        recentRooms,
        roomMove: RallarRoomMove.createBrowser(
            rallar,
            (destination, run) => changeRelicRoom(expeditionParticipation, run, destination.groupId),
            { scope: RELIC_ROOM_SCOPE, refreshIntervalMs: 15000 }
        ),
        directory: RallarRoomDirectory.createBrowser(rallar, {
            scope: RELIC_ROOM_SCOPE,
            request: { kind: 'room', q: 'relic hunters', limit: 50, includeEmpty: false, order: 'online-members' },
            refreshIntervalMs: 30_000,
            timeoutMs: 10_000,
            maxAttempts: 1
        })
    };
}
