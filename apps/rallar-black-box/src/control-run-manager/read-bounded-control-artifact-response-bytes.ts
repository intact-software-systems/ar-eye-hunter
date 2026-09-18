import { Either } from '@shared/resilience/Either.ts';
import { decodeControlReplyBody, toControlErrorMessage } from './control-reply-reader.ts';
import {
    createControlHttpFailure,
    createControlTransferLimitFailure,
    type ControlRequestFailure
} from './control-request-failure.ts';
import { readControlArtifactBodyBytes } from './read-control-artifact-body-bytes.ts';

const CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES = 64 * 1_024;

/**
 * Reads an artifact reply under a byte budget. A failed reply is read only far enough to carry its
 * message, so the budget for one is the smaller of the caller's limit and the error-body cap.
 */
export async function readBoundedControlArtifactResponseBytes(
    response: Response,
    maxBytes: number
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    const declaredBytes = toControlArtifactDeclaredByteLength(response);
    const maxResponseBytes = response.ok
        ? maxBytes
        : Math.min(maxBytes, CONTROL_ARTIFACT_ERROR_BODY_MAX_BYTES);
    if (declaredBytes !== undefined && declaredBytes > maxResponseBytes) {
        await cancelControlArtifactResponseBody(response);
        return Either.ofLeft(
            response.ok
                ? createControlTransferLimitFailure(maxResponseBytes)
                : toControlArtifactHttpFailure(response, undefined)
        );
    }
    const bytes = await readControlArtifactResponseBytes(response, maxResponseBytes, declaredBytes);
    return bytes.fold<Either<ControlRequestFailure, ArrayBuffer>>(
        (failure) =>
            Either.ofLeft(
                !response.ok && failure.kind === 'transfer-limit'
                    ? toControlArtifactHttpFailure(response, undefined)
                    : failure
            ),
        (value) =>
            response.ok
                ? Either.ofRight(value)
                : Either.ofLeft(toControlArtifactHttpFailure(response, value))
    );
}

async function readControlArtifactResponseBytes(
    response: Response,
    maxBytes: number,
    declaredBytes: number | undefined
): Promise<Either<ControlRequestFailure, ArrayBuffer>> {
    if (!response.body) {
        const bytes = await response.arrayBuffer();
        return bytes.byteLength > maxBytes
            ? Either.ofLeft(createControlTransferLimitFailure(maxBytes))
            : Either.ofRight(bytes);
    }
    return readControlArtifactBodyBytes({
        body: response.body,
        maxBytes,
        declaredBytes
    });
}

async function cancelControlArtifactResponseBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
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

function toControlArtifactHttpFailure(
    response: Response,
    /** Absent when the body was refused before any byte was read, so it carries no message. */
    bytes: ArrayBuffer | undefined
): ControlRequestFailure {
    const text = bytes ? new TextDecoder().decode(bytes) : '';
    return createControlHttpFailure(
        response,
        toControlErrorMessage(response, decodeControlReplyBody(text))
    );
}
