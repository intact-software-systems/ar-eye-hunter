import type { DistributedRunArtifactSnapshots } from '../distributed-artifact-analysis.ts';
import {
    MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT,
    type DistributedArtifactEvidenceEntry
} from '../distributed-artifact-evidence-contracts.ts';

/** Reads the next recorded raw value for an entry as JSON text cut to the text limit; empty when none is left. */
export type RawSearchValueReader = (entry: DistributedArtifactEvidenceEntry) => string;

interface RecordedValueQueue<Recorded> {
    readonly values: Recorded[];
    offset: number;
}

/**
 * Raw values are matched to entries by agent, command and time, in recording order: a result entry reads result
 * envelopes and an event or diagnostic entry reads event payloads. The reader owns its read positions, and a value
 * becomes text only when an entry reads it.
 */
export function createRawSearchValueReader(snapshots: DistributedRunArtifactSnapshots): RawSearchValueReader {
    const { controlRun } = snapshots;
    const results = toRecordedValueQueues(
        controlRun.results,
        (result) => toEvidenceSearchKey(result.agentId, result.commandId, result.result?.endedAtEpochMs)
    );
    const events = toRecordedValueQueues(
        controlRun.events,
        (event) => toEvidenceSearchKey(event.agentId, event.commandId, event.atEpochMs)
    );
    return (entry) => {
        const key = toEvidenceSearchKey(entry.agentId, entry.commandId, entry.atEpochMs);
        if (entry.kind === 'result') {
            const result = takeRecordedValue(results.get(key));
            return result === undefined ? '' : decodeRawSearchValue(result);
        }
        if (entry.kind === 'event' || entry.kind === 'diagnostic') {
            const event = takeRecordedValue(events.get(key));
            return event === undefined ? '' : decodeRawSearchValue(event.payload);
        }
        return '';
    };
}

function toRecordedValueQueues<Recorded>(
    values: readonly Recorded[],
    toKey: (value: Recorded) => string
): ReadonlyMap<string, RecordedValueQueue<Recorded>> {
    const queues = new Map<string, RecordedValueQueue<Recorded>>();
    for (const value of values) {
        const key = toKey(value);
        const queue = queues.get(key);
        if (queue) {
            queue.values.push(value);
        }
        else {
            queues.set(key, { values: [value], offset: 0 });
        }
    }
    return queues;
}

/** Undefined when there is no queue for the key or every value in it has been read. */
function takeRecordedValue<Recorded>(queue: RecordedValueQueue<Recorded> | undefined): Recorded | undefined {
    if (queue === undefined) {
        return undefined;
    }
    const value = queue.values[queue.offset];
    queue.offset += 1;
    return value;
}

function toEvidenceSearchKey(
    agentId: string | undefined,
    commandId: string | undefined,
    atEpochMs: number | undefined
): string {
    return JSON.stringify([agentId ?? null, commandId ?? null, atEpochMs ?? null]);
}

/** A recorded value searches as its JSON text, or its string form when it has no JSON text, cut to the text limit. */
function decodeRawSearchValue(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    try {
        return JSON.stringify(value).slice(0, MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT);
    }
    catch {
        return String(value).slice(0, MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT);
    }
}
