import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface RecorderJsonlProgress {
    readonly bytesRead: number;
    readonly decodedRecords: number;
}

export type RecorderJsonlRead =
    | (RecorderJsonlProgress & { readonly kind: 'row'; readonly row: ApiJsonObject; })
    | (RecorderJsonlProgress & { readonly kind: 'complete'; });

export interface RecorderJsonlFailure extends RecorderJsonlProgress {
    readonly code: 'runtime-read-failed' | 'malformed-jsonl' | 'input-limit';
    readonly cause: Error | null;
}

export async function* readRecorderJsonlRows(
    bytes: AsyncIterable<Uint8Array>,
    maximumRecordBytes: number
): AsyncGenerator<Either<RecorderJsonlFailure, RecorderJsonlRead>> {
    const decoder = new RecorderJsonlDecoder(maximumRecordBytes);
    try {
        for await (const chunk of bytes) {
            for (const read of decoder.decode(chunk)) {
                yield read;
                if (read.left) {
                    return;
                }
            }
        }
        yield* decoder.complete();
    }
    catch (cause) {
        yield Either.ofLeft({ ...decoder.progress, code: 'runtime-read-failed', cause: toError(cause) });
    }
}

class RecorderJsonlDecoder {
    readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    readonly #maximumRecordBytes: number;
    #pending = '';
    #rowBytes = 0;
    #bytesRead = 0;
    #decodedRecords = 0;

    constructor(maximumRecordBytes: number) {
        this.#maximumRecordBytes = maximumRecordBytes;
    }

    get progress(): RecorderJsonlProgress {
        return { bytesRead: this.#bytesRead, decodedRecords: this.#decodedRecords };
    }

    *decode(bytes: Uint8Array): Generator<Either<RecorderJsonlFailure, RecorderJsonlRead>> {
        this.#bytesRead += bytes.length;
        for (let cursor = 0; cursor < bytes.length;) {
            const delimiter = bytes.indexOf(10, cursor);
            const endedAt = delimiter < 0 ? bytes.length : delimiter;
            this.#rowBytes += endedAt - cursor;
            if (this.#rowBytes > this.#maximumRecordBytes) {
                yield Either.ofLeft({ ...this.progress, code: 'input-limit', cause: null });
                return;
            }
            try {
                this.#pending += this.#decoder.decode(bytes.subarray(cursor, endedAt), { stream: delimiter < 0 });
            }
            catch (cause) {
                yield Either.ofLeft({ ...this.progress, code: 'malformed-jsonl', cause: toError(cause) });
                return;
            }
            cursor = endedAt + 1;
            if (delimiter >= 0) {
                const read = this.#readRow();
                if (read) {
                    yield read;
                    if (read.left) {
                        return;
                    }
                }
                this.#pending = '';
                this.#rowBytes = 0;
            }
        }
    }

    *complete(): Generator<Either<RecorderJsonlFailure, RecorderJsonlRead>> {
        try {
            this.#pending += this.#decoder.decode();
        }
        catch (cause) {
            yield Either.ofLeft({ ...this.progress, code: 'malformed-jsonl', cause: toError(cause) });
            return;
        }
        const read = this.#readRow();
        if (read) {
            yield read;
            if (read.left) {
                return;
            }
        }
        yield Either.ofRight({ kind: 'complete', ...this.progress });
    }

    #readRow(): Either<RecorderJsonlFailure, RecorderJsonlRead> | undefined {
        if (!this.#pending.trim()) {
            return undefined;
        }
        const row = toRecorderJsonlRow(this.#pending);
        if (!row) {
            return Either.ofLeft({ ...this.progress, code: 'malformed-jsonl', cause: null });
        }
        this.#decodedRecords += 1;
        return Either.ofRight({ kind: 'row', row, ...this.progress });
    }
}

export function toRecorderJsonlRow(line: string): ApiJsonObject | null {
    try {
        const decoded: unknown = JSON.parse(line, (_key: string, value: ApiJsonValue) => {
            if (typeof value !== 'number') {
                return value;
            }
            return Number.isFinite(value) ? Object.is(value, -0) ? 0 : value : null;
        });
        return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
            ? decoded as ApiJsonObject
            : null;
    }
    catch {
        return null;
    }
}
