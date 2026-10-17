import { createControlResponseHeaders } from '../cors.ts';

export interface ControlHttpRejection {
    readonly status: number;
    readonly message: string;
}

export interface ControlHttpResponses {
    readonly corsOrigins: readonly string[];
    json<TBody>(body: TBody, status: number): Response;
    /** Streams a bundle member by member instead of building one string for the whole bundle. */
    artifactBundle(bundle: ArtifactBundleJson, status: number): Response;
    text(text: string, status: number, contentType: string): Response;
    empty(status: number): Response;
    rejection(rejection: ControlHttpRejection): Response;
}

export interface ArtifactBundleJson {
    readonly files: Readonly<Record<string, string>>;
}

export function createControlHttpResponses(corsOrigins: readonly string[]): ControlHttpResponses {
    const toHeaders = (contentType: string | undefined) =>
        createControlResponseHeaders(undefined, { contentType, corsOrigins });
    return {
        corsOrigins,
        json: (body, status) => new Response(JSON.stringify(body), { status, headers: toHeaders('application/json') }),
        artifactBundle: (bundle, status) =>
            new Response(toUtf8Stream(toArtifactBundleJsonChunks(bundle)), {
                status,
                headers: toHeaders('application/json')
            }),
        text: (text, status, contentType) => new Response(text, { status, headers: toHeaders(contentType) }),
        empty: (status) => new Response(null, { status, headers: toHeaders(undefined) }),
        rejection: ({ status, message }) =>
            new Response(JSON.stringify({ error: message }), { status, headers: toHeaders('application/json') })
    };
}

/** Yields `JSON.stringify(bundle)` for a bundle whose files come last: its other fields, then each file as a chunk. */
export function* toArtifactBundleJsonChunks(bundle: ArtifactBundleJson): Generator<string> {
    const { files, ...fields } = bundle;
    const head = JSON.stringify(fields);
    yield `${head.slice(0, -1)}${head === '{}' ? '' : ','}"files":{`;
    let separator = '';
    for (const [fileName, text] of Object.entries(files)) {
        yield `${separator}${JSON.stringify(fileName)}:${JSON.stringify(text)}`;
        separator = ',';
    }
    yield '}}';
}

function toUtf8Stream(chunks: Iterator<string>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        pull(controller) {
            const next = chunks.next();
            if (next.done) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(next.value));
        }
    });
}
