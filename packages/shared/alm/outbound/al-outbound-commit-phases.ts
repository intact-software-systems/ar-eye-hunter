import type {
    ALOutboundCommitBundleOutcome,
    ALOutboundCommitOrigin,
    ALOutboundRuntimeDiagnosticsEvent
} from './al-outbound-message-runtime.ts';

export namespace ALOutboundCommitPhases {
    export interface Input {
        readonly senderId: string;
        readonly msgId: string;
        readonly typeId: string;
        readonly origin: ALOutboundCommitOrigin;
        readonly nowMs: () => number;
        readonly getReadOperationCount: () => number;
    }
}

/**
 * Splits one admission commit into the read chain it walked and the write transaction it opened,
 * so a slow commit says which of the two it spent. A commit that settles before the write reports
 * `not-attempted` with a zero commit duration, which is itself the answer to "did it commit?".
 */
export class ALOutboundCommitPhases {
    private readonly input: ALOutboundCommitPhases.Input;
    private readDurationMs = 0;
    private readOperationCount = 0;
    private commitDurationMs = 0;
    private commitOutcome: ALOutboundCommitBundleOutcome = 'not-attempted';

    constructor(input: ALOutboundCommitPhases.Input) {
        this.input = input;
    }

    async withReadPhase<T>(read: () => Promise<T>): Promise<T> {
        const startedAtMs = this.input.nowMs();
        const operationsBefore = this.input.getReadOperationCount();
        try {
            return await read();
        }
        finally {
            this.readDurationMs += this.elapsedSince(startedAtMs);
            this.readOperationCount += this.input.getReadOperationCount() - operationsBefore;
        }
    }

    async withCommitPhase<TOutcome extends ALOutboundCommitBundleOutcome>(
        commit: () => Promise<TOutcome>
    ): Promise<TOutcome> {
        const startedAtMs = this.input.nowMs();
        try {
            const outcome = await commit();
            this.commitOutcome = outcome;
            return outcome;
        }
        finally {
            this.commitDurationMs += this.elapsedSince(startedAtMs);
        }
    }

    toEvent(): ALOutboundRuntimeDiagnosticsEvent {
        return {
            kind: 'commit-phases',
            senderId: this.input.senderId,
            msgId: this.input.msgId,
            typeId: this.input.typeId,
            origin: this.input.origin,
            readDurationMs: this.readDurationMs,
            readOperationCount: this.readOperationCount,
            commitDurationMs: this.commitDurationMs,
            commitOutcome: this.commitOutcome
        };
    }

    private elapsedSince(startedAtMs: number): number {
        return Math.max(0, this.input.nowMs() - startedAtMs);
    }
}
