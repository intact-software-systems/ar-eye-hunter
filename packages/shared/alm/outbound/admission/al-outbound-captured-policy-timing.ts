import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { Key, ResourceEntry } from '../../../queuebox/ResourceEntry.ts';

export namespace ALOutboundCapturedPolicyTiming {
    export interface Capability {
        createOwner(namespace: string): ALOutboundCapturedPolicyTiming;
    }

    export interface Port {
        readMonotonicMs(): number;
        readEpochMs(): number;
        record(observation: Observation): void;
    }

    export interface Identity {
        readonly namespace: string;
        readonly sequence: number;
        readonly key: Key | undefined;
        readonly msgId: string | undefined;
        readonly rowId: string | undefined;
        readonly reservationAttempt: number | undefined;
        readonly reservationStartedAtEpochMs: number | undefined;
    }

    export interface Phases {
        readonly readShape: 'parallel';
        readonly ownerEntryElapsedMs: number;
        /** Disjoint wall interval from starting the pair until both reads settle. */
        readonly combinedReadElapsedMs: number;
        /** Overlapping span including stored-message decoding; not additive to combinedReadElapsedMs. */
        readonly readStoredMessageElapsedMs: number;
        /** Includes captured-reference validation and its continuations. */
        readonly referenceValidationElapsedMs: number;
        /** Overlapping span; not additive to combinedReadElapsedMs. */
        readonly queueIdentityReadElapsedMs: number;
        /** Includes canonical decoding, equality and scope validation. */
        readonly canonicalValidationElapsedMs: number;
        readonly sessionReturnElapsedMs: number;
        readonly ownerElapsedMs: number;
    }

    export type Observation =
        & Identity
        & (
            | {
                readonly outcome: 'succeeded';
                readonly availability: 'available';
                readonly anchorEpochMs: number;
                readonly anchorMonotonicMs: number;
                readonly anchorUncertaintyMs: number;
                readonly phases: Phases;
            }
            | {
                readonly outcome: 'succeeded' | 'failed';
                readonly availability: 'unavailable';
                readonly reason: 'policy-failed' | 'invalid-clock' | 'projection-failed';
                readonly anchorEpochMs: number | undefined;
                readonly anchorMonotonicMs: number | undefined;
                readonly anchorUncertaintyMs: number | undefined;
            }
        );
}

/** One store instance owns the invocation sequence; each invocation retains only scalar boundaries. */
export class ALOutboundCapturedPolicyTiming {
    private sequence = 0;
    private readonly namespace: string;
    private readonly port: ALOutboundCapturedPolicyTiming.Port;

    constructor(
        namespace: string,
        port: ALOutboundCapturedPolicyTiming.Port
    ) {
        this.namespace = namespace;
        this.port = port;
    }

    start(): ALOutboundCapturedPolicyTimingInvocation {
        const sequence = ++this.sequence;
        const startedAtMs = this.readMonotonicMs();
        const anchorEpochMs = this.readEpochMs();
        const anchorAfterMs = this.readMonotonicMs();
        return new ALOutboundCapturedPolicyTimingInvocation({
            namespace: this.namespace,
            sequence,
            startedAtMs,
            anchorEpochMs,
            anchorAfterMs,
            port: this.port,
            readMonotonicMs: () => this.readMonotonicMs()
        });
    }

    private readMonotonicMs(): number | undefined {
        try {
            const value = this.port.readMonotonicMs();
            return Number.isFinite(value) && value >= 0 ? value : undefined;
        }
        catch {
            return undefined;
        }
    }

    private readEpochMs(): number | undefined {
        try {
            const value = this.port.readEpochMs();
            return Number.isFinite(value) && value >= 0 ? value : undefined;
        }
        catch {
            return undefined;
        }
    }
}

interface CreateALOutboundCapturedPolicyTimingInvocationInput {
    readonly namespace: string;
    readonly sequence: number;
    readonly startedAtMs: number | undefined;
    readonly anchorEpochMs: number | undefined;
    readonly anchorAfterMs: number | undefined;
    readonly port: ALOutboundCapturedPolicyTiming.Port;
    readonly readMonotonicMs: () => number | undefined;
}

