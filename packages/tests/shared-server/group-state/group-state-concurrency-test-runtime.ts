import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

export class GroupBarrierRepository extends FakeRuntimeStateRepository {
    entryReadKeys: string[] = [];
    groupGuards = 0;
    presenceGuards = 0;
    presenceSummaryGuards = 0;
    conditionalOperations: string[] = [];
    hotPathListReads = 0;
    snapshotListReads = 0;
    serializeGroupTestTransactions = true;
    private groupReadsRemaining = 0;
    private groupReadsArrived = 0;
    private releaseGroupReads: (() => void) | undefined;
    private presenceReadsRemaining = 0;
    private presenceReadsArrived = 0;
    private releasePresenceReads: (() => void) | undefined;
    private admissionReadsRemaining = 0;
    private admissionReadsArrived = 0;
    private releaseAdmissionReads: (() => void) | undefined;
    private barrierTransactionTail: Promise<void> = Promise.resolve();
    private presenceSummaryConflictsRemaining = 0;
    private groupConflictsRemaining = 0;
    private presenceDeleteConflictsRemaining = 0;
    private conflictingGroupDisplayName: string | undefined;
    private heldGroupRead: ManualRepositoryGate | undefined;
    private heldGroupGuard: ManualRepositoryGate | undefined;

    failNextPresenceSummaryCas(): void {
        this.presenceSummaryConflictsRemaining = 1;
    }

    failNextGroupCas(count: number): void {
        this.groupConflictsRemaining = count;
    }

    failNextPresenceDelete(count: number): void {
        this.presenceDeleteConflictsRemaining = count;
    }

    conflictNextGroupDisplayName(displayName: string): void {
        this.conflictingGroupDisplayName = displayName;
    }

    armGroupReadBarrier(readers: number): void {
        this.groupReadsRemaining = readers;
        this.groupReadsArrived = 0;
    }

    armPresenceReadBarrier(readers: number): void {
        this.presenceReadsRemaining = readers;
        this.presenceReadsArrived = 0;
    }

    armAdmissionReadBarrier(readers: number): void {
        this.admissionReadsRemaining = readers;
        this.admissionReadsArrived = 0;
    }

    holdGroupReadsFor(key: string): ManualRepositoryGateControl {
        const gate = createManualRepositoryGate(key);
        this.heldGroupRead = gate;
        return gate.control(() => {
            if (this.heldGroupRead === gate) {
                this.heldGroupRead = undefined;
            }
        });
    }

    holdGroupGuardFor(key: string): ManualRepositoryGateControl {
        const gate = createManualRepositoryGate(key);
        this.heldGroupGuard = gate;
        return gate.control(() => {
            if (this.heldGroupGuard === gate) {
                this.heldGroupGuard = undefined;
            }
        });
    }

    resetGuards(): void {
        this.groupGuards = 0;
        this.presenceGuards = 0;
        this.presenceSummaryGuards = 0;
        this.conditionalOperations = [];
        this.hotPathListReads = 0;
        this.snapshotListReads = 0;
    }

