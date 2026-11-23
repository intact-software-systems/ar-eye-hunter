import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS } from '../../../services/inbox-outbox-engine.ts';
import type { ALInboundDeferredEffect, ALInboundRuntimeDiagnosticsEvent } from '../al-inbound-runtime-diagnostics.ts';
import type { ALInboundRotationPage } from './al-inbound-rotation-page.ts';

/** The completed rotations one `rotation-alive` event will stand for, from the window's first one on. */
export interface ALInboundRotationWindow {
    readonly openedAtMs: number | undefined;
    readonly rotationCount: number;
    readonly longestRotationMs: number;
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

export const AL_INBOUND_ROTATION_WINDOW_UNOPENED: ALInboundRotationWindow = {
    openedAtMs: undefined,
    rotationCount: 0,
    longestRotationMs: 0,
    deferredRotationCount: 0,
    latestDeferred: []
};

/**
 * The window with one more completed rotation in it. The first window opens when its first rotation
 * started; the first rotation that completes at least the engine's idle ceiling after the window
 * opened closes it into `alive` and opens the next one at its completion. An idle engine passes at
 * least once per idle ceiling and every pass walks the rotation, so a live lane states itself about
 * once per ceiling, and silence well beyond that means the rotation stopped.
 */
export function computeALInboundRotationWindow(
    window: ALInboundRotationWindow,
    rotation: ALInboundRotationPage.CompletedRotation
): ALInboundRecordedRotationWindow {
    const openedAtMs = window.openedAtMs ?? rotation.startedAtMs;
    const durationMs = Math.max(0, rotation.completedAtMs - openedAtMs);
    const heldBack = rotation.deferred.length > 0;
    const rotationCount = window.rotationCount + 1;
    const longestRotationMs = Math.max(window.longestRotationMs, rotation.completedAtMs - rotation.startedAtMs);
    const deferredRotationCount = window.deferredRotationCount + (heldBack ? 1 : 0);
    const latestDeferred = heldBack ? rotation.deferred : window.latestDeferred;
    if (durationMs < INBOX_OUTBOX_ENGINE_MAX_IDLE_MS) {
        return {
            window: { openedAtMs, rotationCount, longestRotationMs, deferredRotationCount, latestDeferred },
            alive: undefined
        };
    }
    return {
        window: { ...AL_INBOUND_ROTATION_WINDOW_UNOPENED, openedAtMs: rotation.completedAtMs },
        alive: { rotationCount, durationMs, longestRotationMs, deferredRotationCount, latestDeferred }
    };
}