interface ALOutboundCapturedPolicyBoundaries {
    readonly startedAtMs: number;
    readonly anchorAfterMs: number;
    readonly methodStartedAtMs: number;
    readonly storedReadStartedAtMs: number;
    readonly storedReadEndedAtMs: number;
    readonly identityReadStartedAtMs: number;
    readonly identityReadEndedAtMs: number;
    readonly readPairEndedAtMs: number;
    readonly referenceValidationEndedAtMs: number;
    readonly methodEndedAtMs: number;
    readonly ownerEndedAtMs: number;
}

/** The read owner marks its own actual boundaries; recording runs only after its session returns. */
export class ALOutboundCapturedPolicyTimingInvocation {
    private readonly input: CreateALOutboundCapturedPolicyTimingInvocationInput;
    private methodStartedAtMs: number | undefined;
    private storedReadStartedAtMs: number | undefined;
    private storedReadEndedAtMs: number | undefined;
    private identityReadStartedAtMs: number | undefined;
    private identityReadEndedAtMs: number | undefined;
    private readPairEndedAtMs: number | undefined;
    private referenceValidationEndedAtMs: number | undefined;
    private methodEndedAtMs: number | undefined;

    constructor(input: CreateALOutboundCapturedPolicyTimingInvocationInput) {
        this.input = input;
    }

    markMethodStart(): void {
        this.methodStartedAtMs = this.input.readMonotonicMs();
    }

    markStoredReadStart(): void {
        this.storedReadStartedAtMs = this.input.readMonotonicMs();
    }

    markStoredReadEnd(): void {
        this.storedReadEndedAtMs = this.input.readMonotonicMs();
    }

    markIdentityReadStart(): void {
        this.identityReadStartedAtMs = this.input.readMonotonicMs();
    }

    markIdentityReadEnd(): void {
        this.identityReadEndedAtMs = this.input.readMonotonicMs();
    }

    markReadPairEnd(): void {
        this.readPairEndedAtMs = this.input.readMonotonicMs();
    }

    markReferenceValidationEnd(): void {
        this.referenceValidationEndedAtMs = this.input.readMonotonicMs();
    }

    markMethodEnd(): void {
        this.methodEndedAtMs = this.input.readMonotonicMs();
    }

    record(outcome: 'succeeded' | 'failed', message: ALMessage, entry: ResourceEntry): void {
        const ownerEndedAtMs = this.input.readMonotonicMs();
        try {
            const identity: ALOutboundCapturedPolicyTiming.Identity = {
                namespace: this.input.namespace,
                sequence: this.input.sequence,
                key: entry.key,
                msgId: message.id.msgId,
                rowId: entry.db?.id,
                reservationAttempt: entry.dequeueAudit.attempts,
                reservationStartedAtEpochMs: entry.dequeueAudit.startTs?.epochMilliseconds
            };
            this.writeObservation(identity, outcome, ownerEndedAtMs);
        }
        catch {
            this.writeUnavailable(
                {
                    namespace: this.input.namespace,
                    sequence: this.input.sequence,
                    key: undefined,
                    msgId: undefined,
                    rowId: undefined,
                    reservationAttempt: undefined,
                    reservationStartedAtEpochMs: undefined
                },
                outcome,
                'projection-failed'
            );
        }
    }

    private writeObservation(
        identity: ALOutboundCapturedPolicyTiming.Identity,
        outcome: 'succeeded' | 'failed',
        ownerEndedAtMs: number | undefined
    ): void {
        if (outcome === 'failed') {
            this.writeUnavailable(identity, outcome, 'policy-failed');
            return;
        }
        const boundaries = this.getBoundaries(ownerEndedAtMs);
        const phases = boundaries === undefined ? undefined : computeALOutboundCapturedPolicyPhases(boundaries);
        if (this.input.anchorEpochMs === undefined || boundaries === undefined || phases === undefined) {
            this.writeUnavailable(identity, outcome, 'invalid-clock');
            return;
        }
        this.write({
            ...identity,
            outcome,
            availability: 'available',
            anchorEpochMs: this.input.anchorEpochMs,
            anchorMonotonicMs: boundaries.startedAtMs,
            anchorUncertaintyMs: boundaries.anchorAfterMs - boundaries.startedAtMs,
            phases
        });
    }

