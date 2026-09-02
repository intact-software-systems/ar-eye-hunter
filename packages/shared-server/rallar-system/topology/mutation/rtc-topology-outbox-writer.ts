export namespace RtcTopologyOutboxWriter {
    export interface Dependencies {
        readonly recordWrite: () => void;
    }
}

export class RtcTopologyOutboxWriter {
    private readonly dependencies: RtcTopologyOutboxWriter.Dependencies;

    constructor(dependencies: RtcTopologyOutboxWriter.Dependencies) {
        this.dependencies = dependencies;
    }

    recordCommitted(count: number = 1): void {
        for (let index = 0; index < count; index += 1) {
            try {
                this.dependencies.recordWrite();
            }
            catch {
                // Observability must never alter a committed topology write.
            }
        }
    }
}
