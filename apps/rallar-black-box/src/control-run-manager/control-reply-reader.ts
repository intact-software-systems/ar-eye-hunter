import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ControlRunManagerHttpError } from '../control-http-error.ts';

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

export async function readAcknowledgedJsonResponse(response: Response): Promise<void> {
    await readJsonResponseDocument<ApiJsonValue>(response);
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
    const document = await readJsonResponseDocument<T>(response);
    return document.value;
}

export async function readJsonResponseDocument<T>(
    response: Response
): Promise<ControlResponseDocument<T>> {
    const text = await response.text();
    const body = decodeControlReplyBody(text);
    if (!response.ok) {
        throw new ControlRunManagerHttpError(
            toControlErrorMessage(response, body),
            response.status,
            response.statusText
        );
    }
    if (body.kind === 'unparsed') {
        throw body.error;
    }
    return {
        value: (body.kind === 'json' ? body.value : {}) as T,
        text
    };
}

export async function readTextResponse(response: Response): Promise<string> {
    const text = await response.text();
    if (response.ok) {
        return text;
    }
    const body = decodeControlReplyBody(text);
    throw new ControlRunManagerHttpError(
        body.kind === 'unparsed' ? text : toControlErrorMessage(response, body),
        response.status,
        response.statusText
    );
}
