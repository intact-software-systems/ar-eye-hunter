import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';

/** Records only batches the fixture's owner constructs; observing completion starts no more work. */
export class ALWorkBatchTestObserver {
    private readonly publications = new Set<Promise<void>>();
    readonly batchObservations: typeof ALWorkBatchObservations;

    constructor() {
        const observer = this;
        this.batchObservations = class extends ALWorkBatchObservations {
            private readonly publication = Promise.withResolvers<void>();

            constructor() {
                super();
                observer.publications.add(this.publication.promise);
            }

            override publish(): void {
                try {
                    super.publish();
                }
                finally {
                    observer.publications.delete(this.publication.promise);
                    this.publication.resolve();
                }
            }
        };
    }

    /** Follow-ups are constructed before prior publication, so they enter the next captured set. */
    async waitForPublishedBatches(): Promise<void> {
        while (this.publications.size > 0) {
            await Promise.all([...this.publications]);
        }
    }
}
