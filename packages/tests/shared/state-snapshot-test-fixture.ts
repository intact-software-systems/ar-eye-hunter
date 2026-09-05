import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { CompletedStateSnapshot } from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';

/** Reads actual captured wire envelopes through the production bounded assembler. */
export function assembleStateSnapshotMessages(
    messages: readonly unknown[],
    scope: StateScope,
    nowMs: number
): readonly CompletedStateSnapshot[] {
    const assembly = new StateSnapshotAssembly();
    const snapshots: CompletedStateSnapshot[] = [];
    try {
        for (const value of messages) {
            const message = decodePersistedALMessageValue(value);
            const result = assembly.accept({ message, scope, nowMs });
            if (result.left) {
                throw new TypeError(result.left.message);
            }
            if (result.right!.kind === 'complete') {
                snapshots.push(result.right!.snapshot);
            }
        }
        return snapshots;
    }
    finally {
        assembly.dispose();
    }
}
