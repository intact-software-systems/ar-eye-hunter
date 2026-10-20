import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

/** Only synchronous clock sampling runs inside the release callback; recording runs after return. */
export namespace PSqlQueueReleaseTiming {
    export interface Port {
        readMonotonicMs(): number;
        readEpochMs(): number;
        record(observation: Observation): void;
    }

    export interface Dependencies {
        readonly namespace: string;
        readonly port: Port;
    }

    export interface Invocation {
        readonly sequence: number;
        readonly startedAtMs: number | undefined;
        readonly anchorEpochMs: number | undefined;
        readonly anchorAfterMs: number | undefined;
    }

    export interface MemberSpan {
        readonly entry: ResourceEntry;
        readonly ordinal: number;
        readonly startedAtMs: number | undefined;
        readonly endedAtMs: number | undefined;
        readonly updated: boolean;
    }

    export interface Callback {
        readonly startedAtMs: number | undefined;
        readonly endedAtMs: number | undefined;
        readonly fallbackCount: number;
        readonly members: readonly MemberSpan[];
    }

    export interface Completion {
        readonly invocation: Invocation;
        readonly memberCount: number;
        readonly candidateStartedAtMs: number | undefined;
        readonly candidateEndedAtMs: number | undefined;
        readonly transactionCalledAtMs: number | undefined;
        readonly transactionReturnedAtMs: number | undefined;
        readonly callback: Callback;
    }

    export interface Member {
        readonly ordinal: number;
        readonly key: Key;
        readonly reservationAttempt: number;
        readonly reservationStartedAt: string | undefined;
        readonly reservationStartedAtEpochMs: number | undefined;
        readonly rowId: string | undefined;
        readonly updated: boolean;
        readonly startedAtMs: number;
        readonly endedAtMs: number;
        readonly releaseReservedElapsedMs: number;
    }

    export interface Boundaries {
        readonly releaseStartedAtMs: number;
        readonly candidateStartedAtMs: number;
        readonly candidateEndedAtMs: number;
        readonly transactionCalledAtMs: number;
        readonly callbackStartedAtMs: number;
        readonly callbackEndedAtMs: number;
        readonly transactionReturnedAtMs: number;
    }

    export interface Phases {
        readonly candidateElapsedMs: number;
        readonly transactionAdmissionElapsedMs: number;
        readonly callbackElapsedMs: number;
        readonly releaseReservedElapsedMs: number;
        readonly callbackRemainderElapsedMs: number;
        readonly transactionReturnElapsedMs: number;
        readonly releaseOwnerElapsedMs: number;
        readonly setupRemainderElapsedMs: number;
    }

    export type Observation =
        | {
            readonly namespace: string;
            readonly sequence: number;
            readonly outcome: 'succeeded' | 'failed';
            readonly availability: 'unavailable';
            readonly reason: 'release-failed' | 'invalid-clock' | 'projection-failed';
        }
        | {
            readonly namespace: string;
            readonly sequence: number;
            readonly outcome: 'succeeded';
            readonly availability: 'available';
            readonly memberCount: number;
            /** Local candidate only; attribution additionally requires a unique same-process worker/batch join. */
            readonly eligible: boolean;
            readonly truncated: boolean;
            readonly fallbackCount: number;
            readonly anchorEpochMs: number;
            readonly anchorMonotonicMs: number;
            readonly anchorUncertaintyMs: number;
            readonly boundaries: Boundaries;
            readonly phases: Phases;
            readonly members: readonly Member[];
        };
}

/** Queue-instance invocation identity and failure-contained elapsed evidence, never release authority. */
export class PSqlQueueReleaseTiming {
    private readonly dependencies: PSqlQueueReleaseTiming.Dependencies;
    private sequence = 0;

    constructor(dependencies: PSqlQueueReleaseTiming.Dependencies) {
        this.dependencies = dependencies;
    }

    start(): PSqlQueueReleaseTiming.Invocation {
        const startedAtMs = this.readMonotonicMs();
        let anchorEpochMs: number | undefined;
        try {
            const value = this.dependencies.port.readEpochMs();
            anchorEpochMs = Number.isFinite(value) && value >= 0 ? value : undefined;
        }
        catch {
            // An unavailable correlation anchor cannot affect the release.
        }
        return { sequence: ++this.sequence, startedAtMs, anchorEpochMs, anchorAfterMs: this.readMonotonicMs() };
    }

    readMonotonicMs(): number | undefined {
        try {
            const value = this.dependencies.port.readMonotonicMs();
            return Number.isFinite(value) && value >= 0 ? value : undefined;
        }
        catch {
            return undefined;
        }
    }

    recordSucceeded(completion: PSqlQueueReleaseTiming.Completion): void {
        try {
            this.record(toReleaseObservation(this.dependencies.namespace, completion));
        }
        catch {
            this.recordUnavailable(completion.invocation, 'succeeded', 'projection-failed');
        }
    }

    recordFailed(invocation: PSqlQueueReleaseTiming.Invocation): void {
        this.recordUnavailable(invocation, 'failed', 'release-failed');
    }

    private recordUnavailable(
        invocation: PSqlQueueReleaseTiming.Invocation,
        outcome: 'succeeded' | 'failed',
        reason: Extract<PSqlQueueReleaseTiming.Observation, { availability: 'unavailable'; }>['reason']
    ): void {
        this.record({
            namespace: this.dependencies.namespace,
            sequence: invocation.sequence,
            outcome,
            availability: 'unavailable',
            reason
        });
    }

