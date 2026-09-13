// @vitest-environment happy-dom
import { act, type SetStateAction } from 'react';
import {
    arenaRoomRef,
    ArenaRuntimeTestHarness,
    arenaSnapshot,
    emitAuthState,
    freshDirectorStatus,
    mockMatch,
    mockRallar,
    session,
    waitForState
} from './arena-runtime-test-harness.ts';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarRoomRealtimeJsonDefaults } from '@shared-web/browser/rallar-realtime.ts';

import { createRallarGameEnvelope, type RallarGameMatchStatus } from '@shared-web/game/mod.ts';

import type { GroupRef } from '@shared/api/group-types.ts';
import { validateRallarJsonPayload } from '@shared/api/rallar-validation.ts';
import {
    createArenaMatchRuntime,
    type ArenaMatchRuntimeInput
} from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/match/create-arena-match-runtime.ts';
import { acceptArenaMatchIntent } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/match/handlers/accept-arena-match-intent.ts';
import type { ArenaPeerShotMessage } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/messages/use-arena-peer-message-handlers.ts';

import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import {
    createInitialArenaState,
    createInitialVitalsState,
    spawnWeaponPickup,
    toArenaSnapshot,
    upsertPlayerPose
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type { ArenaEvent, ArenaSnapshot, GameRealtimeMessage, PlayerPose } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

interface AcceptedIntentFixture {
    readonly nowEpochMs: number;
    readonly snapshot: ArenaSnapshot;
    readonly message: GameRealtimeMessage;
}

describe('arena game realtime acceptance and egress', () => {
    const arena = new ArenaRuntimeTestHarness();
    beforeEach(() => arena.reset());
    afterEach(() => arena.dispose());

    it('still publishes the local director pose through Rallar Game presence', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockMatch.status.mockReturnValue(localDirectorMatchStatus());

        await act(async () => {
            arena.current?.sendPose({
                position: [1, 2, 3],
                rotation: [0, 0.5, 0],
                velocity: [0.1, 0, 0.2],
                score: 12,
                combo: 2,
                seq: 7,
                sentAtEpochMs: 123
            });
        });

        expect(mockMatch.sendInput).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'player-pose-intent',
            pose: expect.objectContaining({
                sessionId: session.sessionId
            })
        }));
        expect(mockMatch.sendPresence).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'player-pose',
                pose: expect.objectContaining({
                    sessionId: session.sessionId,
                    position: [1, 2, 3]
                })
            }),
            expect.objectContaining({
                laneId: 'motion',
                key: `pose:${session.sessionId}`,
                maxAgeMs: 250,
                openTimeoutMs: 1500
            })
        );
        expect(mockRallar.realtime.sendJson).not.toHaveBeenCalledWith(expect.objectContaining({
            laneId: 'motion',
            key: `pose:${session.sessionId}`
        }));
    });

    it('sends Rallar JSON-compatible pose envelopes when optional vitals are unset', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockMatch.status.mockReturnValue(localDirectorMatchStatus());

        await act(async () => {
            arena.current?.sendPose({
                position: [1, 2, 3],
                rotation: [0, 0.5, 0],
                score: 12,
                seq: 8,
                sentAtEpochMs: 456,
                vitals: {
                    ...createInitialVitalsState(),
                    deadUntilEpochMs: undefined
                }
            });
        });

        const input = mockMatch.sendInput.mock.calls[0]?.[0];
        const presence = mockMatch.sendPresence.mock.calls[0]?.[0];

        expect(validateRallarJsonPayload(input, { path: '$.payload' }).ok).toBe(true);
        expect(validateRallarJsonPayload(presence, { path: '$.payload' }).ok).toBe(true);
    });

    it('deduplicates reliable director snapshots by revision', async () => {
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockMatch.publishSnapshot.mockClear();
        const snapshot = arenaSnapshot(10);

        await act(async () => {
            arena.current?.publishArenaSnapshot(snapshot);
            arena.current?.publishArenaSnapshot(snapshot);
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);
        expect(mockMatch.publishSnapshot).toHaveBeenCalledWith(
            snapshot,
            { reliable: true }
        );
    });

    it('coalesces rapid reliable director snapshots to the latest revision', async () => {
        vi.useFakeTimers();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockMatch.publishSnapshot.mockClear();

        await act(async () => {
            arena.current?.publishArenaSnapshot(arenaSnapshot(20));
            arena.current?.publishArenaSnapshot(arenaSnapshot(21));
            arena.current?.publishArenaSnapshot(arenaSnapshot(22));
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);
        expect(mockMatch.publishSnapshot.mock.calls[0]?.[0]).toMatchObject({
            revision: 20
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(999);
        });
        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(2);
        expect(mockMatch.publishSnapshot.mock.calls[1]?.[0]).toMatchObject({
            revision: 22
        });
        expect(mockMatch.publishSnapshot.mock.calls[1]?.[1]).toEqual({ reliable: true });
    });

    it('cancels pending reliable director snapshots when the network generation resets', async () => {
        vi.useFakeTimers();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockMatch.publishSnapshot.mockClear();

        await act(async () => {
            arena.current?.publishArenaSnapshot(arenaSnapshot(30));
            arena.current?.publishArenaSnapshot(arenaSnapshot(31));
        });
        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);

        await emitAuthState({
            authenticated: false,
            reason: 'expired'
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);
    });

    it.each([
        { name: 'application', roomRef: { ...arenaRoomRef, applicationId: 'another-app' } },
        { name: 'workspace', roomRef: { ...arenaRoomRef, workspaceId: 'another-workspace' } },
        { name: 'group', roomRef: { ...arenaRoomRef, groupId: 'another-room' } },
        { name: 'missing scope', roomRef: undefined }
    ])('ignores raw accepted shots with wrong $name', async ({ roomRef }) => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => receive?.({ peerId: 'peer-1', data: peerShotMessage(roomRef) }));
        expect(arena.current?.remoteShots).toEqual([]);
    });

    it('keeps same-room accepted shots but rejects an old subscription after replacement and network end', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const oldReceive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => oldReceive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) }));
        expect(arena.current?.remoteShots.map((shot) => shot.id)).toEqual(['peer-1:1:3']);
        const nextRoomRef = { ...arenaRoomRef, groupId: 'arena-2' };
        const nextRoom = { rooms: [], currentRoomId: 'arena-2', currentRoomRef: nextRoomRef };
        mockRallar.rooms.state.mockReturnValue(nextRoom);
        mockRallar.rooms.createAndSwitch.mockResolvedValue({ group: nextRoomRef });
        mockRallar.rooms.refresh.mockResolvedValue(nextRoom);
        await act(async () => arena.current?.createArenaRoom());
        await act(async () => {
            oldReceive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) });
            oldReceive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) });
        });
        expect(arena.current?.remoteShots).toEqual([]);
        const nextReceive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => nextReceive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) }));
        expect(arena.current?.remoteShots.map((shot) => shot.id)).toEqual(['peer-1:1:3']);
        await emitAuthState({ authenticated: false, reason: 'expired' });
        await act(async () => nextReceive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) }));
        expect(arena.current?.remoteShots).toEqual([]);
    });

    it('ignores raw accepted shots after the network ends even if a listener fires late', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await emitAuthState({ authenticated: false, reason: 'expired' });
        await act(async () => receive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) }));
        expect(arena.current?.remoteShots).toEqual([]);
    });

    it('accepts the current full scope when room IDs match after scope replacement', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        const nextRoomRef = { ...arenaRoomRef, workspaceId: 'next-workspace' };
        mockRallar.rooms.state.mockReturnValue({ rooms: [], currentRoomId: 'arena-1', currentRoomRef: nextRoomRef });
        await act(async () => {
            receive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) });
            receive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) });
        });
        expect(arena.current?.remoteShots.map((shot) => shot.id)).toEqual(['peer-1:1:3']);
    });

    it('requires every room identity field even in an empty workspace scope', async () => {
        const emptyWorkspace = { ...arenaRoomRef, workspaceId: '' };
        mockRallar.rooms.state.mockReturnValue({ rooms: [], currentRoomId: 'arena-1', currentRoomRef: emptyWorkspace });
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () =>
            receive?.({
                peerId: 'peer-1',
                data: {
                    ...peerShotMessage(emptyWorkspace),
                    roomRef: { applicationId: arenaRoomRef.applicationId, groupId: arenaRoomRef.groupId }
                }
            })
        );
        expect(arena.current?.remoteShots).toEqual([]);
    });

    it('rejects a raw accepted shot whose shooter is not its sending peer', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => receive?.({ peerId: 'another-peer', data: peerShotMessage(arenaRoomRef) }));
        expect(arena.current?.remoteShots).toEqual([]);
    });

    it('puts current full room identity on the actual accepted-shot fallback payload', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const outgoing: ArenaPeerShotMessage[] = [];
        const targets: RallarRoomRealtimeJsonDefaults[] = [];
        mockRallar.realtime.room.mockImplementation((target: RallarRoomRealtimeJsonDefaults) => {
            targets.push(target);
            return {
                send: async (payload: ArenaPeerShotMessage) => {
                    outgoing.push(payload);
                    return { status: 'sent', peerIds: ['peer-1'], desiredPeerIds: ['peer-1'], results: [], transport: 'rtc', laneId: 'combat' };
                }
            };
        });
        const message = peerShotMessage(arenaRoomRef);
        await act(async () => arena.current?.sendShot(message.accepted.shot, message.accepted));
        expect(targets).toEqual([{ roomRef: arenaRoomRef, laneId: 'combat', openTimeoutMs: 1500 }]);
        expect(outgoing).toEqual([{
            ...message,
            accepted: {
                ...message.accepted,
                shot: { ...message.accepted.shot, sessionId: session.sessionId, username: session.username, color: expect.any(String) }
            }
        }]);
    });

    it.each(['hit', 'pickup'] as const)('applies the local director %s intent through its owning receiver', async (kind) => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        mockMatch.status.mockReturnValueOnce(localDirectorMatchStatus());
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind, Date.now(), session.sessionId);
        const published = Promise.withResolvers<ArenaSnapshot>();
        await act(async () => arena.current?.publishArenaSnapshot(fixture.snapshot));
        mockMatch.sendIntent.mockImplementationOnce(async (message) => {
            await config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: session.sessionId,
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: message
            }));
            return { status: 'sent', transport: 'local' };
        });
        mockMatch.publishSnapshot.mockImplementationOnce(async (snapshot: ArenaSnapshot) => {
            published.resolve(snapshot);
            return { status: 'sent' };
        });
        await act(async () => {
            if (fixture.message.kind === 'player-hit-intent') {
                arena.current?.sendPlayerHit(fixture.message.intent);
            }
            else if (fixture.message.kind === 'pickup-intent') {
                arena.current?.sendPickupIntent(fixture.message.intent);
            }
            await published.promise;
        });
        const snapshot = await published.promise;
        expect(snapshot.roomId).toBe('arena-1');
        expect(snapshot.revision).toBeGreaterThan(fixture.snapshot.revision);
        expect(
            kind === 'hit'
                ? arena.current?.remotePlayerHits[0]?.intent.shot.sessionId
                : arena.current?.pickupAcceptances[0]?.player.sessionId
        ).toBe(session.sessionId);
    });

    it('awaits local match-start acceptance through the canonical intent receiver', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        mockMatch.status.mockReturnValue(localDirectorMatchStatus());
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        await act(async () => arena.current?.publishArenaSnapshot(arenaSnapshot(1)));
        const published: ArenaSnapshot[] = [];
        mockMatch.sendIntent.mockImplementationOnce(async (payload) => {
            await config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: session.sessionId,
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: 1000,
                payload
            }));
            return { status: 'sent', transport: 'local' };
        });
        mockMatch.publishSnapshot.mockImplementationOnce(async (snapshot: ArenaSnapshot) => {
            published.push(snapshot);
            return { status: 'sent' };
        });
        await act(async () => arena.current?.startArenaMatch(60_000));
        expect(arena.current?.arenaSnapshot?.match).toMatchObject({ durationMs: 60_000, status: 'active' });
        expect(published.map((snapshot) => snapshot.match)).toEqual([arena.current?.arenaSnapshot?.match]);
    });

    it.each(['hit', 'pickup'] as const)('rejects a current-room %s intent against a retained prior-room snapshot', async (kind) => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind, Date.now());
        const previous = { ...fixture.snapshot, roomId: 'prior-room' };
        await act(async () => arena.current?.publishArenaSnapshot(previous));
        await act(async () =>
            config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: fixture.message
            }))
        );
        expect(arena.current?.arenaSnapshot).toEqual(previous);
        expect(arena.current?.remotePlayerHits).toEqual([]);
        expect(arena.current?.pickupAcceptances).toEqual([]);
    });

    it.each(
        [
            { kind: 'hit', end: 'replacement' },
            { kind: 'pickup', end: 'replacement' },
            { kind: 'hit', end: 'network-end' },
            { kind: 'pickup', end: 'network-end' }
        ] as const
    )('does not publish an accepted $kind snapshot after $end', async ({ kind, end }) => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind, Date.now());
        await act(async () => arena.current?.publishArenaSnapshot(fixture.snapshot));
        const eventStarted = Promise.withResolvers<void>();
        const eventDone = Promise.withResolvers<void>();
        const publishedSnapshots: ArenaSnapshot[] = [];
        mockMatch.publishEvent.mockImplementationOnce(() => {
            eventStarted.resolve();
            return eventDone.promise;
        });
        mockMatch.publishSnapshot.mockImplementation(async (snapshot: ArenaSnapshot) => {
            publishedSnapshots.push(snapshot);
            return { status: 'sent' };
        });
        let completion: void | Promise<void>;
        await act(async () => {
            completion = config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: fixture.message
            }));
            await eventStarted.promise;
        });
        if (end === 'replacement') {
            mockRallar.rooms.createAndSwitch.mockResolvedValue({ group: { groupId: 'arena-2' } });
            mockRallar.rooms.refresh.mockResolvedValue({ rooms: [], currentRoomId: 'arena-2' });
            await act(async () => arena.current?.createArenaRoom());
        }
        else {
            await emitAuthState({ authenticated: false, reason: 'expired' });
        }
        await act(async () => {
            eventDone.resolve();
            await completion;
        });
        expect(publishedSnapshots.map((snapshot) => snapshot.roomId)).toEqual([]);
        mockMatch.publishSnapshot.mockReset();
    });

    it.each(['hit', 'pickup'] as const)('fences accepted %s continuation when its network ends with its match still installed', async (kind) => {
        const fixture = acceptedIntentFixture(kind, Date.now());
        const eventDone = Promise.withResolvers<void>();
        const eventStarted = Promise.withResolvers<void>();
        const publishedSnapshots: string[] = [];
        let networkEnabled = true;
        mockMatch.publishEvent.mockImplementationOnce(() => {
            eventStarted.resolve();
            return eventDone.promise;
        });
        mockMatch.publishSnapshot.mockImplementation(async (snapshot: ArenaSnapshot) => {
            publishedSnapshots.push(snapshot.roomId ?? '');
            return { status: 'sent' };
        });
        const input: ArenaMatchRuntimeInput = {
            nowMs: () => fixture.nowEpochMs,
            arenaMatchRef: { current: undefined },
            arenaSnapshotRef: { current: fixture.snapshot },
            roomIdRef: { current: 'arena-1' },
            isCurrentNetworkGeneration: () => networkEnabled,
            acceptDirectorOutput: () => {},
            acceptPeerShot: () => {},
            acceptMatchStartIntent: async () => {},
            acceptMotionMessage: () => {},
            acceptPickup: () => {},
            acceptPlayerHit: () => {},
            setActiveEvent: () => {},
            setArenaSnapshot: () => {},
            setRemoteEvents: () => {}
        };
        input.arenaMatchRef.current = createArenaMatchRuntime(input, 1, 'arena-1');
        const completion = acceptArenaMatchIntent(
            input,
            1,
            createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: fixture.message
            })
        );
        await eventStarted.promise;
        networkEnabled = false;
        eventDone.resolve();
        await completion;
        expect(publishedSnapshots).toEqual([]);
        mockMatch.publishSnapshot.mockReset();
    });

    it.each(['snapshot', 'hit', 'pickup'] as const)('keeps deferred %s publication out of a replacement runtime', async (kind) => {
        const fixture = acceptedIntentFixture(kind === 'snapshot' ? 'hit' : kind, Date.now());
        let networkEnabled = true;
        let snapshot: ArenaSnapshot | undefined = fixture.snapshot;
        let activeEvent = fixture.snapshot.activeEvent;
        let events = fixture.snapshot.events;
        const pendingSnapshots: SetStateAction<ArenaSnapshot | undefined>[] = [];
        const pendingActiveEvents: SetStateAction<typeof activeEvent>[] = [];
        const pendingEvents: SetStateAction<typeof events>[] = [];
        const input: ArenaMatchRuntimeInput = {
            nowMs: () => fixture.nowEpochMs,
            arenaMatchRef: { current: undefined },
            arenaSnapshotRef: { current: fixture.snapshot },
            roomIdRef: { current: 'arena-1' },
            isCurrentNetworkGeneration: () => networkEnabled,
            acceptDirectorOutput: () => {},
            acceptPeerShot: () => {},
            acceptMatchStartIntent: async () => {},
            acceptMotionMessage: () => {},
            acceptPickup: () => {},
            acceptPlayerHit: () => {},
            setActiveEvent: (update) => pendingActiveEvents.push(update),
            setArenaSnapshot: (update) => pendingSnapshots.push(update),
            setRemoteEvents: (update) => pendingEvents.push(update)
        };
        input.arenaMatchRef.current = createArenaMatchRuntime(input, 1, 'arena-1');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        if (!config?.onSnapshot || !config.onIntent) {
            throw new Error('The arena runtime did not install its incoming callbacks.');
        }
        if (kind === 'snapshot') {
            const event: ArenaEvent = {
                id: 'previous-room-event',
                kind: 'spawn-eye',
                source: 'director',
                startsAtEpochMs: fixture.nowEpochMs,
                expiresAtEpochMs: fixture.nowEpochMs + 4000,
                revision: fixture.snapshot.revision
            };
            await config.onSnapshot(
                createRallarGameEnvelope({
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'snapshot',
                    roomId: 'arena-1',
                    senderId: 'peer-1',
                    seq: 1,
                    directorEpoch: 1,
                    sentAtEpochMs: fixture.nowEpochMs,
                    payload: { ...fixture.snapshot, activeEvent: event, events: [event] }
                })
            );
        }
        else {
            await config.onIntent(
                createRallarGameEnvelope({
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'intent',
                    roomId: 'arena-1',
                    senderId: 'peer-1',
                    seq: 1,
                    directorEpoch: 1,
                    sentAtEpochMs: fixture.nowEpochMs,
                    payload: fixture.message
                })
            );
        }
        networkEnabled = false;
        const replacement = toArenaSnapshot(createInitialArenaState(12, fixture.nowEpochMs), 'replacement', fixture.nowEpochMs);
        snapshot = replacement;
        activeEvent = undefined;
        events = [];
        input.arenaSnapshotRef.current = replacement;
        input.roomIdRef.current = 'replacement';
        for (const update of pendingSnapshots) {
            snapshot = typeof update === 'function' ? update(snapshot) : update;
        }
        for (const update of pendingActiveEvents) {
            activeEvent = typeof update === 'function' ? update(activeEvent) : update;
        }
        for (const update of pendingEvents) {
            events = typeof update === 'function' ? update(events) : update;
        }
        expect(snapshot).toBe(replacement);
        expect(input.arenaSnapshotRef.current).toBe(replacement);
        expect(activeEvent).toBeUndefined();
        expect(events).toEqual([]);
    });
});

