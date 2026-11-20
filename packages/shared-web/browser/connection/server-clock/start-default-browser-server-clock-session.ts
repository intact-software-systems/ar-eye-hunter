import { readBrowserPageLifecycle } from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { BrowserServerClockSession } from './browser-server-clock-session.ts';
import { BrowserServerClock } from './browser-server-clock.ts';

export interface StartDefaultBrowserServerClockSessionInput {
    readonly baseUrl: string;
    readonly serverPeerId: string;
    readonly signal: AbortSignal | undefined;
}

/** A connection is usable only within these explicit clock-rate and monotonic precision assumptions. */
const BROWSER_SERVER_CLOCK_DEFAULTS = {
    requestTimeoutMs: 2_000,
    policy: {
        maxRoundTripMs: 500,
        maxAgeMs: 30_000,
        maxRelativeDriftPpm: 1_000,
        maxMonotonicErrorMs: 2
    }
} satisfies Omit<BrowserServerClock.Config, 'baseUrl' | 'expectedServerPeerId'>;

export async function startDefaultBrowserServerClockSession(
    input: StartDefaultBrowserServerClockSessionInput
): Promise<BrowserServerClockSession> {
    input.signal?.throwIfAborted();
    const clock = new BrowserServerClock({
        ...BROWSER_SERVER_CLOCK_DEFAULTS,
        baseUrl: input.baseUrl,
        expectedServerPeerId: input.serverPeerId
    }, {
        fetch: globalThis.fetch.bind(globalThis),
        nowMonotonicMs: () => globalThis.performance.now()
    });
    const session = new BrowserServerClockSession({
        clock,
        page: readBrowserPageLifecycle(),
        timers: createDefaultBackgroundTimers(),
        refreshIntervalMs: 5_000
    });
    const signal = input.signal;
    if (signal) {
        const cancel = (): void => {
            void session.close(toError(signal.reason));
        };
        signal.addEventListener('abort', cancel, { once: true });
        session.signal.addEventListener('abort', () => signal.removeEventListener('abort', cancel), { once: true });
    }
    try {
        const acquired = await session.start();
        session.signal.throwIfAborted();
        if (acquired.left !== undefined) {
            throw acquired.left.cause;
        }
        return session;
    }
    catch (caught) {
        await session.close(toError(caught));
        throw caught;
    }
}
