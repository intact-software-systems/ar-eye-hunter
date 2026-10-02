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

    constructor(input: ALStorageReadiness.Input) {
        this.input = input;
        this.opening = this.readOpen();
    }

    async ready(): Promise<ALStorageReadiness.Outcome> {
        this.opening ??= this.readOpen();
        const opened = await this.opening;
        if (opened.left !== undefined) {
            this.opening = undefined;
            return opened;
        }
        await this.input.startWork();
        return opened;
    }

    /** A read the idle engine makes: answered `whileUnavailable`, touching no storage, while the last open failed. */
    async readOpenedStore<T>(read: () => Promise<T>, whileUnavailable: T): Promise<T> {
        const opened = this.opening === undefined ? undefined : await this.opening;
        return opened?.right === undefined ? whileUnavailable : await read();
    }

    async runStoreOperation<T>(
        operation: () => Promise<T>,
        toAnswer: (unavailable: ALStorageUnavailable) => T
    ): Promise<T> {
        try {
            return await operation();
        }
        catch (error) {
            return toAnswer(this.recordStorageFailure(toError(error)));
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
