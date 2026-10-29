import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';
import { toAlmJsonPathValue, toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

export interface AlmReloadStorageEvidence {
    readonly sender: RecordedAlmConformanceParticipant;
    readonly checkpoint: AlmReloadCheckpoint;
    readonly prefix: readonly RallarBlackBoxTestCommand[];
    readonly suffix: readonly RallarBlackBoxTestCommand[];
    readonly send: RallarBlackBoxTestMessagesSendCommand;
}

/** The original document's two counter reads bracket the send, so its admission, work and write owners advance. */
export function assessAlmReloadStorage(evidence: AlmReloadStorageEvidence): readonly string[] {
    const { prefix, send, sender, checkpoint } = evidence;
    const counters = prefix.filter((command) => command.kind === 'storage.counters');
    const before = toRecordedAlmResultValue(sender, counters[0]);
    const held = toRecordedAlmResultValue(sender, counters[1]);
    const sameDocument = counters.length === 2 && counters.every((command) => command.reset !== true) &&
        prefix.indexOf(counters[0]) < prefix.indexOf(send) && prefix.indexOf(counters[1]) > prefix.indexOf(send) &&
        !prefix.slice(prefix.indexOf(counters[0]) + 1).some((command) => command.kind === 'rtc.connect');
    const admission = positiveCounterDelta(before, held, 'byOwner.al-admission');
    const work = positiveCounterDelta(before, held, 'byOwner.al-work');
    const write = positiveCounterDelta(before, held, 'byKind.write');
    const recovered = toRecordedAlmResultValue(sender, evidence.suffix.at(-1));
    return sameDocument && validStorageCounts(before) && validStorageCounts(held) && validStorageCounts(recovered) &&
            admission && work && write
        ? []
        : [`${checkpoint.key}: original-document storage must advance admission/work owners and atomic writes from its baseline.`];
}

function validStorageCounts(value: ApiJsonValue | undefined): boolean {
    if (!isJsonRecordValue(value) || !validCount(value.total) || !isJsonRecordValue(value.byOwner)) {
        return false;
    }
    return validCount(value.byOwner['al-admission']) && validCount(value.byOwner['al-work']) &&
        isJsonRecordValue(value.byKind) && Object.values(value.byKind).every(validCount);
}

function validCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveCounterDelta(
    before: ApiJsonValue | undefined,
    after: ApiJsonValue | undefined,
    path: string
): boolean {
    const value = toAlmJsonPathValue(before, path);
    // Native operation counts omit an unobserved kind; absence of the bucket itself is invalid evidence.
    const baseline =
        value === undefined && path.startsWith('byKind.') && isJsonRecordValue(toAlmJsonPathValue(before, 'byKind'))
            ? 0
            : value;
    const held = toAlmJsonPathValue(after, path);
    return typeof baseline === 'number' && Number.isFinite(baseline) && baseline >= 0 &&
        typeof held === 'number' && Number.isFinite(held) && held > baseline;
}
