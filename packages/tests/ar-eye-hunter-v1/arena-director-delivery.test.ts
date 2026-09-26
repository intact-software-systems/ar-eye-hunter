// @vitest-environment happy-dom
import {
    ArenaRuntimeTestHarness,
    emitAuthState,
    emptyPeerReadiness,
    freshDirectorStatus,
    mockMatch,
    mockRallar,
    session,
    waitForState
} from './arena-runtime-test-harness.ts';

import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';

import { createRallarGameEnvelope, type RallarGameMatchStatus, type RallarGamePeerReadiness } from '@shared-web/game/mod.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import {
    createArenaRallarGameMatch,
    type ArenaRallarGameMatchHandle
} from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import {
    createInitialArenaState,
    createInitialVitalsState,
    finishArenaMatchIfDue,
    startArenaMatch,
    toArenaSnapshot
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type { ArenaSnapshot, MatchEndedAccepted, PlayerPose } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

import { createMessageDelivery, type MessageDeliveryFixture } from '../shared-web/messages/test-message-delivery.ts';

describe('arena director delivery and appointment', () => {
    const arena = new ArenaRuntimeTestHarness();
    beforeEach(() => arena.reset());
    afterEach(() => arena.dispose());

    it.each(
        [
            [undefined, 'pending', undefined],
            [{ kind: 'admitted', durable: false, queuedAttempts: 1 }, 'pending', undefined],
            [{ kind: 'admitted', durable: false, queuedAttempts: 0 }, 'pending', undefined],
            [{ kind: 'deferred', reason: 'not-yet-in-sync', detail: 'waiting for authority' }, 'pending', undefined],
            [{ kind: 'refused', reason: 'unauthorized', detail: 'membership denied' }, 'failed', 'membership denied'],
            [{ kind: 'failed', detail: 'queue unavailable' }, 'failed', 'queue unavailable'],
            [{ kind: 'expired', detail: 'deadline elapsed' }, 'expired', 'deadline elapsed'],
            [{ kind: 'superseded', detail: 'newer report' }, 'superseded', 'newer report']
        ] satisfies readonly [ALDeliveryAdmissionVerdict | undefined, string, string | undefined][]
    )('observes initial capability delivery %j', async (verdict, state, reason) => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const delivery = createMessageDelivery('ws', verdict);
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        await act(async () => {
            await arena.current?.appointSelfAsDirector();
        });
        expect(arena.current?.directorAttempt).toMatchObject({ status: 'not-elected', capabilityDelivery: { state, reason } });
    });

    it('keeps delivery observation after appointment completion and preserves both outcomes', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const delivery = createMessageDelivery('ws', undefined);
        const appointment = Promise.withResolvers<Awaited<ReturnType<ArenaRallarGameMatchHandle['appointIfElected']>>>();
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        mockMatch.appointIfElected.mockReturnValueOnce(appointment.promise);
        let completion: Promise<void> | undefined;
        await act(async () => {
            completion = arena.current?.appointSelfAsDirector();
        });
        expect(arena.current?.directorAttempt).toMatchObject({ status: 'pending', capabilityDelivery: { state: 'pending' } });
        await act(async () => {
            delivery.registry.record({
                kind: 'attempt-settled',
                msgId: delivery.handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                attemptId: 'ws-attempt',
                outcome: 'not-ready',
                submissionAttempted: false,
                detail: 'connecting',
                willRetry: true
            });
        });
        expect(arena.current?.directorAttempt).toMatchObject({ status: 'pending', capabilityDelivery: { state: 'pending' } });
        await act(async () => {
            appointment.resolve({ status: 'failed', election: { candidates: [], nowEpochMs: 2, capabilityTtlMs: 10_000 }, reason: 'appointment denied' });
            await completion;
        });
        expect(arena.current?.directorAttempt).toMatchObject({ status: 'failed', reason: 'appointment denied', capabilityDelivery: { state: 'pending' } });
        const finishedAtEpochMs = arena.current?.directorAttempt.finishedAtEpochMs;
        await act(async () => {
            delivery.registry.releaseAll();
        });
        expect(arena.current?.directorAttempt).toMatchObject({
            status: 'failed',
            reason: 'appointment denied',
            finishedAtEpochMs,
            capabilityDelivery: { state: 'unobservable' }
        });
    });

    it('fences replaced reports and releases delivery listeners on replacement and network end', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const report = Promise.withResolvers<Awaited<ReturnType<ArenaRallarGameMatchHandle['reportCapability']>>>();
        mockMatch.reportCapability.mockReturnValueOnce(report.promise);
        let oldCompletion: Promise<void> | undefined;
        await act(async () => {
            oldCompletion = arena.current?.appointSelfAsDirector();
        });
        const delivery = createMessageDelivery('ws', undefined);
        const listeners = new Set<Parameters<RallarMessageHandle['onEvent']>[0]>();
        const originalOnEvent = delivery.handle.onEvent.bind(delivery.handle);
        const callbacks: Parameters<RallarMessageHandle['onEvent']>[0][] = [];
        vi.spyOn(delivery.handle, 'onEvent').mockImplementation((listener) => {
            listeners.add(listener);
            callbacks.push(listener);
            const unsubscribeDelivery = originalOnEvent(listener);
            return () => {
                listeners.delete(listener);
                unsubscribeDelivery();
            };
        });
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        await act(async () => {
            await arena.current?.appointSelfAsDirector();
        });
        expect(listeners.size).toBe(1);
        const replacement = arena.current?.directorAttempt;
        mockMatch.appointIfElected.mockClear();
        await act(async () => {
            report.resolve({ status: 'sent', ws: createMessageDelivery('ws', undefined).handle });
            await oldCompletion;
        });
        expect(arena.current?.directorAttempt).toEqual(replacement);
        expect(mockMatch.appointIfElected).not.toHaveBeenCalled();
        await act(async () => {
            await arena.current?.appointSelfAsDirector();
        });
        expect(listeners.size).toBe(0);
        const latest = arena.current?.directorAttempt;
        await act(async () => {
            callbacks[0](delivery.handle.lifecycle());
        });
        expect(arena.current?.directorAttempt).toEqual(latest);
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        await act(async () => {
            await arena.current?.appointSelfAsDirector();
        });
        expect(listeners.size).toBe(1);
        await emitAuthState({ authenticated: false, reason: 'expired' });
        expect(listeners.size).toBe(0);
        await act(async () => {
            callbacks.at(-1)?.(delivery.handle.lifecycle());
        });
        expect(arena.current?.directorAttempt.status).toBe('idle');
        expect(delivery.handle.lifecycle().state).toBe('submitted');
        vi.restoreAllMocks();
    });

    it('preserves transport confirmation when appointment completes and unsubscribes on unmount', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const delivery = createMessageDelivery('ws', undefined);
        const appointment = Promise.withResolvers<Awaited<ReturnType<ArenaRallarGameMatchHandle['appointIfElected']>>>();
        const originalOnEvent = delivery.handle.onEvent.bind(delivery.handle);
        const listeners = new Set<Parameters<RallarMessageHandle['onEvent']>[0]>();
        vi.spyOn(delivery.handle, 'onEvent').mockImplementation((listener) => {
            listeners.add(listener);
            const unsubscribeDelivery = originalOnEvent(listener);
            return () => {
                listeners.delete(listener);
                unsubscribeDelivery();
            };
        });
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        mockMatch.appointIfElected.mockReturnValueOnce(appointment.promise);
        let completion: Promise<void> | undefined;
        await act(async () => {
            completion = arena.current?.appointSelfAsDirector();
        });
        await act(async () => {
            delivery.registry.record({
                kind: 'attempt-settled',
                msgId: delivery.handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                attemptId: 'ws-attempt',
                outcome: 'sent',
                submissionAttempted: true,
                detail: undefined,
                willRetry: false
            });
        });
        expect(arena.current?.directorAttempt).toMatchObject({ status: 'pending', capabilityDelivery: { state: 'confirmed', evidence: 'transport-accepted' } });
        await act(async () => {
            appointment.resolve({
                status: 'appointed',
                election: { candidates: [], nowEpochMs: 2, capabilityTtlMs: 10_000 },
                directorStatus: freshDirectorStatus()
            });
            await completion;
        });
        expect(arena.current?.directorAttempt).toMatchObject({
            status: 'succeeded',
            capabilityDelivery: { state: 'confirmed', evidence: 'transport-accepted' }
        });
        expect(listeners.size).toBe(1);
        await arena.unmount();
        expect(listeners.size).toBe(0);
        expect(delivery.handle.lifecycle().state).toBe('transport-accepted');
    });

    it('does not appoint after an old capability report resolves across logout', async () => {
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const report = Promise.withResolvers<Awaited<ReturnType<ArenaRallarGameMatchHandle['reportCapability']>>>();
        mockMatch.reportCapability.mockReturnValueOnce(report.promise);
        let completion: Promise<void> | undefined;
        await act(async () => {
            completion = arena.current?.appointSelfAsDirector();
        });
        await emitAuthState({ authenticated: false, reason: 'expired' });
        mockMatch.appointIfElected.mockClear();
        await act(async () => {
            report.resolve({ status: 'sent', ws: createMessageDelivery('ws', undefined).handle });
            await completion;
        });
        expect(arena.current?.directorAttempt.status).toBe('idle');
        expect(mockMatch.appointIfElected).not.toHaveBeenCalled();
    });

    it('records director appointment attempts and exposes transport diagnostics', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');

        expect(arena.current?.directorAttempt).toMatchObject({
            source: 'auto',
            status: 'not-elected',
            reason: 'The local peer is not the elected host.'
        });

        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'failed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000
            },
            reason: 'director write timed out'
        });

        await act(async () => {
            await arena.current?.appointSelfAsDirector();
        });

        expect(arena.current?.directorAttempt).toMatchObject({
            source: 'manual',
            status: 'failed',
            reason: 'director write timed out'
        });

        await act(async () => {
            await arena.current?.refreshDiagnostics({ includeRtcStats: true });
        });

        expect(arena.current?.transportDiagnostics.ws?.readyState).toBe('open');
        expect(arena.current?.transportDiagnostics.rtc?.readyPeerIds).toEqual(['peer-b']);
        expect(arena.current?.transportDiagnostics.rtcDiagnostics?.connectedPeerCount).toBe(1);
        expect(arena.current?.gameDiagnostics?.phase).toBe('starting');
    });

    it('requests solo arena sync immediately after director appointment without waiting for RTC lanes', async () => {
        const laneWait = Promise.withResolvers<RallarGamePeerReadiness>();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'appointed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000
            },
            directorStatus: freshDirectorStatus()
        });
        mockMatch.diagnostics.mockReturnValue({
            generatedAtEpochMs: 1,
            phase: 'active',
            directorIsFresh: true,
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'empty'
            },
            recovery: { status: 'idle' },
            knownPeerIds: [],
            readyPeerIds: [],
            notReadyPeerIds: [],
            capabilityCount: 0,
            rtcPeerCount: 0,
            realtimeHealth: [],
            issues: []
        });
        mockMatch.waitForReadyLanes.mockReturnValueOnce(laneWait.promise);

        await arena.render();
        await waitForState(() => mockMatch.appointIfElected.mock.calls.length > 0);
        await act(async () => {
            await Promise.resolve();
        });

        expect(mockMatch.requestSync).toHaveBeenCalledWith({ reason: 'arena-join' });
        expect(arena.current?.gameDiagnostics).toMatchObject({
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'empty'
            }
        });

        await act(async () => {
            laneWait.resolve(emptyPeerReadiness());
            await laneWait.promise;
        });
    });

    it('auto-appoints regular room members when the owner is offline', async () => {
        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'appointed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000
            },
            directorStatus: freshDirectorStatus()
        });
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            currentRoomId: 'arena-1',
            members: [
                {
                    principalId: session.clientId,
                    username: session.username,
                    role: 'member',
                    status: 'active',
                    isOwner: false,
                    isOnline: true,
                    sessionIds: [session.sessionId]
                }
            ]
        });

        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await waitForState(() => arena.current?.directorAttempt.status === 'succeeded');

        expect(arena.current?.directorAttempt).toMatchObject({
            source: 'auto',
            status: 'succeeded',
            resultStatus: 'appointed'
        });
    });
});

