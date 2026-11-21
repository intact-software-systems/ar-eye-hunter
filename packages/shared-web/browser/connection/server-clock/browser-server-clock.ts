import { Command, CommandTimedOutError } from '@shared/cache/Command.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
    computeRemoteClockWindow,
    type RemoteClockObservation,
    type RemoteClockPolicy,
    type RemoteClockWindow
} from '@shared/resilience/remote-clock.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    readServerClockSample,
    type ServerClockReadFailure,
    type ServerClockSampleDependencies
} from './read-server-clock-sample.ts';

export namespace BrowserServerClock {
    export type Sample = (
        signal: AbortSignal,
        nowMonotonicMs: () => number
    ) => Promise<Either<ServerClockReadFailure, RemoteClockObservation>>;
    export interface Config {
        readonly baseUrl: string;
        readonly expectedServerPeerId: string;
        readonly requestTimeoutMs: number;
        readonly policy: RemoteClockPolicy;
    }

    export interface Failure {
        readonly code:
            | ServerClockReadFailure['code']
            | 'unavailable'
            | 'closed'
            | 'invalidated'
            | 'timeout'
            | 'invalid-observation'
            | 'discontinuity';
        readonly cause: Error;
    }
}

export class BrowserServerClock {
    readonly #config: BrowserServerClock.Config;
    readonly #dependencies: ServerClockSampleDependencies;
    readonly #flights = new SingleFlight<number, Either<BrowserServerClock.Failure, RemoteClockWindow>>();
    #generation = 0;
    #closed = false;
    #observation: RemoteClockObservation | undefined;
    #fault: BrowserServerClock.Failure | undefined;
    #controller: AbortController | undefined;
    #lastMonotonicMs: number | undefined;

    constructor(config: BrowserServerClock.Config, dependencies: ServerClockSampleDependencies) {
        if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
            throw new RangeError('Server clock request timeout must be positive and finite.');
        }
        this.#config = { ...config, policy: { ...config.policy } };
        this.#dependencies = dependencies;
    }

    readWindow(): Either<BrowserServerClock.Failure, RemoteClockWindow> {
        return this.#readCurrentWindow(this.#readMonotonicMs(this.#generation));
    }

    refresh(sample?: BrowserServerClock.Sample): Promise<Either<BrowserServerClock.Failure, RemoteClockWindow>> {
        if (this.#closed) {
            return Promise.resolve(Either.ofLeft({ code: 'closed', cause: new Error('Server clock is closed.') }));
        }
        if (this.#fault !== undefined) {
            return Promise.resolve(Either.ofLeft(this.#fault));
        }
        const generation = this.#generation;
        return this.#flights.run(generation, () => this.#refreshObservation(generation, sample));
    }

    /** The connection owner must stop epoch-dependent work before reacquiring after suspension or discontinuity. */
    invalidate(): void {
        this.#generation += 1;
        this.#observation = undefined;
        this.#fault = undefined;
        this.#lastMonotonicMs = undefined;
        const controller = this.#controller;
        this.#controller = undefined;
        controller?.abort();
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.invalidate();
        await Promise.all(this.#flights.completions());
    }

    async #refreshObservation(
        generation: number,
        sample: BrowserServerClock.Sample | undefined
    ): Promise<Either<BrowserServerClock.Failure, RemoteClockWindow>> {
        const controller = new AbortController();
        this.#controller = controller;
        const nowMonotonicMs = () => this.#readMonotonicMs(generation);
        const command = new Command(
            (signal) =>
                sample ? sample(signal ?? controller.signal, nowMonotonicMs) : readServerClockSample({
                    baseUrl: this.#config.baseUrl,
                    expectedServerPeerId: this.#config.expectedServerPeerId,
                    signal
                }, {
                    fetch: this.#dependencies.fetch,
                    nowMonotonicMs
                }),
            { signal: controller.signal, timeoutMs: this.#config.requestTimeoutMs, maxAttempts: 1 }
        );
        try {
            const result = await command.run();
            if (this.#closed || generation !== this.#generation) {
                return this.#obsoleteAttempt();
            }
            return result.fold(
                (failure) => Either.ofLeft(failure),
                (observation) => this.#adoptObservation(observation)
            );
        }
        catch (error) {
            if (this.#closed || generation !== this.#generation) {
                return this.#obsoleteAttempt();
            }
            return Either.ofLeft({
                code: error instanceof CommandTimedOutError ? 'timeout' : 'network',
                cause: toError(error)
            });
        }
        finally {
            if (this.#controller === controller) {
                this.#controller = undefined;
            }
        }
    }

    #adoptObservation(observation: RemoteClockObservation): Either<BrowserServerClock.Failure, RemoteClockWindow> {
        const nowMonotonicMs = this.#readMonotonicMs(this.#generation);
        const previous = this.#readCurrentWindow(nowMonotonicMs);
        if (previous.left !== undefined && previous.left.code !== 'unavailable') {
            return Either.ofLeft(previous.left);
        }
        const candidate = computeRemoteClockWindow({ observation, policy: this.#config.policy, nowMonotonicMs });
        if (candidate.left !== undefined) {
            return Either.ofLeft({ code: 'invalid-observation', cause: new Error(candidate.left.join(' ')) });
        }
        const next = candidate.right!;
        if (
            previous.right !== undefined &&
            (next.earliestEpochMs > previous.right.latestEpochMs ||
                next.latestEpochMs < previous.right.earliestEpochMs)
        ) {
            this.#fault = { code: 'discontinuity', cause: new Error('Server clock observations no longer overlap.') };
            this.#observation = undefined;
            return Either.ofLeft(this.#fault);
        }
        this.#observation = observation;
        return Either.ofRight(next);
    }

    #readCurrentWindow(nowMonotonicMs: number): Either<BrowserServerClock.Failure, RemoteClockWindow> {
        if (this.#closed) {
            return Either.ofLeft({ code: 'closed', cause: new Error('Server clock is closed.') });
        }
        if (this.#fault !== undefined) {
            return Either.ofLeft(this.#fault);
        }
        if (this.#observation === undefined) {
            return Either.ofLeft({ code: 'unavailable', cause: new Error('No server clock observation.') });
        }
        const window = computeRemoteClockWindow({
            observation: this.#observation,
            policy: this.#config.policy,
            nowMonotonicMs
        });
        if (window.left !== undefined) {
            this.#fault = { code: 'discontinuity', cause: new Error(window.left.join(' ')) };
            this.#observation = undefined;
            return Either.ofLeft(this.#fault);
        }
        return Either.ofRight(window.right!);
    }

    #readMonotonicMs(generation: number): number {
        const nowMonotonicMs = this.#dependencies.nowMonotonicMs();
        if (generation !== this.#generation || this.#closed || this.#fault !== undefined) {
            return nowMonotonicMs;
        }
        if (
            !Number.isFinite(nowMonotonicMs) || nowMonotonicMs < 0 ||
            (this.#lastMonotonicMs !== undefined && nowMonotonicMs < this.#lastMonotonicMs)
        ) {
            this.#fault = {
                code: 'discontinuity',
                cause: new Error('Monotonic clock became invalid or moved backwards.')
            };
            this.#observation = undefined;
        }
        this.#lastMonotonicMs = nowMonotonicMs;
        return nowMonotonicMs;
    }

    #obsoleteAttempt(): Either<BrowserServerClock.Failure, RemoteClockWindow> {
        return Either.ofLeft({
            code: this.#closed ? 'closed' : 'invalidated',
            cause: new Error('Server clock acquisition no longer belongs to the active lifetime.')
        });
    }
}
