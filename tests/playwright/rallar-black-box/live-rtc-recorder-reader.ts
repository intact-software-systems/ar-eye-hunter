import { get as readHttp, type ClientRequest, type IncomingMessage } from 'node:http';
import { get as readHttps } from 'node:https';
import { StringDecoder } from 'node:string_decoder';

import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { jsonRecord, stringValue, type LiveRtcJsonRecord } from './live-rtc-evidence-json.ts';
import { LIVE_RTC_LIFECYCLE_LIMITS, toLiveRtcRecorderRow } from './live-rtc-recorder-rows.ts';

export interface LiveRtcRecorderRead {
    readonly jsonl: string;
    readonly bytesRead: number;
    readonly retainedBytes: number;
    readonly retainedPrefixDropped: boolean;
    readonly transportTruncated: boolean;
}

export interface LiveRtcRecorderFailure {
    readonly code:
        | 'unsupported-endpoint'
        | 'http-unavailable'
        | 'runtime-read-failed'
        | 'malformed-jsonl'
        | 'input-limit'
        | 'browser-event-missing';
    readonly cause: Error | null;
}

interface LiveRtcRecorderResponse {
    readonly response: IncomingMessage;
    readonly request: ClientRequest;
    readonly deadline: ReturnType<typeof setTimeout>;
}

export async function readLiveRtcRecorderJsonl(
    url: string
): Promise<Either<LiveRtcRecorderFailure, LiveRtcRecorderRead>> {
    const opened = await readLiveRtcRecorderResponse(url);
    if (!opened.right) {
        return Either.ofLeft(
            opened.left ?? { code: 'runtime-read-failed', cause: new Error('Recorder response missing.') }
        );
    }
    try {
        return Either.ofRight(await readLiveRtcRecorderBody(opened.right.response));
    }
    catch (cause) {
        return Either.ofLeft({ code: 'runtime-read-failed', cause: toError(cause) });
    }
    finally {
        stopLiveRtcRecorderResponse(opened.right);
    }
}

export async function readLiveRtcBrowserEvent(url: string): Promise<Either<LiveRtcRecorderFailure, true>> {
    const opened = await readLiveRtcRecorderResponse(url);
    if (!opened.right) {
        return Either.ofLeft(
            opened.left ?? { code: 'runtime-read-failed', cause: new Error('Recorder response missing.') }
        );
    }
    try {
        return await readLiveRtcBrowserEventPrefix(opened.right.response);
    }
    catch (cause) {
        return Either.ofLeft({ code: 'runtime-read-failed', cause: toError(cause) });
    }
    finally {
        stopLiveRtcRecorderResponse(opened.right);
    }
}

function isLiveRtcBrowserEvent(row: LiveRtcJsonRecord): boolean {
    const topic = stringValue(jsonRecord(row.value)?.topic);
    return row.kind === 'rtc-diagnostic' && row.status === 'event' &&
        stringValue(row.agentId) !== undefined &&
        topic !== undefined && (topic === 'rallar.browser' || topic.startsWith('rallar.browser.'));
}

function toLiveRtcBrowserEventProof(line: string): Either<LiveRtcRecorderFailure, boolean> {
    if (!line.trim()) {
        return Either.ofRight(false);
    }
    const row = toLiveRtcRecorderRow(line);
    return row
        ? Either.ofRight(isLiveRtcBrowserEvent(row))
        : Either.ofLeft({ code: 'malformed-jsonl', cause: null });
}

