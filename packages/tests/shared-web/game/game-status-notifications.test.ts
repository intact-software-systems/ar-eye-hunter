import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { RallarGameAuthorityClient } from '@shared-web/game/authority/rallar-game-authority-client.ts';
import { RallarGameMatchStatusRuntime } from '@shared-web/game/match/rallar-game-match-status-runtime.ts';

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

interface StatusSource {
    subscribe(listener: (status: { readonly phase: string; }) => void): () => void;
    stop(): void;
}

function createMatchStatus(): StatusSource {
    const rallar = createRallarFacade();
    const status = new RallarGameMatchStatusRuntime({
        protocol: 'status-test',
        topicId: 'status-test',
        readRoomTarget: () => ({}),
        readLocalPeerId: () => undefined,
        readDirectorStatus: () => rallar.director.status(),
        readAppointmentEligibility: () => ({ allowed: false, status: 'not-ready', policy: 'none' })
    });
    return {
        subscribe: (listener) => status.onStatus(listener),
        stop: () => {
            status.stop();
        }
    };
}

function createAuthorityStatus(): StatusSource {
    const rallar = createRallarFacade();
    const client = new RallarGameAuthorityClient({
        rallar: { ...rallar, rooms: { ...rallar.rooms, state: () => ({ rooms: [], members: [] }) } },
        protocol: 'status-test',
        topicId: 'status-test',
        authority: { kind: 'server', id: 'authority', epoch: 1 }
    });
    return { subscribe: (listener) => client.onStatus(listener), stop: () => client.stop() };
}

describe.each([
    { name: 'browser match', create: createMatchStatus },
    { name: 'server authority client', create: createAuthorityStatus }
])('$name status notifications', ({ create }) => {
    it('replays current status once when a listener subscribes during publication', () => {
        const status = create();
        const received: string[] = [];
        status.subscribe((value) => {
            if (value.phase === 'stopped') {
                status.subscribe((current) => {
                    received.push(current.phase);
                });
            }
        });
        status.stop();
        expect(received).toEqual(['stopped']);
    });

    it('does not let an old unsubscribe remove a renewed registration', () => {
        const status = create();
        const received: string[] = [];
        const listener = (value: { readonly phase: string; }): void => {
            received.push(value.phase);
        };
        const staleUnsubscribe = status.subscribe(listener);
        const unsubscribe = status.subscribe(listener);
        staleUnsubscribe();
        status.stop();
        unsubscribe();
        expect(received).toEqual(['idle', 'idle', 'stopped']);
    });
});

it('publishes stopped authority status and can restart after failed cleanup', async () => {
    const rallar = createRallarFacade();
    let failCleanup = true;
    let activeListeners = 0;
    const client = new RallarGameAuthorityClient({
        rallar: {
            ...rallar,
            rooms: {
                ...rallar.rooms,
                state: () => ({ rooms: [], members: [] }),
                onChange: () => {
                    activeListeners++;
                    return () => {
                        activeListeners--;
                        if (failCleanup) {
                            throw new Error('room cleanup failed');
                        }
                    };
                }
            },
            rtc: { ...rallar.rtc, onStatus: () => () => {} }
        },
        protocol: 'status-test',
        topicId: 'status-test',
        authority: { kind: 'server', id: 'authority', epoch: 1 }
    });
    await client.start();
    expect(() => client.stop()).toThrow(AggregateError);
    expect(client.status().phase).toBe('stopped');
    expect(activeListeners).toBe(0);
    failCleanup = false;
    await client.start();
    expect(activeListeners).toBe(1);
    expect(client.status().phase).not.toBe('stopped');
    client.stop();
    expect(activeListeners).toBe(0);
});
