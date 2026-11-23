import { describe, expect, it } from 'vitest';

import type { ALInboundRotationPage } from '@shared/alm/inbound/lane/al-inbound-rotation-page.ts';
import {
    AL_INBOUND_ROTATION_WINDOW_MS,
    AL_INBOUND_ROTATION_WINDOW_UNOPENED,
    computeALInboundRotationWindow,
    type ALInboundRotationAlive,
    type ALInboundRotationWindow
} from '@shared/alm/inbound/lane/compute-al-inbound-rotation-window.ts';
import {
    INBOX_OUTBOX_ENGINE_MAX_IDLE_MS,
    INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO
} from '@shared/services/inbox-outbox-engine.ts';

const OPENED_AT_MS = 1_800_000_000_000;
const HELD = { effectId: 'dispatch:sender:held', dueAtMs: OPENED_AT_MS - 50 };
/** The shortest wait the engine's jitter allows between two idle passes at its ceiling. */
const SHORTEST_IDLE_PASS_GAP_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS * (1 - INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO);

/** A rotation whose page reads took `readDurationMs` and ended at `completedAtMs`. */
function toRotation(
    completedAtMs: number,
    readDurationMs: number,
    deferred: ALInboundRotationPage.CompletedRotation['deferred'] = []
): ALInboundRotationPage.CompletedRotation {
    return { startedAtMs: completedAtMs - readDurationMs, completedAtMs, readDurationMs, deferred };
}

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
    it('closes at the shortest gap the engine\'s jitter allows between two idle passes', () => {
        expect(AL_INBOUND_ROTATION_WINDOW_MS).toBe(SHORTEST_IDLE_PASS_GAP_MS);
    });

    it('states every idle pass\'s rotation after the first when the passes come at the shortest jittered ceiling', () => {
        const rotations = Array.from({ length: 6 }, (_, pass) => toRotation(OPENED_AT_MS + pass * SHORTEST_IDLE_PASS_GAP_MS, 0));

        const { alive } = computeAliveEvents(rotations);

        // The first window opened at the first pass, so the second pass closes it with both rotations in it.
        expect(alive.map((event) => [event.rotationCount, event.durationMs])).toEqual([
            [2, SHORTEST_IDLE_PASS_GAP_MS],
            ...Array.from({ length: 4 }, () => [1, SHORTEST_IDLE_PASS_GAP_MS])
        ]);
    });

    it('states nothing for rotations that complete inside the window of the first one', () => {
        const { alive, window } = computeAliveEvents([
            toRotation(OPENED_AT_MS + 40, 40),
            toRotation(OPENED_AT_MS + AL_INBOUND_ROTATION_WINDOW_MS - 1, 30)
        ]);

        expect(alive).toEqual([]);
        expect(window).toMatchObject({ openedAtMs: OPENED_AT_MS, rotationCount: 2 });
    });

    it('states the window once a rotation completes the window after it opened, and opens the next there', () => {
        const closedAtMs = OPENED_AT_MS + AL_INBOUND_ROTATION_WINDOW_MS;
        const { alive, window } = computeAliveEvents([
            toRotation(OPENED_AT_MS + 40, 40, [HELD]),
            toRotation(OPENED_AT_MS + 1_400, 400),
            toRotation(closedAtMs, 10)
        ]);

        expect(alive).toEqual([{
            rotationCount: 3,
            durationMs: AL_INBOUND_ROTATION_WINDOW_MS,
            longestRotationReadMs: 400,
            deferredRotationCount: 1,
            latestDeferred: [HELD]
        }]);
        expect(window).toEqual({ ...AL_INBOUND_ROTATION_WINDOW_UNOPENED, openedAtMs: closedAtMs });
    });

    it('takes the longest rotation from its own page reads, not the wall time it spanned', () => {
        const { alive } = computeAliveEvents([
            // Its first page read and its wrap were 2 s apart, of which its reads took 60 ms.
            { startedAtMs: OPENED_AT_MS, completedAtMs: OPENED_AT_MS + 2_000, readDurationMs: 60, deferred: [] },
            toRotation(OPENED_AT_MS + AL_INBOUND_ROTATION_WINDOW_MS, 20)
        ]);

        expect(alive).toMatchObject([{ longestRotationReadMs: 60 }]);
    });

    it('states at most once per window however many rotations complete in it', () => {
        const rotations = Array.from({ length: 30 }, (_, index) => toRotation(OPENED_AT_MS + (index + 1) * 250, 5));

        const { alive } = computeAliveEvents(rotations);

        // The first window opens when the first rotation started, 5 ms before its completion, so the first
        // completion at least the window later is the 11th; the next window opens there and closes 10 later.
        expect(alive.map((event) => [event.rotationCount, event.durationMs])).toEqual([
            [11, AL_INBOUND_ROTATION_WINDOW_MS + 105],
            [10, AL_INBOUND_ROTATION_WINDOW_MS + 100]
        ]);
    });

    it('keeps the due rows of the latest rotation that held any back', () => {
        const later = { effectId: 'dispatch:sender:later', dueAtMs: OPENED_AT_MS };
        const { alive } = computeAliveEvents([
            toRotation(OPENED_AT_MS + 10, 10, [HELD]),
            toRotation(OPENED_AT_MS + 30, 10, [HELD, later]),
            toRotation(OPENED_AT_MS + AL_INBOUND_ROTATION_WINDOW_MS + 10, 10)
        ]);

        expect(alive).toMatchObject([{ deferredRotationCount: 2, latestDeferred: [HELD, later] }]);
    });
});