async function readLiveRtcBrowserEventPrefix(response: IncomingMessage): Promise<Either<LiveRtcRecorderFailure, true>> {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let bytesRead = 0;
    let scannedRows = 0;
    for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        const remaining = LIVE_RTC_LIFECYCLE_LIMITS.inputBytes - bytesRead;
        pending += decoder.write(bytes.subarray(0, remaining));
        bytesRead += Math.min(bytes.length, remaining);
        let delimiter = pending.indexOf('\n');
        while (delimiter >= 0) {
            if (++scannedRows > LIVE_RTC_LIFECYCLE_LIMITS.scannedRows) {
                return Either.ofLeft({ code: 'input-limit', cause: null });
            }
            const proof = toLiveRtcBrowserEventProof(pending.slice(0, delimiter));
            if (proof.left) {
                return Either.ofLeft(proof.left);
            }
            if (proof.right) {
                return Either.ofRight(true);
            }
            pending = pending.slice(delimiter + 1);
            delimiter = pending.indexOf('\n');
        }
        if (bytes.length > remaining) {
            return Either.ofLeft({ code: 'input-limit', cause: null });
        }
    }
    if (pending.trim() && scannedRows >= LIVE_RTC_LIFECYCLE_LIMITS.scannedRows) {
        return Either.ofLeft({ code: 'input-limit', cause: null });
    }
    const proof = toLiveRtcBrowserEventProof(pending + decoder.end());
    if (proof.left) {
        return Either.ofLeft(proof.left);
    }
    return proof.right ? Either.ofRight(true) : Either.ofLeft({ code: 'browser-event-missing', cause: null });
}

async function readLiveRtcRecorderResponse(
    url: string
): Promise<Either<LiveRtcRecorderFailure, LiveRtcRecorderResponse>> {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const endpoint = new URL(url);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
            return Either.ofLeft({ code: 'unsupported-endpoint', cause: null });
        }
        request = (endpoint.protocol === 'https:' ? readHttps : readHttp)(endpoint);
        const pending = request;
        deadline = setTimeout(() => {
            response?.destroy(new Error('RTC recorder deadline reached.'));
            pending.destroy(new Error('RTC recorder deadline reached.'));
        }, LIVE_RTC_LIFECYCLE_LIMITS.transportTimeoutMs);
        response = await new Promise<IncomingMessage>((resolve, reject) => {
            pending.once('response', resolve);
            pending.once('error', reject);
        });
        if (response.statusCode !== 200) {
            stopLiveRtcRecorderResponse({ response, request, deadline });
            return Either.ofLeft({ code: 'http-unavailable', cause: null });
        }
        return Either.ofRight({ response, request, deadline });
    }
    catch (cause) {
        clearTimeout(deadline);
        response?.destroy();
        request?.destroy();
        return Either.ofLeft({ code: 'runtime-read-failed', cause: toError(cause) });
    }
}

function stopLiveRtcRecorderResponse(opened: LiveRtcRecorderResponse): void {
    clearTimeout(opened.deadline);
    opened.response.destroy();
    opened.request.destroy();
}

async function readLiveRtcRecorderBody(response: IncomingMessage): Promise<LiveRtcRecorderRead> {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let retainedBytes = 0;
    let retainedPrefixDropped = false;
    let transportTruncated = false;
    for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        const remaining = LIVE_RTC_LIFECYCLE_LIMITS.transportBytes - bytesRead;
        chunks.push(bytes.subarray(0, remaining));
        bytesRead += Math.min(bytes.length, remaining);
        retainedBytes += Math.min(bytes.length, remaining);
        while (retainedBytes > LIVE_RTC_LIFECYCLE_LIMITS.inputBytes) {
            const oldest = chunks[0];
            const discarded = Math.min(oldest.length, retainedBytes - LIVE_RTC_LIFECYCLE_LIMITS.inputBytes);
            if (discarded === oldest.length) {
                chunks.shift();
            }
            else {
                chunks[0] = oldest.subarray(discarded);
            }
            retainedBytes -= discarded;
            retainedPrefixDropped = true;
        }
        if (bytes.length > remaining) {
            transportTruncated = true;
            break;
        }
    }
    return {
        jsonl: Buffer.concat(chunks).toString('utf8'),
        bytesRead,
        retainedBytes,
        retainedPrefixDropped,
        transportTruncated
    };
}
