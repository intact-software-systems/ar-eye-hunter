import { toError } from '../../resilience/to-error.ts';
import type { ALCheckpoint } from '../checkpoint/al-checkpoint.ts';
import type { IndexedDbAdmissionBackend } from '../indexed-db-admission-backend.ts';

/** One middleware's factory-owned AL databases; shared carriers borrow them until transport work has stopped. */
export class ALRuntimeStorage {
    private readonly backends = new Set<IndexedDbAdmissionBackend>();
    private readonly checkpoints = new Set<ALCheckpoint>();
    private closing: Promise<void> | undefined;

    ownBackend(backend: IndexedDbAdmissionBackend): void {
        if (this.closing !== undefined) {
            throw new Error('AL runtime storage is closed');
        }
        this.backends.add(backend);
    }

    ownCheckpoint(checkpoint: ALCheckpoint): void {
        if (this.closing !== undefined) {
            throw new Error('AL runtime storage is closed');
        }
        this.checkpoints.add(checkpoint);
    }

    /** Called after all carrier cleanup: final checkpoints precede closing their saved databases. */
    close(): Promise<void> {
        this.closing ??= this.closeStores();
        return this.closing;
    }

    private async closeStores(): Promise<void> {
        const outcomes = await Promise.allSettled([...this.checkpoints].map((checkpoint) => checkpoint.dispose()));
        outcomes.push(...await Promise.allSettled([...this.backends].map((backend) => backend.close())));
        this.checkpoints.clear();
        this.backends.clear();
        const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [toError(outcome.reason)] : []);
        if (failures.length > 0) {
            throw new AggregateError(failures, 'AL runtime storage cleanup failed');
        }
    }
}
