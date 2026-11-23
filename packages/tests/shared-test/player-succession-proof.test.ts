import { afterEach, expect, it, vi } from 'vitest';
import { waitForReconnectedSession } from '@shared-test/black-box-runner/cluster-proofs/prove-player-succession.mts';

const observation = {
    observerOrigin: 'https://observer.test', group: '/groups/players',
    owner: { label: 'owner', principal: 'alice' as const, clientId: 'owner', sessionId: 's', accessToken: 'test',
        apiBaseUrl: 'https://writer.test', wsBaseUrl: 'wss://writer.test' },
    generationId: 'new', floor: { groupRevision: 7, presenceRevision: 9 }
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it('waits for the accepted floor and exact session generation on the observer', async () => {
    const prior = { sessionId: 's', generationId: 'old' };
    const current = { sessionId: 's', generationId: 'new' };
    let observerState: 'below-floor' | 'projecting' | 'current' = 'below-floor';
    let observedCurrent = false;
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input);
        if (url.origin !== observation.observerOrigin || url.pathname !== observation.group ||
            url.searchParams.get('minGroupRevision') !== '7' || url.searchParams.get('minPresenceRevision') !== '9') {
            return Response.json({ error: 'Expected an observer read at the accepted revision' }, { status: 400 });
        }
        if (observerState === 'below-floor') {
            observerState = 'projecting';
            return Response.json({ code: 'state-revision-floor-not-satisfied' }, { status: 409 });
        }
        if (observerState === 'projecting') {
            observerState = 'current';
            return Response.json({ activeSessions: [prior, { ...current, sessionId: 'another' }] });
        }
        observedCurrent = true;
        return Response.json({ activeSessions: [current] });
    });
    await waitForReconnectedSession(observation);
    expect(observedCurrent).toBe(true);
});

it('fails at the observation deadline when the previous generation persists', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => Response.json({ activeSessions: [{ sessionId: 's', generationId: 'old' }] }));
    const failure = expect(waitForReconnectedSession(observation)).rejects.toThrow('Timed out waiting for the accepted room session generation');
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
});
