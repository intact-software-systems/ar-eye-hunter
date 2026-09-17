import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { RallarBlackBoxControlFetch } from '../control-client.ts';
import type { ControlEventEnvelope } from '../control-protocol.ts';

export interface WriteControlFinalReportInput {
    readonly fetch: RallarBlackBoxControlFetch;
    readonly uploadUrl: string;
    /** Absent when the control server admits the agent without a run token. */
    readonly token: string | undefined;
    readonly envelope: ControlEventEnvelope;
}

/** Uploads the final report envelope; the right value is the accepted HTTP status. */
export async function writeControlFinalReport(input: WriteControlFinalReportInput): Promise<Either<string, number>> {
    try {
        const response = await input.fetch(input.uploadUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(input.token ? { Authorization: `Bearer ${input.token}` } : {})
            },
            body: JSON.stringify(input.envelope)
        });
        return response.ok
            ? Either.ofRight(response.status)
            : Either.ofLeft(`Final report upload failed: ${response.status} ${response.statusText}`);
    }
    catch (caught) {
        return Either.ofLeft(toError(caught).message);
    }
}
