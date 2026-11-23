import {
    INBOX_OUTBOX_ENGINE_MAX_IDLE_MS,
    INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO
} from '../../../services/inbox-outbox-engine.ts';
import type { ALInboundDeferredEffect, ALInboundRuntimeDiagnosticsEvent } from '../al-inbound-runtime-diagnostics.ts';
import type { ALInboundRotationPage } from './al-inbound-rotation-page.ts';

/** The completed rotations one `rotation-alive` event will stand for, from the window's first one on. */
export interface ALInboundRotationWindow {
    readonly openedAtMs: number | undefined;
    readonly rotationCount: number;
    readonly longestRotationReadMs: number;
    readonly deferredRotationCount: number;
    readonly latestDeferred: readonly ALInboundDeferredEffect[];
}

/** What a `rotation-alive` event states beyond the lane and worker that state it. */
export type ALInboundRotationAlive = Omit<
    Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'rotation-alive'; }>,
    'kind' | 'lane' | 'workerId'
>;

/** The window after one more completed rotation, and the event that rotation closed it into, if it did. */
export interface ALInboundRecordedRotationWindow {
    readonly window: ALInboundRotationWindow;
    readonly alive: ALInboundRotationAlive | undefined;
}

/**
 * How long a window stays open: the shortest wait the engine's jitter allows between two idle passes
 * at its ceiling, so the rotation of every idle pass closes the window the pass before it opened.
 */
export const AL_INBOUND_ROTATION_WINDOW_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS *
    (1 - INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO);

export const AL_INBOUND_ROTATION_WINDOW_UNOPENED: ALInboundRotationWindow = {
    openedAtMs: undefined,
    rotationCount: 0,
    longestRotationReadMs: 0,
    deferredRotationCount: 0,
    latestDeferred: []
};

/**
 * The window with one more completed rotation in it. The first window opens when its first rotation
 * started; the first rotation that completes at least `AL_INBOUND_ROTATION_WINDOW_MS` after the
 * window opened closes it into `alive` and opens the next one at its completion. An idle engine
 * passes 2.4 to 3.6 s apart at its jittered ceiling and every pass walks the rotation, so a live idle
 * lane states itself on every idle pass, and silence well beyond 3.6 s means the rotation stopped.
 */
export function computeALInboundRotationWindow(
    window: ALInboundRotationWindow,
    rotation: ALInboundRotationPage.CompletedRotation
): ALInboundRecordedRotationWindow {
    const openedAtMs = window.openedAtMs ?? rotation.startedAtMs;
    const durationMs = Math.max(0, rotation.completedAtMs - openedAtMs);
    const heldBack = rotation.deferred.length > 0;
    const rotationCount = window.rotationCount + 1;
    const longestRotationReadMs = Math.max(window.longestRotationReadMs, rotation.readDurationMs);
    const deferredRotationCount = window.deferredRotationCount + (heldBack ? 1 : 0);
    const latestDeferred = heldBack ? rotation.deferred : window.latestDeferred;
    if (durationMs < AL_INBOUND_ROTATION_WINDOW_MS) {
        return {
            window: { openedAtMs, rotationCount, longestRotationReadMs, deferredRotationCount, latestDeferred },
            alive: undefined
        };
    }
    return {
        window: { ...AL_INBOUND_ROTATION_WINDOW_UNOPENED, openedAtMs: rotation.completedAtMs },
        alive: { rotationCount, durationMs, longestRotationReadMs, deferredRotationCount, latestDeferred }
    };
}