    override findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        if (
            (namespace === 'group-state:members' || namespace === 'group-state:sessions') &&
            new Error().stack?.includes('readGroupMutation')
        ) {
            this.hotPathListReads += 1;
        }
        if (
            (namespace === 'group-state:members' || namespace === 'group-state:sessions') &&
            new Error().stack?.includes('readStableStateSnapshot')
        ) {
            this.snapshotListReads += 1;
        }
        return super.findEntriesByPrefix(namespace, keyPrefix);
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        this.entryReadKeys.push(key);
        const value = await super.findEntry(namespace, key);
        if (namespace === 'group-state:groups' && this.heldGroupRead?.key === key) {
            await this.heldGroupRead.arrive();
        }
        if (namespace === 'group-state:groups' && this.groupReadsRemaining > 0) {
            await this.waitAtBarrier('group');
        }
        if (namespace === 'group-state:sessions' && this.presenceReadsRemaining > 0) {
            await this.waitAtBarrier('presence');
        }
        if (namespace === 'group-state:presence-admissions' && this.admissionReadsRemaining > 0) {
            await this.waitAtBarrier('admission');
        }
        return value;
    }

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        if (!this.serializeGroupTestTransactions) {
            return await super.begin(fn);
        }
        let release!: () => void;
        const previous = this.barrierTransactionTail;
        this.barrierTransactionTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await super.begin(fn);
        }
        finally {
            release();
        }
    }

    override insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.conditionalOperations.push(`insert:${namespace}`);
        this.recordGuard(namespace);
        return super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }

    override async upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.conditionalOperations.push(`update:${namespace}`);
        this.recordGuard(namespace);
        if (namespace === 'group-state:groups' && this.heldGroupGuard?.key === key) {
            await this.heldGroupGuard.arrive();
        }
        if (
            namespace === 'group-state:groups' &&
            this.conflictingGroupDisplayName !== undefined &&
            JSON.parse(value).displayName === this.conflictingGroupDisplayName
        ) {
            this.conflictingGroupDisplayName = undefined;
            return { status: 'conflict' };
        }
        if (namespace === 'group-state:groups' && this.groupConflictsRemaining > 0) {
            this.groupConflictsRemaining -= 1;
            return { status: 'conflict' };
        }
        if (
            namespace === 'group-state:presence-summaries' &&
            this.presenceSummaryConflictsRemaining > 0
        ) {
            this.presenceSummaryConflictsRemaining -= 1;
            return { status: 'conflict' };
        }
        return await super.upsertIfRevision(namespace, key, value, expireAtTimestamp, expectedRevision);
    }

    override deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        this.conditionalOperations.push(`delete:${namespace}`);
        this.recordGuard(namespace);
        if (namespace === 'group-state:sessions' && this.presenceDeleteConflictsRemaining > 0) {
            this.presenceDeleteConflictsRemaining -= 1;
            return Promise.resolve({ status: 'conflict' });
        }
        return super.deleteIfRevision(namespace, key, expectedRevision);
    }

    private recordGuard(namespace: string): void {
        if (namespace === 'group-state:groups') {
            this.groupGuards += 1;
        }
        if (namespace === 'group-state:sessions') {
            this.presenceGuards += 1;
        }
        if (namespace === 'group-state:presence-summaries') {
            this.presenceSummaryGuards += 1;
        }
    }

    private async waitAtBarrier(kind: 'group' | 'presence' | 'admission'): Promise<void> {
        if (kind === 'group') {
            this.groupReadsArrived += 1;
            if (this.groupReadsArrived === this.groupReadsRemaining) {
                this.groupReadsRemaining = 0;
                this.releaseGroupReads?.();
                return;
            }
            await new Promise<void>((resolve) => {
                this.releaseGroupReads = resolve;
            });
            return;
        }
        if (kind === 'admission') {
            this.admissionReadsArrived += 1;
            if (this.admissionReadsArrived === this.admissionReadsRemaining) {
                this.admissionReadsRemaining = 0;
                this.releaseAdmissionReads?.();
                return;
            }
            await new Promise<void>((resolve) => {
                this.releaseAdmissionReads = resolve;
            });
            return;
        }
        this.presenceReadsArrived += 1;
        if (this.presenceReadsArrived === this.presenceReadsRemaining) {
            this.presenceReadsRemaining = 0;
            this.releasePresenceReads?.();
            return;
        }
        await new Promise<void>((resolve) => {
            this.releasePresenceReads = resolve;
        });
    }
}

type ManualRepositoryGateControl = Readonly<{
    firstArrival: Promise<void>;
    arrivalCount(): number;
    release(): void;
}>;

type ManualRepositoryGate = Readonly<{
    key: string;
    arrive(): Promise<void>;
    control(onRelease: () => void): ManualRepositoryGateControl;
}>;

function createManualRepositoryGate(key: string): ManualRepositoryGate {
    let arrivals = 0;
    let resolveFirstArrival!: () => void;
    let release!: () => void;
    const firstArrival = new Promise<void>((resolve) => {
        resolveFirstArrival = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        key,
        arrive: async () => {
            arrivals += 1;
            resolveFirstArrival();
            await released;
        },
        control: (onRelease) => ({
            firstArrival,
            arrivalCount: () => arrivals,
            release: () => {
                onRelease();
                release();
            }
        })
    };
}
