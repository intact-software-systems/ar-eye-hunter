import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { Key, ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionReadSession, ALAdmissionWorkBackend } from '../../al-admission-work-backend.ts';
import type { ALOutboundCapturedPolicy } from './al-outbound-admission-validation.ts';

export namespace ALOutboundCapturedPolicyTiming {
    export interface Capability {
        createOwner(namespace: string): ALOutboundCapturedPolicyTiming;
    }

    export interface Port {
        readMonotonicMs(): number;
        readEpochMs(): number;
        record(observation: Observation): void;
    }

    export interface ReadInput {
        readonly backend: ALAdmissionWorkBackend;
        readonly message: ALMessage;
        readonly entry: ResourceEntry;
        readonly readPolicy: (session: ALAdmissionReadSession) => Promise<ALOutboundCapturedPolicy>;
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
        readonly ownerEntryElapsedMs: number;
        /** Includes session.read and its supplied decoder; not SQL-only time. */
        readonly readStoredMessageElapsedMs: number;
        /** Includes continuations between the decoded read and queue read, not isolated validation CPU. */
        readonly referenceValidationElapsedMs: number;
        readonly queueIdentityReadElapsedMs: number;
        /** Includes continuations after the queue read, not isolated validation CPU. */
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
                readonly reason: 'policy-failed' | 'invalid-clock' | 'projection-failed' | 'unexpected-read-topology';
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

    private start(): ALOutboundCapturedPolicyTimingInvocation {
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

    /** Wraps only this policy read's two existing session reads; the shared admission algorithm remains singular. */
    async readCapturedPolicy(input: ALOutboundCapturedPolicyTiming.ReadInput): Promise<ALOutboundCapturedPolicy> {
        const invocation = this.start();
        let succeeded = false;
        try {
            const policy = await input.backend.readWithin(async (session) => {
                invocation.markMethodStart();
                let storedReads = 0;
                let identityReads = 0;
                const measuredSession: ALAdmissionReadSession = {
                    read: async (key, decode) => {
                        if (++storedReads !== 1 || identityReads !== 0) {
                            invocation.markUnexpectedTopology();
                        }
                        const value = await session.read(key, decode);
                        invocation.markStoredReadEnd();
                        return value;
                    },
                    readWork: async (key) => {
                        if (storedReads !== 1 || ++identityReads !== 1) {
                            invocation.markUnexpectedTopology();
                        }
                        invocation.markIdentityReadStart();
                        const value = await session.readWork(key);
                        invocation.markIdentityReadEnd();
                        return value;
                    },
                    list: (prefix, decode) => {
                        invocation.markUnexpectedTopology();
                        return session.list(prefix, decode);
                    }
                };
                const readPolicy = await input.readPolicy(measuredSession);
                if (storedReads !== 1 || identityReads !== 1) {
                    invocation.markUnexpectedTopology();
                }
                invocation.markMethodEnd();
                return readPolicy;
            });
            succeeded = true;
            return policy;
        }
        finally {
            invocation.record(succeeded ? 'succeeded' : 'failed', input.message, input.entry);
        }
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
    readonly storedReadEndedAtMs: number;
    readonly identityReadStartedAtMs: number;
    readonly identityReadEndedAtMs: number;
    readonly methodEndedAtMs: number;
    readonly ownerEndedAtMs: number;
}

/** The read owner marks its own actual boundaries; recording runs only after its session returns. */
class ALOutboundCapturedPolicyTimingInvocation {
    private readonly input: CreateALOutboundCapturedPolicyTimingInvocationInput;
    private methodStartedAtMs: number | undefined;
    private storedReadEndedAtMs: number | undefined;
    private identityReadStartedAtMs: number | undefined;
    private identityReadEndedAtMs: number | undefined;
    private methodEndedAtMs: number | undefined;
    private unexpectedReadTopology = false;

    constructor(input: CreateALOutboundCapturedPolicyTimingInvocationInput) {
        this.input = input;
    }

    markMethodStart(): void {
        this.methodStartedAtMs = this.input.readMonotonicMs();
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

    markMethodEnd(): void {
        this.methodEndedAtMs = this.input.readMonotonicMs();
    }

    markUnexpectedTopology(): void {
        this.unexpectedReadTopology = true;
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
        if (this.unexpectedReadTopology) {
            this.writeUnavailable(identity, outcome, 'unexpected-read-topology');
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
            storedReadEndedAtMs: this.storedReadEndedAtMs,
            identityReadStartedAtMs: this.identityReadStartedAtMs,
            identityReadEndedAtMs: this.identityReadEndedAtMs,
            methodEndedAtMs: this.methodEndedAtMs,
            ownerEndedAtMs
        };
        const points = Object.values(candidate);
        if (
            points.some((value) => value === undefined || !Number.isFinite(value)) ||
            points.some((value, index) => index > 0 && value! < points[index - 1]!)
        ) {
            return undefined;
        }
        return candidate as ALOutboundCapturedPolicyBoundaries;
    }

    private writeUnavailable(
        identity: ALOutboundCapturedPolicyTiming.Identity,
        outcome: 'succeeded' | 'failed',
        reason: 'policy-failed' | 'invalid-clock' | 'projection-failed' | 'unexpected-read-topology'
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
        ownerEntryElapsedMs: boundaries.methodStartedAtMs - boundaries.startedAtMs,
        readStoredMessageElapsedMs: boundaries.storedReadEndedAtMs - boundaries.methodStartedAtMs,
        referenceValidationElapsedMs: boundaries.identityReadStartedAtMs - boundaries.storedReadEndedAtMs,
        queueIdentityReadElapsedMs: boundaries.identityReadEndedAtMs - boundaries.identityReadStartedAtMs,
        canonicalValidationElapsedMs: boundaries.methodEndedAtMs - boundaries.identityReadEndedAtMs,
        sessionReturnElapsedMs: boundaries.ownerEndedAtMs - boundaries.methodEndedAtMs,
        ownerElapsedMs: boundaries.ownerEndedAtMs - boundaries.startedAtMs
    };
    const sum = phases.ownerEntryElapsedMs + phases.readStoredMessageElapsedMs +
        phases.referenceValidationElapsedMs + phases.queueIdentityReadElapsedMs +
        phases.canonicalValidationElapsedMs + phases.sessionReturnElapsedMs;
    return Number.isFinite(sum) && Math.abs(sum - phases.ownerElapsedMs) <= 0.001 ? phases : undefined;
}
