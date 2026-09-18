import { ControlRunManagerHttpError } from '../control-http-error.ts';
import { decodeControlReplyBody, toControlErrorMessage } from './control-reply-reader.ts';

const CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES = 64 * 1_024;

export async function readBoundedControlArtifactResponseBytes(
    response: Response,
    maxBytes: number
): Promise<ArrayBuffer> {
    const declared = toControlArtifactDeclaredByteLength(response);
    const maxResponseBytes = response.ok
        ? maxBytes
        : Math.min(maxBytes, CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES);
    if (declared !== undefined && declared > maxResponseBytes) {
        try {
            await response.body?.cancel();
        }
        catch {
            // Preserve the bounded protocol error when cancellation itself fails.
        }
        if (!response.ok) {
            throwControlArtifactHttpError(response);
        }
        throw createControlArtifactTransferLimitError(maxResponseBytes);
    }
    let bytes: ArrayBuffer;
    try {
        bytes = await readBoundedControlArtifactBytes(
            response,
            maxResponseBytes,
            declared
        );
    }
    catch (error) {
        if (!response.ok && error instanceof ControlArtifactTransferLimitError) {
            throwControlArtifactHttpError(response);
        }
        throw error;
    }
    if (!response.ok) {
        throwControlArtifactHttpError(response, bytes);
    }
    return bytes;
}

async function readBoundedControlArtifactBytes(
    response: Response,
    maxBytes: number,
    declaredBytes: number | undefined
): Promise<ArrayBuffer> {
    if (!response.body) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) {
            throw createControlArtifactTransferLimitError(maxBytes);
        }
        return bytes;
    }
    const reader = response.body.getReader();
    try {
        const resizableResult = createResizableControlArtifactBuffer(
            declaredBytes ?? 0,
            maxBytes
        );
        if (resizableResult) {
            return await readResizableControlArtifactBytes(
                reader,
                resizableResult,
                maxBytes
            );
        }
        return declaredBytes === undefined
            ? await readControlArtifactChunks(reader, maxBytes)
            : await readDeclaredControlArtifactBytes(
                reader,
                declaredBytes,
                maxBytes
            );
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
): Promise<ArrayBuffer> {
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw createControlArtifactTransferLimitError(maxBytes);
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
    return result.transferToFixedLength();
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
): Promise<ArrayBuffer> {
    let result = new Uint8Array(declaredBytes);
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw createControlArtifactTransferLimitError(maxBytes);
        }
        const nextTotalBytes = totalBytes + value.byteLength;
        if (nextTotalBytes > result.byteLength) {
            const doubledCapacity = result.byteLength > Math.floor(maxBytes / 2)
                ? maxBytes
                : result.byteLength * 2;
            const expanded = new Uint8Array(Math.max(
                nextTotalBytes,
                doubledCapacity,
                1
            ));
            expanded.set(result.subarray(0, totalBytes));
            result = expanded;
        }
        result.set(value, totalBytes);
        totalBytes = nextTotalBytes;
    }
    return totalBytes === result.byteLength
        ? result.buffer
        : result.buffer.slice(0, totalBytes);
}

async function readControlArtifactChunks(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxBytes: number
): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
            await cancelControlArtifactReader(reader);
            throw createControlArtifactTransferLimitError(maxBytes);
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
    return result.buffer;
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

function toControlArtifactDeclaredByteLength(response: Response): number | undefined {
    const value = response.headers.get('content-length')?.trim();
    if (!value || !/^\d+$/.test(value)) {
        return undefined;
    }
    const declared = Number(value);
    return Number.isSafeInteger(declared)
        ? declared
        : undefined;
}

function throwControlArtifactHttpError(
    response: Response,
    /** Absent when the body was refused before any byte was read, so it carries no message. */
    bytes?: ArrayBuffer
): never {
    const text = bytes ? new TextDecoder().decode(bytes) : '';
    throw new ControlRunManagerHttpError(
        toControlErrorMessage(response, decodeControlReplyBody(text)),
        response.status,
        response.statusText
    );
}

class ControlArtifactTransferLimitError extends RangeError {}

function createControlArtifactTransferLimitError(
    maxBytes: number
): ControlArtifactTransferLimitError {
    return new ControlArtifactTransferLimitError(
        `Control artifact response exceeds the ${maxBytes}-byte transfer limit.`
    );
}
