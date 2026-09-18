import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { createControlHttpFailure, type ControlRequestFailure } from './control-request-failure.ts';

export type ControlResponseDocument<T> = Readonly<{
    value: T;
    text: string;
}>;

/** A control reply body as it arrived: empty, valid JSON, or text the JSON parser rejected. */
type ControlReplyBody =
    | Readonly<{ kind: 'absent'; }>
    | Readonly<{ kind: 'json'; value: ApiJsonValue; }>
    | Readonly<{ kind: 'unparsed'; error: Error; }>;

export function decodeControlReplyBody(text: string): ControlReplyBody {
    if (text.length === 0) {
        return { kind: 'absent' };
    }
    try {
        return { kind: 'json', value: JSON.parse(text) as ApiJsonValue };
    }
    catch (error) {
        return { kind: 'unparsed', error: toError(error) };
    }
}

/** The message a failed reply carries in its own `error` field, else the HTTP status line. */
export function toControlErrorMessage(response: Response, body: ControlReplyBody): string {
    const carried = body.kind === 'json' ? toControlReplyErrorText(body.value) : undefined;
    return carried ?? toControlStatusMessage(response);
}

function toControlReplyErrorText(value: ApiJsonValue): string | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
            'error' in value
        ? String(value.error)
        : undefined;
}

function toControlStatusMessage(response: Response): string {
    return `Control server request failed: ${response.status} ${response.statusText}`;
}

export async function readJsonReply<T>(
    response: Response
): Promise<Either<ControlRequestFailure, T>> {
    const document = await readJsonReplyDocument<T>(response);
    return document.mapRight((carried) => carried.value);
}

export async function readJsonReplyDocument<T>(
    response: Response
): Promise<Either<ControlRequestFailure, ControlResponseDocument<T>>> {
    const text = await response.text();
    const body = decodeControlReplyBody(text);
    if (!response.ok) {
        return Either.ofLeft(
            createControlHttpFailure(response, toControlErrorMessage(response, body))
        );
    }
    if (body.kind === 'unparsed') {
        return Either.ofLeft({
            kind: 'undecodable-reply',
            message: body.error.message
        });
    }
    return Either.ofRight({
        value: (body.kind === 'json' ? body.value : {}) as T,
        text
    });
}

export async function readTextReply(
    response: Response
): Promise<Either<ControlRequestFailure, string>> {
    const text = await response.text();
    if (response.ok) {
        return Either.ofRight(text);
    }
    const body = decodeControlReplyBody(text);
    return Either.ofLeft(
        createControlHttpFailure(
            response,
            body.kind === 'unparsed' ? text : toControlErrorMessage(response, body)
        )
    );
}
