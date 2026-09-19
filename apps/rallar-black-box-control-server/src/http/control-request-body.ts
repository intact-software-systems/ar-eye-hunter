import { Either } from '@shared/resilience/Either.ts';

import type { ControlHttpRejection } from './control-http-responses.ts';

export type ControlJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ControlJsonValue[]
    | { readonly [key: string]: ControlJsonValue; };

export interface ControlRequestBodyReader {
    readonly maxRequestBytes: number;
    readJsonBody(request: Request): Promise<Either<ControlHttpRejection, ControlJsonValue>>;
    readOptionalJsonBody(request: Request): Promise<Either<ControlHttpRejection, ControlJsonValue>>;
}

const PAYLOAD_TOO_LARGE_STATUS = 413;
const MALFORMED_PAYLOAD_STATUS = 400;

export function createControlRequestBodyReader(maxRequestBytes: number): ControlRequestBodyReader {
    return {
        maxRequestBytes,
        readJsonBody: (request) => readJsonBody({ request, maxRequestBytes, emptyBody: undefined }),
        readOptionalJsonBody: (request) => readJsonBody({ request, maxRequestBytes, emptyBody: {} })
    };
}

interface JsonBodyReadInput {
    readonly request: Request;
    readonly maxRequestBytes: number;
    readonly emptyBody: ControlJsonValue | undefined;
}

async function readJsonBody(input: JsonBodyReadInput): Promise<Either<ControlHttpRejection, ControlJsonValue>> {
    try {
        const text = await readTextBody(input.request, input.maxRequestBytes);
        return text.mapRight((bodyText) =>
            bodyText.length === 0 && input.emptyBody !== undefined
                ? input.emptyBody
                : JSON.parse(bodyText) as ControlJsonValue
        );
    }
    catch (error) {
        return Either.ofLeft(toMalformedPayload(error instanceof Error ? error.message : String(error)));
    }
}

async function readTextBody(request: Request, maxRequestBytes: number): Promise<Either<ControlHttpRejection, string>> {
    const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
        return Either.ofLeft(toPayloadTooLarge(declaredLength, maxRequestBytes));
    }

    const reader = request.body?.getReader();
    if (!reader) {
        return Either.ofRight('');
    }
    const decoder = new TextDecoder();
    let byteLength = 0;
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        byteLength += value.byteLength;
        if (byteLength > maxRequestBytes) {
            return Either.ofLeft(toPayloadTooLarge(byteLength, maxRequestBytes));
        }
        text += decoder.decode(value, { stream: true });
    }
    return Either.ofRight(text + decoder.decode());
}

export async function decodeControlMessageText(
    frame: unknown,
    maxRequestBytes: number
): Promise<Either<ControlHttpRejection, string>> {
    try {
        if (typeof frame === 'string') {
            const byteLength = new TextEncoder().encode(frame).byteLength;
            return byteLength > maxRequestBytes
                ? Either.ofLeft(toPayloadTooLarge(byteLength, maxRequestBytes))
                : Either.ofRight(frame);
        }
        if (frame instanceof ArrayBuffer) {
            return frame.byteLength > maxRequestBytes
                ? Either.ofLeft(toPayloadTooLarge(frame.byteLength, maxRequestBytes))
                : Either.ofRight(new TextDecoder().decode(frame));
        }
        if (frame instanceof Blob) {
            return frame.size > maxRequestBytes
                ? Either.ofLeft(toPayloadTooLarge(frame.size, maxRequestBytes))
                : Either.ofRight(await frame.text());
        }
        return Either.ofLeft(toMalformedPayload('Control message must be text or binary data.'));
    }
    catch (error) {
        return Either.ofLeft(toMalformedPayload(error instanceof Error ? error.message : String(error)));
    }
}

function toPayloadTooLarge(byteLength: number, maxRequestBytes: number): ControlHttpRejection {
    return {
        status: PAYLOAD_TOO_LARGE_STATUS,
        message: `Request payload is too large: ${byteLength} bytes exceeds ${maxRequestBytes} bytes.`
    };
}

function toMalformedPayload(message: string): ControlHttpRejection {
    return { status: MALFORMED_PAYLOAD_STATUS, message };
}
