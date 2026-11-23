import { describe, expect, it } from 'vitest';

import type { ALInboundRotationPage } from '@shared/alm/inbound/lane/al-inbound-rotation-page.ts';
import {
    AL_INBOUND_ROTATION_WINDOW_UNOPENED,
    computeALInboundRotationWindow,
    type ALInboundRotationAlive,
    type ALInboundRotationWindow
} from '@shared/alm/inbound/lane/compute-al-inbound-rotation-window.ts';
import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS } from '@shared/services/inbox-outbox-engine.ts';

const OPENED_AT_MS = 1_800_000_000_000;
const HELD = { effectId: 'dispatch:sender:held', dueAtMs: OPENED_AT_MS - 50 };

/** Feeds the rotations one by one, collecting every event the window states. */
function computeAliveEvents(rotations: readonly ALInboundRotationPage.CompletedRotation[]): {
    readonly alive: readonly ALInboundRotationAlive[];
    readonly window: ALInboundRotationWindow;
} {
    let window = AL_INBOUND_ROTATION_WINDOW_UNOPENED;
    const alive: ALInboundRotationAlive[] = [];
    for (const rotation of rotations) {
        const recorded = computeALInboundRotationWindow(window, rotation);
        window = recorded.window;
        if (recorded.alive !== undefined) {
            alive.push(recorded.alive);
        }
    }
    return { alive, window };
}

describe('computeALInboundRotationWindow', () => {
    it('states nothing for rotations that complete inside the idle ceiling of the window\'s first one', () => {
        const { alive, window } = computeAliveEvents([
            { startedAtMs: OPENED_AT_MS, completedAtMs: OPENED_AT_MS + 40, deferred: [] },
            { startedAtMs: OPENED_AT_MS + 1_000, completedAtMs: OPENED_AT_MS + INBOX_OUTBOX_ENGINE_MAX_IDLE_MS - 1, deferred: [] }
        ]);

        expect(alive).toEqual([]);
        expect(window).toMatchObject({ openedAtMs: OPENED_AT_MS, rotationCount: 2 });
    });

    it('states the window once a rotation completes the idle ceiling after it opened, and opens the next there', () => {
        const closedAtMs = OPENED_AT_MS + INBOX_OUTBOX_ENGINE_MAX_IDLE_MS;
        const { alive, window } = computeAliveEvents([
            { startedAtMs: OPENED_AT_MS, completedAtMs: OPENED_AT_MS + 40, deferred: [HELD] },
            { startedAtMs: OPENED_AT_MS + 1_000, completedAtMs: OPENED_AT_MS + 1_400, deferred: [] },
            { startedAtMs: closedAtMs - 10, completedAtMs: closedAtMs, deferred: [] }
        ]);

        expect(alive).toEqual([{
            rotationCount: 3,
            durationMs: INBOX_OUTBOX_ENGINE_MAX_IDLE_MS,
            longestRotationMs: 400,
            deferredRotationCount: 1,
            latestDeferred: [HELD]
        }]);
        expect(window).toEqual({ ...AL_INBOUND_ROTATION_WINDOW_UNOPENED, openedAtMs: closedAtMs });
    });

    it('states at most once per window however many rotations complete in it', () => {
        const rotations = Array.from({ length: 30 }, (_, index) => {
            const completedAtMs = OPENED_AT_MS + (index + 1) * 250;
            return { startedAtMs: completedAtMs - 5, completedAtMs, deferred: [] };
        });

        const { alive } = computeAliveEvents(rotations);

        // The first window opens when the first rotation started, 5 ms before its completion, so the first
        // completion at least the ceiling later is the 13th; the next window opens there and closes 12 later.
        expect(alive.map((event) => [event.rotationCount, event.durationMs])).toEqual([
            [13, INBOX_OUTBOX_ENGINE_MAX_IDLE_MS + 5],
            [12, INBOX_OUTBOX_ENGINE_MAX_IDLE_MS]
        ]);
    });

    it('keeps the due rows of the latest rotation that held any back', () => {
        const later = { effectId: 'dispatch:sender:later', dueAtMs: OPENED_AT_MS };
        const { alive } = computeAliveEvents([
            { startedAtMs: OPENED_AT_MS, completedAtMs: OPENED_AT_MS + 10, deferred: [HELD] },
            { startedAtMs: OPENED_AT_MS + 20, completedAtMs: OPENED_AT_MS + 30, deferred: [HELD, later] },
            {
                startedAtMs: OPENED_AT_MS + INBOX_OUTBOX_ENGINE_MAX_IDLE_MS,
                completedAtMs: OPENED_AT_MS + INBOX_OUTBOX_ENGINE_MAX_IDLE_MS + 10,
                deferred: []
            }
        ]);

        expect(alive).toMatchObject([{ deferredRotationCount: 2, latestDeferred: [HELD, later] }]);
    });
});
