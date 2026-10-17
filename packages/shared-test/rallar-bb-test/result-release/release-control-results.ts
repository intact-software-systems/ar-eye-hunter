import { Either } from '@shared/resilience/Either.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import type { ResultReleaseOutcome } from './result-release-protocol.ts';

export interface ReleaseControlResultsInput {
    readonly controlBaseUrl: string;
    readonly runId: string;
    readonly agentId: string;
    readonly requestId: string;
    readonly commandIds: readonly string[];
    readonly token: string | undefined;
}

/** The caller ends future runtime references explicitly; success waits for the browser's actual release acknowledgement. */
export async function releaseControlResults(
    request: ReleaseControlResultsInput,
    fetch: typeof globalThis.fetch
): Promise<Either<string, ResultReleaseOutcome>> {
    const url = `${request.controlBaseUrl.replace(/\/$/, '')}/runs/${encodeURIComponent(request.runId)}/agents/${
        encodeURIComponent(request.agentId)
    }/results/release`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(request.token === undefined ? {} : { authorization: `Bearer ${request.token}` })
            },
            body: JSON.stringify({ requestId: request.requestId, commandIds: request.commandIds })
        });
        const value: unknown = await response.json();
        if (
            !response.ok || !isJsonRecordValue(value) || value.requestId !== request.requestId ||
            value.status !== 'released' || typeof value.releasedResults !== 'number' || typeof value.reason !== 'string'
        ) {
            return Either.ofLeft(`Result release was not acknowledged (${response.status}): ${JSON.stringify(value)}`);
        }
        return Either.ofRight({
            requestId: request.requestId,
            status: 'released',
            releasedResults: value.releasedResults,
            reason: value.reason
        });
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}