describe('arena match lifecycle delivery', () => {
    const arena = new ArenaRuntimeTestHarness();
    beforeEach(() => arena.reset());
    afterEach(() => arena.dispose());

    it('publishes the match end with a logical receipt that reads acknowledged only when both frozen recipients confirm', async () => {
        const match = createMatchFixture(Date.now());
        const delivery = await renderDirector(arena, match.active);

        await act(async () => arena.current?.publishArenaSnapshot(match.ended));

        expect(mockMatch.publishEvent).toHaveBeenCalledWith(
            { protocol: 'ar-eye-hunter.v1', kind: 'director-match-ended', accepted: match.endedAccepted },
            { ack: 'all-logical-recipients' }
        );
        expect(arena.current?.matchDelivery).toEqual({
            output: 'director-match-ended',
            state: 'queued',
            receiptMode: undefined,
            expectedRecipientPeerIds: [],
            confirmedRecipientPeerIds: [],
            reason: undefined
        });
        await act(async () => recordReceipt(delivery, ['peer-b'], false));
        expect(arena.current?.matchDelivery).toMatchObject({
            state: 'queued',
            receiptMode: 'receiver',
            expectedRecipientPeerIds: ['peer-b', 'peer-c'],
            confirmedRecipientPeerIds: ['peer-b']
        });
        await act(async () => recordReceipt(delivery, ['peer-b', 'peer-c'], true));
        expect(arena.current?.matchDelivery).toMatchObject({ state: 'acknowledged', confirmedRecipientPeerIds: ['peer-b', 'peer-c'] });
    });

    it('keeps a late joiner out of the expected set the receipt froze at admission', async () => {
        const match = createMatchFixture(Date.now());
        const delivery = await renderDirector(arena, match.active);
        await act(async () => arena.current?.publishArenaSnapshot(match.ended));
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            currentRoomId: 'arena-1',
            members: ['peer-b', 'peer-c', 'late-joiner'].map((sessionId) => ({
                principalId: sessionId,
                username: sessionId,
                role: 'member',
                status: 'active',
                isOwner: false,
                isOnline: true,
                sessionIds: [sessionId]
            }))
        });

        await act(async () => recordReceipt(delivery, ['peer-b', 'peer-c'], true));

        expect(arena.current?.matchDelivery).toMatchObject({
            state: 'acknowledged',
            expectedRecipientPeerIds: ['peer-b', 'peer-c'],
            confirmedRecipientPeerIds: ['peer-b', 'peer-c']
        });
    });

    it('publishes the match end once per completed match', async () => {
        const match = createMatchFixture(Date.now());
        await renderDirector(arena, match.active);
        await act(async () => arena.current?.publishArenaSnapshot(match.ended));
        await act(async () => arena.current?.publishArenaSnapshot({ ...match.ended, revision: match.ended.revision + 1 }));
        expect(mockMatch.publishEvent).toHaveBeenCalledTimes(1);
    });

    it('never publishes the match end from a client that is not the director', async () => {
        const match = createMatchFixture(Date.now());
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await act(async () => arena.current?.publishArenaSnapshot(match.active));
        await act(async () => arena.current?.publishArenaSnapshot(match.ended));
        expect(mockMatch.publishEvent).not.toHaveBeenCalled();
        expect(arena.current?.matchDelivery).toBeUndefined();
    });

    it('publishes the match start with a logical receipt and keeps high-rate outputs best effort', async () => {
        const nowEpochMs = Date.now();
        const delivery = await renderDirector(arena, toArenaSnapshot(createInitialArenaState(44, nowEpochMs), 'arena-1', nowEpochMs));
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        mockMatch.sendIntent.mockImplementationOnce(async (payload) => {
            await config?.onIntent?.(directorEnvelope(payload, nowEpochMs));
            return { status: 'sent', transport: 'local' };
        });

        await act(async () => arena.current?.startArenaMatch(60_000));

        expect(mockMatch.publishEvent).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'director-match-started' }),
            { ack: 'all-logical-recipients' }
        );
        expect(arena.current?.matchDelivery).toMatchObject({ output: 'director-match-started', state: 'queued' });
        expect(delivery.handle.lifecycle().ackMode).toBe('all-logical-recipients');
        const pose: PlayerPose = {
            sessionId: 'peer-b',
            username: 'peer-b',
            color: '#00ffaa',
            position: [0, 1.72, 0],
            rotation: [0, 0, 0],
            vitals: createInitialVitalsState(),
            score: 0,
            seq: 1,
            sentAtEpochMs: nowEpochMs
        };
        await act(async () =>
            config?.onInput?.({ ...directorEnvelope({ protocol: 'ar-eye-hunter.v1', kind: 'player-pose-intent', pose }, nowEpochMs), senderId: 'peer-b' })
        );
        expect(mockMatch.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'director-player-state' }));
    });

    it.each(['snapshot-first', 'event-first'] as const)('ends the match exactly once when the snapshot and the event both arrive (%s)', async (order) => {
        const match = createMatchFixture(Date.now());
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const receiveSnapshot = () => config?.onSnapshot?.(directorEnvelope(match.ended, match.endedAccepted.acceptedAtEpochMs));
        const receiveEvent = () =>
            config?.onEvent?.(
                directorEnvelope(
                    { protocol: 'ar-eye-hunter.v1', kind: 'director-match-ended', accepted: match.endedAccepted },
                    match.endedAccepted.acceptedAtEpochMs
                )
            );
        await act(async () => config?.onSnapshot?.(directorEnvelope(match.active, match.active.sentAtEpochMs)));

        const statuses = [arena.current?.arenaSnapshot?.match?.status];
        await act(async () => order === 'snapshot-first' ? receiveSnapshot() : receiveEvent());
        const ended = arena.current?.arenaSnapshot;
        statuses.push(ended?.match?.status);
        await act(async () => order === 'snapshot-first' ? receiveEvent() : receiveSnapshot());
        statuses.push(arena.current?.arenaSnapshot?.match?.status);

        expect(statuses).toEqual(['active', 'complete', 'complete']);
        expect(arena.current?.arenaSnapshot?.match).toEqual(match.endedAccepted.match);
        if (order === 'snapshot-first') {
            expect(arena.current?.arenaSnapshot).toBe(ended);
        }
    });
});

