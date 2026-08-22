import { createRallarDirectorFacade } from '@shared-web/browser/rallar-director-facade.ts';
import type {
    RallarDirectorAppointOptions,
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle,
    RallarDirectorResignOptions,
    RallarDirectorStatus,
    RallarDirectorStatusListener
} from '@shared-web/browser/rallar.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar director facade factory', () => {
    it('delegates director methods through injected operations', async () => {
        const status: RallarDirectorStatus = {
            roomId: 'room-1',
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            active: true,
            freshness: 'fresh',
            nowEpochMs: 123
        };
        const unsubscribe = vi.fn();
        const listener = vi.fn() as RallarDirectorStatusListener;
        const relay = {
            status: vi.fn(() => status)
        } as unknown as RallarDirectorRelayHandle<unknown, unknown, unknown>;
        const createRelay = vi.fn();
        const operations = {
            appoint: vi.fn(async () => status),
            resign: vi.fn(async () => status),
            status: vi.fn(() => status),
            onStatus: vi.fn(() => unsubscribe),
            createRelay<TIntent, TOutput, TSnapshot = TOutput>(
                config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
            ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
                createRelay(config);
                return relay;
            }
        };

        const facade = createRallarDirectorFacade(operations);
        const appointOptions = {
            heartbeatTtlMs: 10_000
        } satisfies RallarDirectorAppointOptions;
        const resignOptions = {
            timeoutMs: 123
        } satisfies RallarDirectorResignOptions;
        const relayConfig = {
            intentTypeId: 'intent',
            outputTypeId: 'output'
        } satisfies RallarDirectorRelayConfig<{ move: string; }, { ok: true; }>;

        await expect(facade.appoint('room-1', appointOptions)).resolves.toBe(
            status
        );
        await expect(facade.resign('room-1', resignOptions)).resolves.toBe(
            status
        );
        expect(facade.status('room-1', { now: 123 })).toBe(status);
        expect(facade.onStatus(listener)).toBe(unsubscribe);
        expect(facade.createRelay(relayConfig)).toBe(relay);

        expect(operations.appoint).toHaveBeenCalledWith(
            'room-1',
            appointOptions
        );
        expect(operations.resign).toHaveBeenCalledWith('room-1', resignOptions);
        expect(operations.status).toHaveBeenCalledWith('room-1', { now: 123 });
        expect(operations.onStatus).toHaveBeenCalledWith(listener);
        expect(createRelay).toHaveBeenCalledWith(relayConfig);
    });
});
