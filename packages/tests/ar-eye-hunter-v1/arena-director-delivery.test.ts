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

import type { RallarGamePeerReadiness } from '@shared-web/game/mod.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { ArenaRallarGameMatchHandle } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';

import { createMessageDelivery } from '../shared-web/messages/test-message-delivery.ts';

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
