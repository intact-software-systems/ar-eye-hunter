import type { BrowserPageLifecycleFlush } from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RemoteClockWindow } from '@shared/resilience/remote-clock.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';

import type { BrowserServerClock } from './browser-server-clock.ts';

export namespace BrowserServerClockSession {
    /** The acquired clock lifetime handed to transport and message consumers. */
    export interface Port {
        readonly signal: AbortSignal;
        readWindow(): Either<BrowserServerClock.Failure, RemoteClockWindow>;
        /** Work bookkeeping only; freezes at the last calibrated bound when authority ends. */
        readWorkEpochMs(): number;
        close(reason?: Error): Promise<void>;
    }

    export interface Input {
        readonly clock: BrowserServerClock;
        readonly timers: Timers;
        readonly page: BrowserPageLifecycleFlush.Page;
        readonly refreshIntervalMs: number;
    }
}

export class BrowserServerClockSession {
    readonly #input: BrowserServerClockSession.Input;
    readonly #lifetime = new AbortController();
    readonly #startup = new SingleFlight<number, Either<BrowserServerClock.Failure, RemoteClockWindow>>();
    #stopRefresh: (() => void) | undefined;
    #lastWorkEpochMs: number | undefined;

    constructor(input: BrowserServerClockSession.Input) {
        if (!Number.isFinite(input.refreshIntervalMs) || input.refreshIntervalMs <= 0) {
            throw new RangeError('Server clock refresh interval must be positive and finite.');
        }
        this.#input = input;
    }

    get signal(): AbortSignal {
        return this.#lifetime.signal;
    }

    start(): Promise<Either<BrowserServerClock.Failure, RemoteClockWindow>> {
        return this.#startup.run(0, () => this.#start());
    }

    readWindow(): Either<BrowserServerClock.Failure, RemoteClockWindow> {
        if (this.signal.aborted) {
            return Either.ofLeft({ code: 'closed', cause: new Error('Server clock connection lifetime ended.') });
        }
        const available = this.#input.clock.readWindow();
        if (available.right !== undefined) {
            this.#lastWorkEpochMs = available.right.latestEpochMs;
        }
        if (available.left !== undefined && this.#stopRefresh !== undefined) {
            void this.close(available.left.cause);
        }
        return available;
    }

    /** Never authorizes a message. Retirement keeps the last observation so already-owned work can release. */
    readWorkEpochMs(): number {
        if (!this.signal.aborted) {
            const available = this.readWindow();
            if (available.left !== undefined && this.#lastWorkEpochMs === undefined) {
                throw available.left.cause;
            }
        }
        if (this.#lastWorkEpochMs === undefined) {
            throw new Error('Work timing requires an acquired server clock.');
        }
        return this.#lastWorkEpochMs;
    }

    async close(reason = new Error('Server clock connection lifetime ended.')): Promise<void> {
        this.#stopRefresh?.();
        this.#stopRefresh = undefined;
        this.#lifetime.abort(reason);
        await this.#input.clock.close();
    }

    async #start(): Promise<Either<BrowserServerClock.Failure, RemoteClockWindow>> {
        if (this.signal.aborted || this.#stopRefresh !== undefined) {
            return this.readWindow();
        }
        this.#listenForSuspension();
        if (this.#input.page.document?.visibilityState === 'hidden') {
            await this.close(new Error('Cannot calibrate a hidden browser connection.'));
            return this.#input.clock.readWindow();
        }
        const acquired = await this.#input.clock.refresh();
        if (acquired.left !== undefined) {
            await this.close(acquired.left.cause);
            return acquired;
        }
        if (this.signal.aborted) {
            return this.#input.clock.readWindow();
        }
        this.#lastWorkEpochMs = acquired.right!.latestEpochMs;
        this.#stopRefresh = startRepeating({
            timers: this.#input.timers,
            intervalMs: this.#input.refreshIntervalMs,
            firstRun: 'after-interval',
            run: () => this.#refresh()
        });
        return acquired;
    }

    #listenForSuspension(): void {
        const { document, window } = this.#input.page;
        const options = { signal: this.signal };
        const suspend = (): void => {
            void this.close(new Error('Browser page suspension invalidated its server clock.'));
        };
        document?.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                suspend();
            }
        }, options);
        document?.addEventListener('freeze', suspend, options);
        window?.addEventListener('pagehide', suspend, options);
    }

    async #refresh(): Promise<void> {
        if (this.signal.aborted) {
            return;
        }
        await this.#input.clock.refresh();
        const available = this.readWindow();
        if (available.left !== undefined) {
            await this.close(available.left.cause);
        }
    }
}

/** Expiry decisions use the latest possible server time; unavailable calibration cannot authorize work. */
export function readBrowserServerExpiryEpochMs(clock: Pick<BrowserServerClockSession.Port, 'readWindow'>): number {
    return clock.readWindow().fold(
        (failure) => {
            throw failure.cause;
        },
        (window) => window.latestEpochMs
    );
}

/** Creation cannot be future-dated relative to the server receiving the new fact. */
export function readBrowserServerCreationEpochMs(clock: Pick<BrowserServerClockSession.Port, 'readWindow'>): number {
    return clock.readWindow().fold(
        (failure) => {
            throw failure.cause;
        },
        (window) => window.earliestEpochMs
    );
}
