import { expect, type Page } from '@playwright/test';
import { requireEpoch, requireRecord } from '../../../packages/shared/api/exact-object-decoding.ts';
import { observeArena } from './tournament-native-play.ts';

/** Dispatches real input, then holds only completion of a tap that actually scored on the native server. */
export class NativeTapCompletionGate {
    readonly held = Promise.withResolvers<number>();
    readonly release = Promise.withResolvers<void>();
    tapCount = 0;
    maxConcurrent = 0;
    private concurrent = 0;
    private readonly originalTap: Page['touchscreen']['tap'];
    private readonly page: Page;
    private readonly roomId: string;

    constructor(page: Page, roomId: string) {
        this.page = page;
        this.roomId = roomId;
        void this.release.promise.catch(() => undefined);
        this.originalTap = page.touchscreen.tap;
        page.touchscreen.tap = this.tap;
    }

    restore(): void {
        this.release.resolve();
        this.page.touchscreen.tap = this.originalTap;
    }

    private readonly tap = async (x: number, y: number): Promise<void> => {
        this.tapCount++;
        this.concurrent++;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
        const path = `/api/ar-eye/rooms/${encodeURIComponent(this.roomId)}/tournament/inputs/requests/`;
        const fired = this.page.waitForResponse((response) =>
            response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith(path) &&
            response.request().postDataJSON()?.controls?.fire === true
        );
        try {
            const [, response] = await Promise.all([
                this.originalTap.call(this.page.touchscreen, x, y),
                fired
            ]);
            expect(response.status()).toBe(200);
            const result = requireRecord(await response.json(), 'Native input result');
            expect(result.status).toBe('applied');
            const appliedAt = result.simulatedAtEpochMs;
            requireEpoch(appliedAt, 'Native input simulation time');
            let state = await observeArena(this.page, this.roomId);
            // A miss must finish so another real tap can try. No score is supplied by the fixture.
            while (state.players[0].simulation.combat.score === 0 && state.simulatedAtEpochMs <= appliedAt + 300) {
                state = await observeArena(this.page, this.roomId);
            }
            if (state.players[0].simulation.combat.score > 0) {
                this.held.resolve(state.players[0].simulation.combat.score);
                await this.release.promise;
            }
        }
        finally {
            this.concurrent--;
        }
    };
}
