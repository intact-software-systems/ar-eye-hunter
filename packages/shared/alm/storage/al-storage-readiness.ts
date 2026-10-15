import { Either } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import type { ALStorageHealth } from './al-storage-health.ts';
import { toALStorageUnavailable, type ALStorageUnavailable } from './al-storage-unavailable.ts';

export namespace ALStorageReadiness {
    export interface Input {
        readonly openStores: () => Promise<void>;
        /** Runs after every open that succeeded; the work owner's bootstrap, which runs once. */
        readonly startWork: () => Promise<void>;
        readonly storageHealth: ALStorageHealth | undefined;
    }

    export type Outcome = Either<ALStorageUnavailable, 'ready'>;
}

/**
 * A storage failure is recorded on the pair's health and answered as a value; an open that failed
 * is tried again by the next call. Any other failure throws.
 */
export class ALStorageReadiness {
    private readonly input: ALStorageReadiness.Input;
    private opening: Promise<ALStorageReadiness.Outcome> | undefined;
    private disposed = false;
    private readonly operations = new Set<Promise<void>>();

    constructor(input: ALStorageReadiness.Input) {
        this.input = input;
        this.opening = this.readOpen();
    }

    async ready(): Promise<ALStorageReadiness.Outcome> {
        if (this.disposed) {
            throw new Error('AL storage readiness is disposed');
        }
        const opening = this.opening ?? this.readOpen();
        this.opening = opening;
        const opened = await opening;
        if (opened.left !== undefined) {
            if (this.opening === opening) {
                this.opening = undefined;
            }
            return opened;
        }
        if (!this.disposed) {
            await this.input.startWork();
        }
        return opened;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const outcomes = await Promise.allSettled([this.opening, ...this.operations]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    }

    /** A read the idle engine makes: answered `whileUnavailable`, touching no storage, while the last open failed. */
    async readOpenedStore<T>(read: () => Promise<T>, whileUnavailable: T): Promise<T> {
        if (this.disposed) {
            return whileUnavailable;
        }
        const opened = this.opening === undefined ? undefined : await this.opening;
        return opened?.right === undefined ? whileUnavailable : await read();
    }

    /** A whole admission, including gaps between its reads and writes, belongs to this lane until settled. */
    async runStoreOperation<T>(
        operation: () => Promise<T>,
        toAnswer?: (unavailable: ALStorageUnavailable) => T
    ): Promise<T> {
        if (this.disposed) {
            throw new Error('AL storage readiness is disposed');
        }
        // Register before calling the operation: even a synchronous callback can initiate shutdown.
        const result = Promise.resolve().then(operation);
        const completion = result.then(() => {}, () => {});
        this.operations.add(completion);
        try {
            return await result;
        }
        catch (error) {
            if (toAnswer === undefined) {
                throw error;
            }
            return toAnswer(this.recordStorageFailure(toError(error)));
        }
        finally {
            this.operations.delete(completion);
        }
    }

    private async readOpen(): Promise<ALStorageReadiness.Outcome> {
        try {
            await this.input.openStores();
            return Either.ofRight('ready');
        }
        catch (error) {
            return Either.ofLeft(this.recordStorageFailure(toError(error)));
        }
    }

    /** Rethrows a failure that is not one of storage. */
    private recordStorageFailure(error: Error): ALStorageUnavailable {
        const unavailable = toALStorageUnavailable(error);
        if (unavailable === undefined) {
            throw error;
        }
        this.input.storageHealth?.recordFailure(unavailable);
        return unavailable;
    }
}