function localDirectorMatchStatus(): RallarGameMatchStatus {
    return {
        phase: 'active',
        protocol: 'ar-eye-hunter.v1',
        topicId: 'room.ar-eye-hunter.director',
        roomId: 'arena-1',
        localPeerId: session.sessionId,
        directorPeerId: session.sessionId,
        directorEpoch: 1,
        directorIsFresh: true,
        directorAuthority: 'active',
        egress: { reliable: 'ready', realtime: 'empty' },
        recovery: { status: 'idle' },
        started: true,
        stopped: false,
        updatedAtEpochMs: 2
    };
}

function acceptedIntentFixture(kind: 'hit' | 'pickup', nowEpochMs: number, peerId = 'peer-1'): AcceptedIntentFixture {
    const initial = spawnWeaponPickup(createInitialArenaState(44, nowEpochMs), nowEpochMs, 'audit-pea-shooter');
    const pickup = initial.pickups[0];
    const player: PlayerPose = {
        sessionId: peerId,
        username: 'peer',
        color: '#00ffaa',
        position: kind === 'pickup' ? pickup.position : [0, 1.72, 0],
        rotation: [0, 0, 0],
        vitals: createInitialVitalsState(),
        score: 0,
        seq: 1,
        sentAtEpochMs: nowEpochMs
    };
    const state = upsertPlayerPose(upsertPlayerPose(initial, player, nowEpochMs), {
        ...player,
        sessionId: 'target',
        position: [0, 1.72, 9]
    }, nowEpochMs);
    const message: GameRealtimeMessage = kind === 'pickup'
        ? {
            protocol: 'ar-eye-hunter.v1',
            kind: 'pickup-intent',
            intent: { pickupId: pickup.id, sessionId: peerId, position: pickup.position, seq: 1, sentAtEpochMs: nowEpochMs }
        }
        : {
            protocol: 'ar-eye-hunter.v1',
            kind: 'player-hit-intent',
            intent: {
                shot: {
                    sessionId: peerId,
                    username: 'peer',
                    color: '#00ffaa',
                    origin: [0, 1.72, 0],
                    direction: [0, 0, 1],
                    seq: 1,
                    sentAtEpochMs: nowEpochMs
                },
                targetSessionId: 'target',
                predictedImpact: [0, 1.72, 9],
                sentAtEpochMs: nowEpochMs
            }
        };
    return { nowEpochMs, snapshot: toArenaSnapshot(state, 'arena-1', nowEpochMs), message };
}

function peerShotMessage(roomRef: GroupRef | undefined) {
    return {
        protocol: 'ar-eye-hunter.v1' as const,
        kind: 'director-shot-accepted' as const,
        roomRef,
        accepted: {
            shot: {
                sessionId: 'peer-1',
                username: 'peer',
                color: '#00ffaa',
                origin: [0, 2, 0] as const,
                direction: [0, 0, 1] as const,
                seq: 1,
                sentAtEpochMs: 1000
            },
            hit: true,
            targetId: 'eye-1',
            impact: [0, 2, 4] as const,
            scoreDelta: 120,
            combo: 2,
            multiplier: 1,
            overdrive: 20,
            revision: 3,
            acceptedAtEpochMs: 1000
        }
    };
}
