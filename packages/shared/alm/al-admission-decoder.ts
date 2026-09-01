import { toError } from '../resilience/to-error.ts';

/** Called once for each present record before it leaves the storage boundary. */
export type ALAdmissionDecoder<V> = (value: unknown, key: string) => V;

export class ALAdmissionCorruptionError extends Error {
    readonly key: string;

    constructor(key: string, cause: Error) {
        super(`Stored AL admission record is invalid at ${key}`, { cause });
        this.name = 'ALAdmissionCorruptionError';
        this.key = key;
    }
}

export function decodeALAdmissionValue<V>(
    value: unknown,
    key: string,
    decode: ALAdmissionDecoder<V>
): V {
    try {
        return decode(value, key);
    }
    catch (error) {
        throw error instanceof ALAdmissionCorruptionError
            ? error
            : new ALAdmissionCorruptionError(key, toError(error));
    }
}
