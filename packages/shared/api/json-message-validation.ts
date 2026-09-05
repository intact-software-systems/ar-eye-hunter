import { Either } from '../resilience/Either.ts';

export interface JsonMessageRejection {
    readonly code: 'oversized' | 'malformed';
    readonly message: string;
}

/** Measures native wire data without parsing, copying binary data, or encoding a complete text frame. */
export function validateJsonMessageSize<T>(value: T, maxBytes: number): Either<JsonMessageRejection, T> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        return Either.ofLeft({
            code: 'malformed',
            message: 'JSON message byte limit must be a non-negative safe integer'
        });
    }
    let bytes: number;
    if (typeof value === 'string') {
        bytes = measureBoundedUtf8(value, maxBytes);
    }
    else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        bytes = value.byteLength;
    }
    else if (typeof Blob !== 'undefined' && value instanceof Blob) {
        bytes = value.size;
    }
    else {
        return Either.ofLeft({ code: 'malformed', message: 'Expected native text or binary message data' });
    }
    return bytes > maxBytes
        ? Either.ofLeft({ code: 'oversized', message: 'Serialized JSON message exceeds the byte limit' })
        : Either.ofRight(value);
}

function measureBoundedUtf8(value: string, maxBytes: number): number {
    if (value.length > maxBytes) {
        return maxBytes + 1;
    }
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) {
            bytes++;
        }
        else if (code <= 0x7ff) {
            bytes += 2;
        }
        else if (
            code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
            value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff
        ) {
            bytes += 4;
            index++;
        }
        else {
            bytes += 3;
        }
        if (bytes > maxBytes) {
            return bytes;
        }
    }
    return bytes;
}
