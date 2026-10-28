// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arenaMembershipSnapshot, ArenaRuntimeTestHarness, mockMatch, mockRallar, session, waitForState } from './arena-runtime-test-harness.ts';

import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { isArenaPlayerSession, isArenaSpectator } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/arena-participation.ts';
import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import { createInitialLoadoutState, createInitialVitalsState } from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';

const arena = new ArenaRuntimeTestHarness();
beforeEach(() => arena.reset());
afterEach(() => arena.dispose());

function spectatingSnapshot(): GroupSnapshot {
    const snapshot = arenaMembershipSnapshot();
    return { ...snapshot, members: snapshot.members.map((member) => member.principalId === session.clientId ? { ...member, role: 'spectator' } : member) };
}

function installMembership(snapshot: GroupSnapshot): void {
    const state = {
        ...mockRallar.rooms.state(),
        currentRoom: snapshot,
        rooms: [{ roomId: snapshot.group.groupId, name: 'AR Eye Hunter Arena: spectator fixture', snapshot }]
    };
    mockRallar.rooms.state.mockReturnValue(state);
    mockRallar.start.mockResolvedValue({ session, connected: true, roomState: state });
}

describe('arena spectator participation', () => {
    it('renders before room repository initialization and adopts the hydrated role after startup', async () => {
        const state = mockRallar.rooms.state();
        const startup = Promise.withResolvers<void>();
        let ready = false;
        mockRallar.rooms.state.mockImplementation(() => {
            if (!ready) {
                throw new Error('Room repository is not initialized');
            }
            return state;
        });
        mockRallar.start.mockImplementation(async () => {
            await startup.promise;
            ready = true;
            return { session, connected: true, roomState: state };
        });
        await arena.render();
        expect(arena.current?.connectionState).toBe('connecting');
        await act(async () => startup.resolve());
        await waitForState(() => arena.current?.connectionState === 'connected');
        expect(arena.current?.spectating).toBe(false);
    });

    it('binds a live session to active player membership and excludes spectators and expired presence', () => {
        const snapshot = spectatingSnapshot();
        expect(isArenaSpectator(snapshot, session.clientId)).toBe(true);
        expect(isArenaPlayerSession(snapshot, session.sessionId, Date.now())).toBe(false);
        expect(isArenaPlayerSession(snapshot, 'peer-1', Date.now())).toBe(true);
        expect(isArenaPlayerSession(snapshot, 'forged', Date.now())).toBe(false);
        expect(isArenaPlayerSession(snapshot, 'peer-1', Date.now() + 120_000)).toBe(false);
        const departed = { ...snapshot, members: snapshot.members.filter((member) => member.principalId !== 'peer-1') };
        expect(isArenaPlayerSession(departed, 'peer-1', Date.now())).toBe(false);
    });

    it('rejects a live player session in an expired or archived arena', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
        const snapshot = arenaMembershipSnapshot();
        const nowEpochMs = Date.now();
        expect(isArenaPlayerSession(
            {
                ...snapshot,
                group: { ...snapshot.group, expiresAtEpochMs: nowEpochMs }
            },
            'peer-1',
            nowEpochMs
        )).toBe(false);
        expect(isArenaPlayerSession(
            {
                ...snapshot,
                group: { ...snapshot.group, status: 'archived', archived: snapshot.group.created, deleted: null }
            },
            'peer-1',
            nowEpochMs
        )).toBe(false);
        vi.useRealTimers();
    });

    it('keeps synchronization while watcher controls cannot report capability, appoint, or send a player pose', async () => {
        installMembership(spectatingSnapshot());
        await arena.render();
        await waitForState(() => arena.current?.networkEnabled === true);
        expect(arena.current?.spectating).toBe(true);
        await act(async () => {
            await arena.current?.appointSelfAsDirector();
            await arena.current?.startArenaMatch(60_000);
            arena.current?.sendPose({ position: [0, 2, 0], rotation: [0, 0, 0], score: 0, seq: 1, sentAtEpochMs: Date.now() });
        });
        expect(mockMatch.requestSync.mock.calls.length).toBeGreaterThan(0);
        expect(mockMatch.reportCapability.mock.calls).toEqual([]);
        expect(mockMatch.appointIfElected.mock.calls).toEqual([]);
        expect(mockMatch.sendPresence.mock.calls).toEqual([]);
        expect(mockMatch.sendInput.mock.calls).toEqual([]);
        expect(mockMatch.sendIntent.mock.calls).toEqual([]);
    });

    it('rejects watcher pose ingress and fences an old match after an in-place role change', async () => {
        await arena.render();
        await waitForState(() => arena.current?.networkEnabled === true);
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        if (!config?.onPresence) {
            throw new Error('Expected a connected presence receiver');
        }
        const pose = {
            sessionId: session.sessionId,
            username: 'watcher',
            color: '#fff',
            score: 0,
            position: [0, 2, 0] as const,
            rotation: [0, 0, 0] as const,
            seq: 1,
            sentAtEpochMs: Date.now(),
            vitals: createInitialVitalsState(),
            loadout: createInitialLoadoutState()
        };
        installMembership(spectatingSnapshot());
        await act(async () => {
            await config.onPresence?.(
                createRallarGameEnvelope({
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'presence',
                    directorEpoch: 1,
                    roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'players', groupId: 'arena-1' },
                    senderId: session.sessionId,
                    seq: 1,
                    sentAtEpochMs: Date.now(),
                    payload: { protocol: 'ar-eye-hunter.v1', kind: 'player-pose', pose }
                })
            );
            for (const [listener] of mockRallar.rooms.onChange.mock.calls) {
                listener(mockRallar.rooms.state());
            }
        });
        await waitForState(() => arena.current?.spectating === true);
        expect(arena.current?.remotePlayers.size).toBe(0);
        expect(vi.mocked(createArenaRallarGameMatch).mock.calls.length).toBeGreaterThan(1);
        await act(async () =>
            config.onPresence?.(
                createRallarGameEnvelope({
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'presence',
                    directorEpoch: 1,
                    roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'players', groupId: 'arena-1' },
                    senderId: 'peer-1',
                    seq: 2,
                    sentAtEpochMs: Date.now(),
                    payload: { protocol: 'ar-eye-hunter.v1', kind: 'player-pose', pose: { ...pose, sessionId: 'peer-1' } }
                })
            )
        );
        expect(arena.current?.remotePlayers.size).toBe(0);
    });
});
