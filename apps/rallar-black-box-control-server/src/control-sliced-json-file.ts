import { nowMs } from '@shared-server/rallar-system/observability/timing.ts';

export interface SlicedJsonFileWriteInput {
    readonly path: string;
    /** Written first and renamed over `path`, so a reader never sees a partial file. */
    readonly tempPath: string;
    /** Concatenates to the file's text; see `toJsonPieces`. */
    readonly pieces: Iterable<string>;
}

export interface SlicedJsonFileWrite {
    readonly written: boolean;
    readonly bytes: number;
    /** Time spent serializing and encoding, summed over the slices; the event loop runs between slices. */
    readonly serializeMs: number;
    readonly writeMs: number;
    /** Absent when the file was written. */
    readonly failure: string | undefined;
}

/** A 50-agent snapshot is tens of megabytes; serializing it in one call held every agent frame for seconds on the VM. */
const JSON_SLICE_LENGTH = 1024 * 1024;
/** Runs, their command/result/event lists and those lists' entries are serialized one entry at a time. */
const SLICED_DEPTH = 4;

type JsonPieceSource = string | number | boolean | bigint | symbol | null | undefined | object;

/**
 * Streams JSON text into a temporary file one slice at a time and renames it over the path. Each slice write awaits
 * the disk, so agent frames are handled between slices instead of after the whole serialization.
 */
export async function writeSlicedJsonFile(input: SlicedJsonFileWriteInput): Promise<SlicedJsonFileWrite> {
    const encoder = new TextEncoder();
    let bytes = 0;
    let serializeMs = 0;
    let writeMs = 0;
    try {
        await Deno.mkdir(toDirectory(input.path), { recursive: true });
        const file = await Deno.open(input.tempPath, { write: true, create: true, truncate: true });
        const writer = file.writable.getWriter();
        const slices = toJsonSlices(input.pieces);
        for (let startedMs = nowMs(), slice = slices.next(); !slice.done; startedMs = nowMs(), slice = slices.next()) {
            const encoded = encoder.encode(slice.value);
            const encodedMs = nowMs();
            serializeMs += encodedMs - startedMs;
            await writer.write(encoded);
            writeMs += nowMs() - encodedMs;
            bytes += encoded.length;
        }
        await writer.close();
        await Deno.rename(input.tempPath, input.path);
        return { written: true, bytes, serializeMs, writeMs, failure: undefined };
    }
    catch (error) {
        Deno.remove(input.tempPath).catch(() => undefined);
        const failure = error instanceof Error ? error.message : String(error);
        return { written: false, bytes, serializeMs, writeMs, failure };
    }
}

/** The pieces concatenate to `JSON.stringify(value)`; containers above the sliced depth are split at their entries. */
export function* toJsonPieces(value: JsonPieceSource, depth: number): Generator<string> {
    if (depth >= SLICED_DEPTH || value === null || typeof value !== 'object' || 'toJSON' in value) {
        yield JSON.stringify(value) ?? 'null';
        return;
    }
    if (Array.isArray(value)) {
        yield '[';
        for (const [index, item] of value.entries()) {
            yield index === 0 ? '' : ',';
            yield* isSkippedJsonValue(item) ? ['null'] : toJsonPieces(item, depth + 1);
        }
        yield ']';
        return;
    }
    let separator = '';
    yield '{';
    for (const [key, item] of Object.entries(value)) {
        if (!isSkippedJsonValue(item)) {
            yield `${separator}${JSON.stringify(key)}:`;
            yield* toJsonPieces(item, depth + 1);
            separator = ',';
        }
    }
    yield '}';
}

function* toJsonSlices(pieces: Iterable<string>): Generator<string> {
    let parts: string[] = [];
    let length = 0;
    for (const piece of pieces) {
        parts.push(piece);
        length += piece.length;
        if (length >= JSON_SLICE_LENGTH) {
            yield parts.join('');
            parts = [];
            length = 0;
        }
    }
    yield parts.join('');
}

function isSkippedJsonValue(value: JsonPieceSource): boolean {
    return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function toDirectory(path: string): string {
    const separator = path.lastIndexOf('/');
    return separator > 0 ? path.slice(0, separator) : '.';
}