    private getBoundaries(ownerEndedAtMs: number | undefined): ALOutboundCapturedPolicyBoundaries | undefined {
        const candidate = {
            startedAtMs: this.input.startedAtMs,
            anchorAfterMs: this.input.anchorAfterMs,
            methodStartedAtMs: this.methodStartedAtMs,
            storedReadStartedAtMs: this.storedReadStartedAtMs,
            storedReadEndedAtMs: this.storedReadEndedAtMs,
            identityReadStartedAtMs: this.identityReadStartedAtMs,
            identityReadEndedAtMs: this.identityReadEndedAtMs,
            readPairEndedAtMs: this.readPairEndedAtMs,
            referenceValidationEndedAtMs: this.referenceValidationEndedAtMs,
            methodEndedAtMs: this.methodEndedAtMs,
            ownerEndedAtMs
        };
        if (
            !isOrdered([
                candidate.startedAtMs,
                candidate.anchorAfterMs,
                candidate.methodStartedAtMs,
                candidate.storedReadStartedAtMs,
                candidate.identityReadStartedAtMs
            ]) ||
            !isOrdered([
                candidate.storedReadStartedAtMs,
                candidate.storedReadEndedAtMs,
                candidate.readPairEndedAtMs,
                candidate.referenceValidationEndedAtMs,
                candidate.methodEndedAtMs,
                candidate.ownerEndedAtMs
            ]) ||
            !isOrdered([
                candidate.identityReadStartedAtMs,
                candidate.identityReadEndedAtMs,
                candidate.readPairEndedAtMs
            ])
        ) {
            return undefined;
        }
        return candidate as ALOutboundCapturedPolicyBoundaries;
    }

    private writeUnavailable(
        identity: ALOutboundCapturedPolicyTiming.Identity,
        outcome: 'succeeded' | 'failed',
        reason: 'policy-failed' | 'invalid-clock' | 'projection-failed'
    ): void {
        const startedAtMs = this.input.startedAtMs;
        const anchorAfterMs = this.input.anchorAfterMs;
        this.write({
            ...identity,
            outcome,
            availability: 'unavailable',
            reason,
            anchorEpochMs: this.input.anchorEpochMs,
            anchorMonotonicMs: startedAtMs,
            anchorUncertaintyMs:
                startedAtMs !== undefined && anchorAfterMs !== undefined && anchorAfterMs >= startedAtMs
                    ? anchorAfterMs - startedAtMs
                    : undefined
        });
    }

    private write(observation: ALOutboundCapturedPolicyTiming.Observation): void {
        try {
            this.input.port.record(observation);
        }
        catch {
            // Optional output cannot replace policy success or its original failure.
        }
    }
}

function computeALOutboundCapturedPolicyPhases(
    boundaries: ALOutboundCapturedPolicyBoundaries
): ALOutboundCapturedPolicyTiming.Phases | undefined {
    const phases = {
        readShape: 'parallel' as const,
        ownerEntryElapsedMs: boundaries.methodStartedAtMs - boundaries.startedAtMs,
        combinedReadElapsedMs: boundaries.readPairEndedAtMs - boundaries.methodStartedAtMs,
        readStoredMessageElapsedMs: boundaries.storedReadEndedAtMs - boundaries.storedReadStartedAtMs,
        referenceValidationElapsedMs: boundaries.referenceValidationEndedAtMs - boundaries.readPairEndedAtMs,
        queueIdentityReadElapsedMs: boundaries.identityReadEndedAtMs - boundaries.identityReadStartedAtMs,
        canonicalValidationElapsedMs: boundaries.methodEndedAtMs - boundaries.referenceValidationEndedAtMs,
        sessionReturnElapsedMs: boundaries.ownerEndedAtMs - boundaries.methodEndedAtMs,
        ownerElapsedMs: boundaries.ownerEndedAtMs - boundaries.startedAtMs
    };
    const sum = phases.ownerEntryElapsedMs + phases.combinedReadElapsedMs +
        phases.referenceValidationElapsedMs +
        phases.canonicalValidationElapsedMs + phases.sessionReturnElapsedMs;
    return Number.isFinite(sum) && Math.abs(sum - phases.ownerElapsedMs) <= 0.001 ? phases : undefined;
}

function isOrdered(values: readonly (number | undefined)[]): boolean {
    let previous = -Infinity;
    for (const value of values) {
        if (value === undefined || !Number.isFinite(value) || value < previous) {
            return false;
        }
        previous = value;
    }
    return true;
}
