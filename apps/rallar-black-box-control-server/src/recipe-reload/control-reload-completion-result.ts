import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import type { ControlServiceFailure } from '../control-service-failure.ts';

/** The result keeps its value and records that the cleanup it should have queued was refused. */
export function toReloadCleanupFailureResult(
    envelope: ControlResultEnvelope,
    cleanupFailure: ControlServiceFailure
): ControlResultEnvelope | undefined {
    if (!envelope.result || !isJsonRecordValue(envelope.result.value)) {
        return undefined;
    }
    return {
        ...envelope,
        result: { ...envelope.result, value: { ...envelope.result.value, cleanupFailure } }
    };
}

/** A failed reload completion whose cleanup was refused carries the refusal in its error details. */
export function toReloadCompletionResult(
    envelope: ControlResultEnvelope,
    cleanupFailure: ControlServiceFailure | undefined
): ControlResultEnvelope {
    if (cleanupFailure === undefined || !envelope.result) {
        return envelope;
    }
    return {
        ...envelope,
        result: { ...envelope.result, error: { ...envelope.result.error!, details: { cleanupFailure } } }
    };
}
