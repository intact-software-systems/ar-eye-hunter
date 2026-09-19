import { Either } from '@shared/resilience/Either.ts';
import { createControlTransferLimitFailure, type ControlRequestFailure } from './control-request-failure.ts';

/**
 * Reads at most `maxBytes` of an artifact body. The reply's declared `content-length`, when the
 * server sent a usable one, chooses the strategy: a resizable buffer where the runtime has one, a
 * declared-length copy otherwise, and chunk accumulation when the length is unknown.
 */
export async function readControlArtifactBodyBytes(
    input: Readonly<{
        body: ReadableStream<Uint8Array>;
        maxBytes: number;
        /** Absent when the reply sent no usable `content-length`, so the size is unknown. */
        declaredBytes?: number;
    }>
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    const reader = input.body.getReader();
    try {
        const resizable = createResizableControlArtifactBuffer(
            input.declaredBytes ?? 0,
            input.maxBytes
        );
        if (resizable) {
            return await readResizableControlArtifactBytes(reader, resizable, input.maxBytes);
        }
        return input.declaredBytes === undefined
            ? await readControlArtifactChunks(reader, input.maxBytes)
            : await readDeclaredControlArtifactBytes(reader, input.declaredBytes, input.maxBytes);
    }
    finally {
        reader.releaseLock();
    }
}

type ResizableControlArtifactBuffer =
    & ArrayBuffer
    & Readonly<{
        maxByteLength: number;
        resizable: true;
    }>
    & {
        resize(byteLength: number): void;
        transferToFixedLength(): ArrayBuffer;
    };

/**
 * `ArrayBuffer` as the resizable-buffer proposal declares it. The repository's DOM lib predates
 * that constructor overload, so the runtime's own `ArrayBuffer` is read through this contract
 * after the prototype probe below proves the feature is present.
 */
type ResizableArrayBufferConstructor =
    & (new(
        byteLength: number,
        options: Readonly<{ maxByteLength: number; }>
    ) => ResizableControlArtifactBuffer)
    & ArrayBufferConstructor;

function resolveResizableArrayBufferConstructor(): ResizableArrayBufferConstructor | undefined {
    const prototype = ArrayBuffer.prototype as Partial<
        Pick<ResizableControlArtifactBuffer, 'resize' | 'transferToFixedLength'>
    >;
    return typeof prototype.resize === 'function' &&
            typeof prototype.transferToFixedLength === 'function'
        ? ArrayBuffer as ResizableArrayBufferConstructor
        : undefined;
}

function createResizableControlArtifactBuffer(
    initialBytes: number,
    maxBytes: number
): ResizableControlArtifactBuffer | undefined {
    const ResizableArrayBuffer = resolveResizableArrayBufferConstructor();
    if (!ResizableArrayBuffer) {
        return undefined;
    }
    try {
        const buffer = new ResizableArrayBuffer(initialBytes, {
            maxByteLength: maxBytes
        });
        return buffer.resizable ? buffer : undefined;
    }
    catch {
        return undefined;
    }
}

async function readResizableControlArtifactBytes(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    result: ResizableControlArtifactBuffer,
    maxBytes: number
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            return Either.ofLeft(createControlTransferLimitFailure(maxBytes));
        }
        const nextTotalBytes = totalBytes + value.byteLength;
        if (nextTotalBytes > result.byteLength) {
            result.resize(computeControlArtifactBufferCapacity(
                result.byteLength,
                nextTotalBytes,
                maxBytes
            ));
        }
        new Uint8Array(result, totalBytes, value.byteLength).set(value);
        totalBytes = nextTotalBytes;
    }
    if (result.byteLength !== totalBytes) {
        result.resize(totalBytes);
    }
    return Either.ofRight(result.transferToFixedLength());
}

function computeControlArtifactBufferCapacity(
    currentBytes: number,
    requiredBytes: number,
    maxBytes: number
): number {
    let capacity = Math.max(1, currentBytes);
    while (capacity < requiredBytes) {
        capacity = capacity > Math.floor(maxBytes / 2)
            ? maxBytes
            : capacity * 2;
    }
    return capacity;
}

async function readDeclaredControlArtifactBytes(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    declaredBytes: number,
    maxBytes: number
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    let result = new Uint8Array(declaredBytes);
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            return Either.ofLeft(createControlTransferLimitFailure(maxBytes));
        }
        const nextTotalBytes = totalBytes + value.byteLength;
        if (nextTotalBytes > result.byteLength) {
            const expanded = new Uint8Array(Math.max(
                nextTotalBytes,
                computeControlArtifactBufferCapacity(result.byteLength, nextTotalBytes, maxBytes),
                1
            ));
            expanded.set(result.subarray(0, totalBytes));
            result = expanded;
        }
        result.set(value, totalBytes);
        totalBytes = nextTotalBytes;
    }
    return Either.ofRight(
        totalBytes === result.byteLength
            ? result.buffer
            : result.buffer.slice(0, totalBytes)
    );
}

async function readControlArtifactChunks(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxBytes: number
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            return Either.ofLeft(createControlTransferLimitFailure(maxBytes));
        }
        totalBytes += value.byteLength;
        chunks.push(value);
    }
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return Either.ofRight(result.buffer);
}

async function cancelControlArtifactReader(
    reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
    try {
        await reader.cancel();
    }
    catch {
        // Preserve the bounded protocol error when cancellation itself fails.
    }
}
