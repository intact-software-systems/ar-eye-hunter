import type { ALWorkObservationDeferral } from './al-work-handler.ts';

/** A capture-enabled batch owns these publications only until its mandatory lifecycle ends. */
export class ALWorkBatchObservations {
    private readonly observations: Array<() => void> = [];
    readonly defer: ALWorkObservationDeferral = (publish) => {
        this.observations.push(publish);
    };

    /** The selected class constructs its own optional resource; failure loses diagnostics, never work. */
    static tryCreate(): ALWorkBatchObservations | undefined {
        try {
            return new this();
        }
        catch {
            return undefined;
        }
    }

    /** Failed capture cannot let a producer interpret missing deferral as permission to publish immediately. */
    static discard(_publish: () => void): void {}

    publish(): void {
        for (const publish of this.observations) {
            try {
                publish();
            }
            catch { /* Optional evidence cannot change work lifecycle. */ }
        }
        this.observations.length = 0;
    }
}