interface MatchFixture {
    readonly active: ArenaSnapshot;
    readonly ended: ArenaSnapshot;
    readonly endedAccepted: MatchEndedAccepted;
}

function createMatchFixture(nowEpochMs: number): MatchFixture {
    const started = startArenaMatch(
        createInitialArenaState(44, nowEpochMs),
        { matchId: 'match-1', directorSessionId: session.sessionId, durationMs: 60_000, sentAtEpochMs: nowEpochMs },
        nowEpochMs
    );
    if (!started.accepted) {
        throw new Error('The match fixture did not start.');
    }
    const endedAtEpochMs = nowEpochMs + 60_001;
    const ended = finishArenaMatchIfDue(started.state, endedAtEpochMs);
    if (ended.match?.status !== 'complete') {
        throw new Error('The match fixture did not end.');
    }
    return {
        active: toArenaSnapshot(started.state, 'arena-1', nowEpochMs),
        ended: toArenaSnapshot(ended, 'arena-1', endedAtEpochMs),
        endedAccepted: { match: ended.match, revision: ended.revision, acceptedAtEpochMs: endedAtEpochMs }
    };
}

async function renderDirector(arena: ArenaRuntimeTestHarness, initial: ArenaSnapshot): Promise<MessageDeliveryFixture> {
    const delivery = createMessageDelivery('rtc', { kind: 'admitted', durable: true, queuedAttempts: 1 }, 'all-logical-recipients');
    mockRallar.director.status.mockReturnValue(freshDirectorStatus());
    mockMatch.status.mockReturnValue(localDirectorMatchStatus());
    mockMatch.publishEvent.mockResolvedValue({
        status: 'sent',
        transport: 'director-relay',
        relay: { status: 'sent', receipt: delivery.handle }
    });
    await arena.render();
    await waitForState(() => arena.current?.connectionState === 'connected');
    await act(async () => arena.current?.publishArenaSnapshot(initial));
    mockMatch.publishEvent.mockClear();
    return delivery;
}

function recordReceipt(delivery: MessageDeliveryFixture, confirmed: readonly string[], complete: boolean): void {
    const expected = ['peer-b', 'peer-c'];
    delivery.registry.record({
        kind: 'acknowledgement',
        carrier: 'rtc',
        msgId: delivery.handle.msgId,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: confirmed,
        unconfirmedHopPeerIds: expected.filter((peerId) => !confirmed.includes(peerId)),
        expectedRecipientPeerIds: expected,
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: expected.filter((peerId) => !confirmed.includes(peerId)),
        complete
    });
}

function directorEnvelope<T>(payload: T, sentAtEpochMs: number) {
    return createRallarGameEnvelope({
        protocol: 'ar-eye-hunter.v1',
        kind: 'intent',
        roomId: 'arena-1',
        senderId: session.sessionId,
        seq: 1,
        directorEpoch: 1,
        sentAtEpochMs,
        payload
    });
}

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
