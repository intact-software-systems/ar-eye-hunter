import { Either } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { isFiniteNumber, isNonEmptyText } from './artifact-json-value-guards.ts';

/** The request the Hetzner runner records in control-post-error-metadata.json when a control POST fails. */
export interface DistributedRunControlPostRequest {
    readonly phase: string;
    readonly method: string;
    readonly path: string;
    /** Absent when curl failed before the control server returned an HTTP status. */
    readonly httpStatus?: string;
    /** Absent when the runner failed the request before curl ran. */
    readonly curlStatus?: number;
    readonly exitStatus: number;
    /** Absent when the failed request returned no response body. */
    readonly responseFile?: string;
    readonly atEpochSeconds: number;
}

/** The runner writes `null` for an unrecorded status or response file; the decoder reads it as absent. */
export function decodeControlPostRequest(value: unknown): Either<string, DistributedRunControlPostRequest> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the request metadata must be a JSON object');
    }
    const { phase, method, path, httpStatus, curlStatus, exitStatus, responseFile, atEpochSeconds } = value;
    if (!isNonEmptyText(phase) || !isNonEmptyText(method) || !isNonEmptyText(path)) {
        return Either.ofLeft('phase, method and path must be non-empty strings');
    }
    if (httpStatus !== null && !isNonEmptyText(httpStatus)) {
        return Either.ofLeft('httpStatus must be a non-empty string or null');
    }
    if (curlStatus !== null && !isFiniteNumber(curlStatus)) {
        return Either.ofLeft('curlStatus must be a finite number or null');
    }
    if (!isFiniteNumber(exitStatus)) {
        return Either.ofLeft('exitStatus must be a finite number');
    }
    if (responseFile !== null && !isNonEmptyText(responseFile)) {
        return Either.ofLeft('responseFile must be a non-empty string or null');
    }
    if (!isFiniteNumber(atEpochSeconds)) {
        return Either.ofLeft('atEpochSeconds must be a finite number');
    }
    return Either.ofRight({
        phase,
        method,
        path,
        ...(httpStatus === null ? {} : { httpStatus }),
        ...(curlStatus === null ? {} : { curlStatus }),
        exitStatus,
        ...(responseFile === null ? {} : { responseFile }),
        atEpochSeconds
    });
}
