import type { AppDataKey } from './app-data-repository.ts';

export namespace AppDataCorruptionError {
    export interface Input {
        readonly entry: AppDataKey;
        readonly reason: string;
        readonly cause?: Error;
    }
}

export class AppDataCorruptionError extends Error {
    readonly entry: AppDataKey;
    readonly reason: string;

    constructor(input: AppDataCorruptionError.Input) {
        super(
            `App data value ${input.entry.namespace}/${input.entry.storeName}/${input.entry.key} ${input.reason}`,
            input.cause === undefined ? undefined : { cause: input.cause }
        );
        this.name = 'AppDataCorruptionError';
        this.entry = input.entry;
        this.reason = input.reason;
    }
}