    private record(observation: PSqlQueueReleaseTiming.Observation): void {
        try {
            this.dependencies.port.record(observation);
        }
        catch {
            // Optional output cannot reject a committed release or mask its original failure.
        }
    }
}

function toReleaseObservation(
    namespace: string,
    completion: PSqlQueueReleaseTiming.Completion
): PSqlQueueReleaseTiming.Observation {
    const { invocation, callback } = completion;
    const boundaries = toReleaseBoundaries(completion);
    if (invocation.anchorEpochMs === undefined || boundaries === undefined) {
        return {
            namespace,
            sequence: invocation.sequence,
            outcome: 'succeeded',
            availability: 'unavailable',
            reason: 'invalid-clock'
        };
    }
    const members = callback.members.map(toReleaseMember);
    const eligible = completion.memberCount === 16 && callback.fallbackCount === 0 &&
        new Set(members.map((member) => member.rowId)).size === 16 &&
        members.every((member) =>
            member.updated && member.rowId !== undefined && member.reservationStartedAt !== undefined
        );
    return {
        namespace,
        sequence: invocation.sequence,
        outcome: 'succeeded',
        availability: 'available',
        memberCount: completion.memberCount,
        eligible,
        truncated: completion.memberCount > 16,
        fallbackCount: callback.fallbackCount,
        anchorEpochMs: invocation.anchorEpochMs,
        anchorMonotonicMs: invocation.startedAtMs!,
        anchorUncertaintyMs: invocation.anchorAfterMs! - invocation.startedAtMs!,
        boundaries,
        phases: computeReleasePhases(boundaries, members),
        members
    };
}

function toReleaseBoundaries(
    completion: PSqlQueueReleaseTiming.Completion
): PSqlQueueReleaseTiming.Boundaries | undefined {
    const { invocation, callback } = completion;
    const endpoints = [
        invocation.startedAtMs,
        invocation.anchorAfterMs,
        completion.candidateStartedAtMs,
        completion.candidateEndedAtMs,
        completion.transactionCalledAtMs,
        callback.startedAtMs,
        ...callback.members.flatMap((member) => [member.startedAtMs, member.endedAtMs]),
        callback.endedAtMs,
        completion.transactionReturnedAtMs
    ];
    if (!hasOrderedEndpoints(endpoints)) {
        return undefined;
    }
    return {
        releaseStartedAtMs: invocation.startedAtMs!,
        candidateStartedAtMs: completion.candidateStartedAtMs!,
        candidateEndedAtMs: completion.candidateEndedAtMs!,
        transactionCalledAtMs: completion.transactionCalledAtMs!,
        callbackStartedAtMs: callback.startedAtMs!,
        callbackEndedAtMs: callback.endedAtMs!,
        transactionReturnedAtMs: completion.transactionReturnedAtMs!
    };
}

function hasOrderedEndpoints(endpoints: readonly (number | undefined)[]): boolean {
    let previous = -Infinity;
    for (const endpoint of endpoints) {
        if (endpoint === undefined || !Number.isFinite(endpoint) || endpoint < previous) {
            return false;
        }
        previous = endpoint;
    }
    return true;
}

function toReleaseMember(member: PSqlQueueReleaseTiming.MemberSpan): PSqlQueueReleaseTiming.Member {
    const { entry } = member;
    return {
        ordinal: member.ordinal,
        key: { ...entry.key },
        reservationAttempt: entry.dequeueAudit.attempts,
        reservationStartedAt: entry.dequeueAudit.startTs?.toString(),
        reservationStartedAtEpochMs: entry.dequeueAudit.startTs?.epochMilliseconds,
        rowId: entry.db?.id.toString(),
        updated: member.updated,
        startedAtMs: member.startedAtMs!,
        endedAtMs: member.endedAtMs!,
        releaseReservedElapsedMs: member.endedAtMs! - member.startedAtMs!
    };
}

function computeReleasePhases(
    boundaries: PSqlQueueReleaseTiming.Boundaries,
    members: readonly PSqlQueueReleaseTiming.Member[]
): PSqlQueueReleaseTiming.Phases {
    const candidateElapsedMs = boundaries.candidateEndedAtMs - boundaries.candidateStartedAtMs;
    const transactionAdmissionElapsedMs = boundaries.callbackStartedAtMs - boundaries.transactionCalledAtMs;
    const callbackElapsedMs = boundaries.callbackEndedAtMs - boundaries.callbackStartedAtMs;
    const transactionReturnElapsedMs = boundaries.transactionReturnedAtMs - boundaries.callbackEndedAtMs;
    const releaseOwnerElapsedMs = boundaries.transactionReturnedAtMs - boundaries.releaseStartedAtMs;
    const releaseReservedElapsedMs = members.reduce((elapsed, member) => elapsed + member.releaseReservedElapsedMs, 0);
    return {
        candidateElapsedMs,
        transactionAdmissionElapsedMs,
        callbackElapsedMs,
        releaseReservedElapsedMs,
        callbackRemainderElapsedMs: callbackElapsedMs - releaseReservedElapsedMs,
        transactionReturnElapsedMs,
        releaseOwnerElapsedMs,
        setupRemainderElapsedMs: releaseOwnerElapsedMs - candidateElapsedMs - transactionAdmissionElapsedMs -
            callbackElapsedMs - transactionReturnElapsedMs
    };
}
