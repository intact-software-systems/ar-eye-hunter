import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../../../runtime/decode-runtime-result-values.ts';
import { decodePayloadPathValue } from '../../../wait/wait-event-match.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';

/** An authored command's recorded value in its JSON form: a leaf without one (NaN, Infinity) reads as null. */
export function toRecordedAlmResultValue(
    participant: RecordedAlmConformanceParticipant,
    command: RallarBlackBoxTestCommand | undefined
): ApiJsonValue | undefined {
    return command?.commandId ? decodeJsonValue(participant.results.get(command.commandId)?.value) : undefined;
}

export function toAlmJsonPathValue(value: ApiJsonValue | undefined, path: string): ApiJsonValue | undefined {
    const lookup = decodePayloadPathValue(value, path);
    return lookup.exists ? lookup.value : undefined;
}
