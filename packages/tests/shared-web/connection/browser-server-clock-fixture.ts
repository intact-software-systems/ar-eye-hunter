import type { BrowserServerClockSession } from '@shared-web/browser/connection/browser-server-clock-session.ts';
import type { BrowserServerClock } from '@shared-web/browser/connection/browser-server-clock.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RemoteClockWindow } from '@shared/resilience/remote-clock.ts';

/** An already-acquired clock port for tests whose middleware acquisition is replaced at its owned boundary. */
class BrowserServerClockFixture implements BrowserServerClockSession.Port {
    readonly #lifetime = new AbortController();
    readonly #nowMs: () => number;

    constructor(nowMs: () => number) {
        this.#nowMs = nowMs;
    }

    get signal(): AbortSignal {
        return this.#lifetime.signal;
    }

    readWindow(): Either<BrowserServerClock.Failure, RemoteClockWindow> {
        if (this.signal.aborted) {
            return Either.ofLeft({ code: 'closed', cause: new Error('Test connection clock ended.') });
        }
        const nowMs = this.#nowMs();
        return Either.ofRight({ earliestEpochMs: nowMs, latestEpochMs: nowMs });
    }

    async close(reason = new Error('Test connection clock ended.')): Promise<void> {
        this.#lifetime.abort(reason);
    }
}

export function createDefaultBrowserServerClockFixture(): BrowserServerClockSession.Port {
    return new BrowserServerClockFixture(Date.now);
}
