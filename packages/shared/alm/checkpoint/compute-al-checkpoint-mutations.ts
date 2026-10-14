import {
    computeIndexedDbQueueUnconditionalDelete,
    computeIndexedDbQueueUnconditionalPut,
    type ComputedIndexedDbQueueMutation
} from '../../queuebox/indexed-db-queue-box-entry.ts';
import type { ResourceEntry, ResourceEntryKeyString } from '../../queuebox/ResourceEntry.ts';
import type { ALAdmissionStoredValue } from '../al-admission-backend.ts';
import { INDEXED_DB_ADMISSION_FIRST_REVISION } from '../indexed-db-admission-fence.ts';
import type { IndexedDbAdmissionMutation } from '../write-indexed-db-admission-mutations.ts';
import type { ALCheckpointDirtySet } from './al-checkpoint-dirty-set.ts';

export interface ComputeALCheckpointMutationsInput {
    readonly snapshot: ALCheckpointDirtySet.Snapshot;
    readonly peekAdmission: (key: string) => ALAdmissionStoredValue | undefined;
    readonly peekQueueEntry: (key: ResourceEntryKeyString) => ResourceEntry | undefined;
    /** One token for every row this checkpoint writes. */
    readonly writeToken: string;
}

/** The arguments of the one `writeIndexedDbAdmissionMutations` call a checkpoint makes. */
export interface ALCheckpointMutations {
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
}

/**
 * The checkpoint of one snapshot's dirty keys: each key's value as the memory pair holds it now, written
 * whole, or a delete when the pair holds none. The checkpoint is the rows' only writer and never reads
 * them first, so no mutation is conditional. The caller takes the snapshot and calls this in one turn.
 */
export function computeALCheckpointMutations(input: ComputeALCheckpointMutationsInput): ALCheckpointMutations {
    const mutations: IndexedDbAdmissionMutation[] = [];
    const queueMutations: ComputedIndexedDbQueueMutation[] = [];
    for (const { space, key } of input.snapshot.marks) {
        if (space === 'admission') {
            mutations.push(toAdmissionMutation(key, input.peekAdmission(key), input.writeToken));
        }
        else {
            const entry = input.peekQueueEntry(key);
            queueMutations.push(
                entry === undefined
                    ? computeIndexedDbQueueUnconditionalDelete(key)
                    : computeIndexedDbQueueUnconditionalPut(entry)
            );
        }
    }
    return { mutations, queueMutations };
}

function toAdmissionMutation(
    key: string,
    stored: ALAdmissionStoredValue | undefined,
    writeToken: string
): IndexedDbAdmissionMutation {
    return stored === undefined
        ? { kind: 'remove', key }
        : { kind: 'set', stored: { ...stored, writeToken, revision: INDEXED_DB_ADMISSION_FIRST_REVISION } };
}
