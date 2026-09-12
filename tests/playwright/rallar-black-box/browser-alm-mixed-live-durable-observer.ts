import {
    BROWSER_AL_RUNTIME_DB_NAME,
    toBrowserALRuntimeNamespace,
    toBrowserRtcRxALRuntimeStoreId
} from '../../../packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import type { RallarDiagnosticsPortsInput } from '../../../packages/shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { newALUnicastMessage } from '../../../packages/shared/al-contracts/al-contract.ts';
import { toALInboundPendingAdmissionId } from '../../../packages/shared/alm/inbound/al-inbound-pending-admission.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '../../../packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    AL_INBOUND_WORK_LEASE_MS,
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '../../../packages/shared/alm/inbound/al-inbound-work-entry.ts';
import {
    AL_ADMISSION_WORK_STORE_NAME
} from '../../../packages/shared/alm/open-indexed-db-admission-database.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '../../../packages/shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts
} from '../../../packages/shared/persistence/indexed-db-operation-observer.ts';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue
} from '../../../packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import { IndexedDbQueueBox } from '../../../packages/shared/queuebox/indexed-db-queue-box.ts';
import type {
    ResourceInboxReleaseDisposition,
    ResourceInboxReservationRequest,
    ResourceInboxTimeoutReservationRequest,
    ResourceInboxWorkPage
} from '../../../packages/shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    type ResourceEntry
} from '../../../packages/shared/queuebox/ResourceEntry.ts';
import {
    NativeIndexedDbTimingRecorder,
    type NativeIndexedDbTimingSnapshot
} from './browser-native-indexeddb-timing-recorder.ts';

export type MixedLiveDurableQueuePhaseKind =
    | 'queue-read'
    | 'claim-reserved'
    | 'release-completed'
    | 'release-retry'
    | 'release-terminal-failure';

export interface MixedLiveDurableQueuePhase {
    readonly identity: string;
    readonly payloadKind: string;
    readonly typeId: string | null;
    readonly phase: MixedLiveDurableQueuePhaseKind;
    readonly status: string;
    readonly attempts: number;
    readonly observedAtEpochMs: number;
    readonly leaseStartedAtEpochMs: number | null;
    readonly leaseUntilEpochMs: number | null;
    readonly leaseValidWhenReturned: boolean | null;
}

export interface MixedLiveDurableLiveObservation {
    readonly identity: string;
    readonly sequence: number;
    readonly sentAtEpochMs: number;
    readonly receivedAtEpochMs: number;
    readonly callbackStartedAtEpochMs: number;
    readonly callbackEndedAtEpochMs: number;
    readonly publicReceiveAgeMs: number;
    readonly callbackAgeMs: number;
    readonly markedForOverlap: boolean;
    readonly overlappingReturnedClaimIdentities: readonly string[];
    readonly overlappingReturnedClaimCount: number;
    readonly overlapBoundary: 'returned valid dispatch claim before live callback; durable callback not started';
}

export interface MixedLiveDurablePublicCallbackObservation {
    readonly identity: string;
    readonly receivedAtEpochMs: number;
    readonly callbackStartedAtEpochMs: number;
    readonly callbackEndedAtEpochMs: number;
    readonly publicReceiveAgeMs: number;
    readonly callbackAgeMs: number;
}

export interface MixedLiveDurableTerminalIdentity {
    readonly identity: string;
    readonly rowCount: number;
    readonly statuses: readonly string[];
    readonly completed: boolean;
}

export interface MixedLiveDurableObservationSnapshot {
    readonly schema: 'rallar.browser-alm-mixed-live-durable-observation.v1';
    readonly environment: {
        readonly userAgent: string;
        readonly hardwareConcurrency: number;
        readonly performanceTimeOriginEpochMs: number;
        readonly browserOrigin: string;
    };
    readonly clockProvenance: {
        readonly sendOrigin: 'sender Date.now epoch milliseconds';
        readonly publicReceive: 'Rallar public receivedAtEpochMs';
        readonly callback: 'receiver Date.now epoch milliseconds';
        readonly nativeDuration: 'receiver performance.now monotonic milliseconds';
    };
    readonly inboundNamespace: string | null;
    readonly databaseName: string;
    readonly storeName: string;
    readonly durableTypeId: string;
    readonly queuePhases: readonly MixedLiveDurableQueuePhase[];
    readonly liveObservations: readonly MixedLiveDurableLiveObservation[];
    readonly durableCallbacks: readonly MixedLiveDurablePublicCallbackObservation[];
    readonly inboundDiagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    readonly outboundDiagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
    readonly logicalOperationCounts: IndexedDbOperationCounts;
    readonly nativeTiming: NativeIndexedDbTimingSnapshot;
    readonly completedDurableIdentities: readonly string[];
    readonly droppedQueuePhaseCount: number;
    readonly droppedLiveObservationCount: number;
    readonly droppedDurableCallbackCount: number;
    readonly droppedInboundDiagnosticCount: number;
    readonly droppedOutboundDiagnosticCount: number;
    readonly droppedMarkedIdentityCount: number;
    readonly droppedReturnedClaimCount: number;
    readonly droppedCompletedIdentityCount: number;
    readonly queueHookModuleIdentityObserved: boolean;
    readonly callbackOverlapProbeCount: number;
    readonly observationSampleCapacity: number;
    readonly returnedClaimCapacity: number;
    readonly terminalReadbackRowCapacity: number;
    readonly terminalReadbackObservationCount: number;
    readonly terminalReadbackScannedRowCount: number;
    readonly terminalReadbackCensoredByRowCapacity: boolean;
    readonly capturedBoundaries: readonly string[];
    readonly uncapturedPhases: readonly string[];
    readonly methodsRestored: boolean;
}

export interface MixedLiveDurableObservationSemanticsProbe {
    readonly noClaimObservation: MixedLiveDurableLiveObservation;
    readonly overlapObservation: MixedLiveDurableLiveObservation;
    readonly queuePhases: readonly MixedLiveDurableQueuePhase[];
    readonly completedAfterParent: readonly string[];
    readonly completedAfterRetry: readonly string[];
    readonly afterRetryObservation: MixedLiveDurableLiveObservation;
    readonly completedDurableIdentities: readonly string[];
    readonly refusedIdentityObserved: boolean;
    readonly queueHookModuleIdentityObserved: boolean;
    readonly doubleInstallationRejected: boolean;
    readonly methodsRestored: boolean;
}

export interface InstallMixedLiveDurableObservationInput {
    readonly databaseName: string;
    readonly storeName: string;
    readonly durableTypeId: string;
    readonly markedDurableIdentities: readonly string[];
    readonly inboundNamespace?: string;
}

export interface ObserveMixedLiveMessageInput {
    readonly identity: string;
    readonly sequence: number;
    readonly sentAtEpochMs: number;
    readonly receivedAtEpochMs: number;
    readonly markedForOverlap: boolean;
}

export interface ObserveMixedDurableCallbackInput {
    readonly identity: string;
    readonly sentAtEpochMs: number;
    readonly receivedAtEpochMs: number;
}

const OBSERVATION_SAMPLE_CAPACITY = 20_000;
const NATIVE_SAMPLE_CAPACITY = 50_000;
const TERMINAL_READBACK_ROW_CAPACITY = 4_096;
const FAILED_RELEASE_STATUSES = new Set<string>([
    EntityStatus.FAILED,
    EntityStatus.ABORTED,
    EntityStatus.NON_RETRYABLE
]);

interface MixedLiveDurableObservationGlobal {
    __rallarMixedLiveDurableObservation?: MixedLiveDurableObservation;
}

interface MixedLiveDurableReturnedClaim {
    readonly identity: string;
    readonly returnedAtEpochMs: number;
    readonly leaseStartedAtEpochMs: number;
    readonly leaseUntilEpochMs: number;
}

interface MixedLiveDurableObservedLease {
    readonly startedAtEpochMs: number;
    readonly untilEpochMs: number;
    readonly validWhenReturned: boolean;
}

/** Owns bounded, payload-free browser evidence and exact QueueBox prototype restoration for one page. */
export class MixedLiveDurableObservation {
    readonly #databaseName: string;
    readonly #storeName: string;
    readonly #durableTypeId: string;
    readonly #markedDurableIdentities: Set<string>;
    readonly #logicalObserver = createCountingIndexedDbOperationObserver();
    readonly #nativeRecorder: NativeIndexedDbTimingRecorder;
    readonly #queuePhases: MixedLiveDurableQueuePhase[] = [];
    readonly #liveObservations: MixedLiveDurableLiveObservation[] = [];
    readonly #durableCallbacks: MixedLiveDurablePublicCallbackObservation[] = [];
    readonly #inboundDiagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    readonly #outboundDiagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    readonly #completedDurableIdentities = new Set<string>();
    readonly #returnedDispatchClaims = new Map<string, MixedLiveDurableReturnedClaim>();
    readonly #durableCallbackStarted = new Set<string>();
    readonly #originalReadWorkPage = IndexedDbQueueBox.prototype.readWorkPage;
    readonly #originalReadWorkPages = IndexedDbQueueBox.prototype.readWorkPages;
    readonly #originalReserveEntries = IndexedDbQueueBox.prototype.reserveEntries;
    readonly #originalReserveTimeoutEntries = IndexedDbQueueBox.prototype.reserveTimeoutEntries;
    readonly #originalReleaseEntries = IndexedDbQueueBox.prototype.releaseEntries;
    #inboundNamespace: string | undefined;
    #droppedQueuePhaseCount = 0;
    #droppedLiveObservationCount = 0;
    #droppedDurableCallbackCount = 0;
    #droppedInboundDiagnosticCount = 0;
    #droppedOutboundDiagnosticCount = 0;
    #droppedMarkedIdentityCount = 0;
    #droppedReturnedClaimCount = 0;
    #droppedCompletedIdentityCount = 0;
    #callbackOverlapProbeCount = 0;
    #terminalReadbackObservationCount = 0;
    #terminalReadbackScannedRowCount = 0;
    #terminalReadbackCensoredByRowCapacity = false;
    #queueHookModuleIdentityObserved = false;
    #disposed = false;

    constructor(input: InstallMixedLiveDurableObservationInput) {
        this.#databaseName = input.databaseName;
        this.#storeName = input.storeName;
        this.#durableTypeId = input.durableTypeId;
        this.#markedDurableIdentities = new Set(input.markedDurableIdentities.slice(0, OBSERVATION_SAMPLE_CAPACITY));
        this.#droppedMarkedIdentityCount = Math.max(
            0,
            input.markedDurableIdentities.length - OBSERVATION_SAMPLE_CAPACITY
        );
        this.#inboundNamespace = input.inboundNamespace;
        this.#nativeRecorder = new NativeIndexedDbTimingRecorder(NATIVE_SAMPLE_CAPACITY, input.databaseName);
        this.#nativeRecorder.start();
        try {
            this.installQueueObservation();
        }
        catch (error) {
            this.#nativeRecorder.stop();
            throw error;
        }
    }

    diagnosticsPorts(): RallarDiagnosticsPortsInput {
        return {
            indexedDbOperationObserver: this.#logicalObserver,
            inboundDiagnostics: (event) => this.recordInboundDiagnostic(event),
            outboundDiagnostics: (event) => this.recordOutboundDiagnostic(event)
        };
    }

    setBrowserSessionId(sessionId: string): void {
        if (this.#inboundNamespace !== undefined) {
            throw new Error('Mixed live/durable inbound namespace is already configured');
        }
        this.#inboundNamespace = toBrowserALRuntimeNamespace(toBrowserRtcRxALRuntimeStoreId(sessionId)) +
            ':inbound:admission';
    }

    addMarkedDurableIdentities(identities: readonly string[]): void {
        for (const identity of identities) {
            if (
                !this.#markedDurableIdentities.has(identity) &&
                this.#markedDurableIdentities.size >= OBSERVATION_SAMPLE_CAPACITY
            ) {
                this.#droppedMarkedIdentityCount += 1;
                continue;
            }
            this.#markedDurableIdentities.add(identity);
        }
    }

    observeLiveMessage(input: ObserveMixedLiveMessageInput): MixedLiveDurableLiveObservation {
        const callbackStartedAtEpochMs = Date.now();
        const overlappingReturnedClaimIdentities = input.markedForOverlap
            ? this.readOverlappingReturnedClaims(callbackStartedAtEpochMs)
            : [];
        if (input.markedForOverlap) {
            this.#callbackOverlapProbeCount += 1;
        }
        const observation: MixedLiveDurableLiveObservation = {
            ...input,
            callbackStartedAtEpochMs,
            callbackEndedAtEpochMs: Date.now(),
            publicReceiveAgeMs: input.receivedAtEpochMs - input.sentAtEpochMs,
            callbackAgeMs: callbackStartedAtEpochMs - input.sentAtEpochMs,
            overlappingReturnedClaimIdentities,
            overlappingReturnedClaimCount: overlappingReturnedClaimIdentities.length,
            overlapBoundary: 'returned valid dispatch claim before live callback; durable callback not started'
        };
        this.recordBounded(this.#liveObservations, observation, 'live');
        return observation;
    }

    observeDurableCallback(input: ObserveMixedDurableCallbackInput): void {
        const callbackStartedAtEpochMs = Date.now();
        const recorded = this.recordBounded(this.#durableCallbacks, {
            identity: input.identity,
            receivedAtEpochMs: input.receivedAtEpochMs,
            callbackStartedAtEpochMs,
            callbackEndedAtEpochMs: Date.now(),
            publicReceiveAgeMs: input.receivedAtEpochMs - input.sentAtEpochMs,
            callbackAgeMs: callbackStartedAtEpochMs - input.sentAtEpochMs
        }, 'durable');
        if (recorded) {
            this.#durableCallbackStarted.add(input.identity);
        }
    }

    stopNativeMeasurement(): void {
        this.#nativeRecorder.stop();
    }

    async readTerminalIdentities(): Promise<readonly MixedLiveDurableTerminalIdentity[]> {
        const rows = await this.readMarkedRows();
        this.#terminalReadbackObservationCount += 1;
        this.#terminalReadbackScannedRowCount = rows.scannedRowCount;
        this.#terminalReadbackCensoredByRowCapacity ||= rows.censoredByRowCapacity;
        return [...this.#markedDurableIdentities].sort().map((identity) => {
            const statuses = rows
                .filter((row) => row.identity === identity)
                .map((row) => row.entry.status)
                .sort();
            return {
                identity,
                rowCount: statuses.length,
                statuses,
                completed: statuses.length > 0 && statuses.every((status) => status === EntityStatus.COMPLETED)
            };
        });
    }

    dispose(): MixedLiveDurableObservationSnapshot {
        if (!this.#disposed) {
            this.#nativeRecorder.stop();
            this.restoreQueueObservation();
            this.#disposed = true;
            delete mixedLiveDurableObservationGlobal().__rallarMixedLiveDurableObservation;
        }
        return this.snapshot();
    }

    snapshot(): MixedLiveDurableObservationSnapshot {
        return {
            schema: 'rallar.browser-alm-mixed-live-durable-observation.v1',
            ...this.readEnvironmentSnapshot(),
            inboundNamespace: this.#inboundNamespace ?? null,
            databaseName: this.#databaseName,
            storeName: this.#storeName,
            durableTypeId: this.#durableTypeId,
            queuePhases: this.#queuePhases.filter((phase) => this.#markedDurableIdentities.has(phase.identity)),
            liveObservations: this.readScopedLiveObservations(),
            durableCallbacks: [...this.#durableCallbacks],
            inboundDiagnostics: [...this.#inboundDiagnostics],
            outboundDiagnostics: [...this.#outboundDiagnostics],
            logicalOperationCounts: this.#logicalObserver.getCounts(),
            nativeTiming: this.#nativeRecorder.snapshot(),
            completedDurableIdentities: [...this.#completedDurableIdentities]
                .filter((identity) => this.#markedDurableIdentities.has(identity))
                .sort(),
            ...this.readBoundedCaptureSnapshot(),
            ...this.readTerminalReadbackSnapshot(),
            ...this.readBoundarySnapshot(),
            methodsRestored: this.methodsRestored()
        };
    }

    private readEnvironmentSnapshot(): Pick<MixedLiveDurableObservationSnapshot, 'environment' | 'clockProvenance'> {
        return {
            environment: {
                userAgent: navigator.userAgent,
                hardwareConcurrency: navigator.hardwareConcurrency,
                performanceTimeOriginEpochMs: performance.timeOrigin,
                browserOrigin: location.origin
            },
            clockProvenance: {
                sendOrigin: 'sender Date.now epoch milliseconds',
                publicReceive: 'Rallar public receivedAtEpochMs',
                callback: 'receiver Date.now epoch milliseconds',
                nativeDuration: 'receiver performance.now monotonic milliseconds'
            }
        };
    }

    private readScopedLiveObservations(): readonly MixedLiveDurableLiveObservation[] {
        return this.#liveObservations.map((observation) => {
            const overlappingReturnedClaimIdentities = observation.overlappingReturnedClaimIdentities
                .filter((identity) => this.#markedDurableIdentities.has(identity));
            return {
                ...observation,
                overlappingReturnedClaimIdentities,
                overlappingReturnedClaimCount: overlappingReturnedClaimIdentities.length
            };
        });
    }

    private readBoundedCaptureSnapshot(): Pick<
        MixedLiveDurableObservationSnapshot,
        | 'droppedQueuePhaseCount'
        | 'droppedLiveObservationCount'
        | 'droppedDurableCallbackCount'
        | 'droppedInboundDiagnosticCount'
        | 'droppedOutboundDiagnosticCount'
        | 'droppedMarkedIdentityCount'
        | 'droppedReturnedClaimCount'
        | 'droppedCompletedIdentityCount'
        | 'queueHookModuleIdentityObserved'
        | 'callbackOverlapProbeCount'
        | 'observationSampleCapacity'
        | 'returnedClaimCapacity'
    > {
        return {
            droppedQueuePhaseCount: this.#droppedQueuePhaseCount,
            droppedLiveObservationCount: this.#droppedLiveObservationCount,
            droppedDurableCallbackCount: this.#droppedDurableCallbackCount,
            droppedInboundDiagnosticCount: this.#droppedInboundDiagnosticCount,
            droppedOutboundDiagnosticCount: this.#droppedOutboundDiagnosticCount,
            droppedMarkedIdentityCount: this.#droppedMarkedIdentityCount,
            droppedReturnedClaimCount: this.#droppedReturnedClaimCount,
            droppedCompletedIdentityCount: this.#droppedCompletedIdentityCount,
            queueHookModuleIdentityObserved: this.#queueHookModuleIdentityObserved,
            callbackOverlapProbeCount: this.#callbackOverlapProbeCount,
            observationSampleCapacity: OBSERVATION_SAMPLE_CAPACITY,
            returnedClaimCapacity: OBSERVATION_SAMPLE_CAPACITY
        };
    }

    private readTerminalReadbackSnapshot(): Pick<
        MixedLiveDurableObservationSnapshot,
        | 'terminalReadbackRowCapacity'
        | 'terminalReadbackObservationCount'
        | 'terminalReadbackScannedRowCount'
        | 'terminalReadbackCensoredByRowCapacity'
    > {
        return {
            terminalReadbackRowCapacity: TERMINAL_READBACK_ROW_CAPACITY,
            terminalReadbackObservationCount: this.#terminalReadbackObservationCount,
            terminalReadbackScannedRowCount: this.#terminalReadbackScannedRowCount,
            terminalReadbackCensoredByRowCapacity: this.#terminalReadbackCensoredByRowCapacity
        };
    }

    private readBoundarySnapshot(): Pick<
        MixedLiveDurableObservationSnapshot,
        'capturedBoundaries' | 'uncapturedPhases'
    > {
        return {
            capturedBoundaries: [
                'scoped dispatch-local queue page returned',
                'scoped dispatch-local reservation returned with observed lease',
                'public durable callback started and ended',
                'public live callback started and ended',
                'scoped dispatch-local release returned with persisted outcome',
                ...(this.#terminalReadbackObservationCount > 0
                    ? ['post-measurement dispatch-local COMPLETED readback']
                    : [])
            ],
            uncapturedPhases: [
                'exact hidden admission-store commit attribution',
                'internal callback-only phases',
                'request-to-message causality',
                'exact scheduler timer causality'
            ]
        };
    }

    private installQueueObservation(): void {
        this.assertQueueMethodsUnchanged();
        const observer = this;
        IndexedDbQueueBox.prototype.readWorkPage = async function (request) {
            const page = await observer.#originalReadWorkPage.call(this, request);
            observer.observeQueueRead(page);
            observer.observeQueueModuleIdentity(this);
            return page;
        };
        IndexedDbQueueBox.prototype.readWorkPages = async function (requests) {
            const pages = await observer.#originalReadWorkPages.call(this, requests);
            for (const page of pages) {
                observer.observeQueueRead(page);
            }
            observer.observeQueueModuleIdentity(this);
            return pages;
        };
        IndexedDbQueueBox.prototype.reserveEntries = async function (request: ResourceInboxReservationRequest) {
            const reserved = await observer.#originalReserveEntries.call(this, request);
            observer.observeReturnedClaims(reserved.values());
            observer.observeQueueModuleIdentity(this);
            return reserved;
        };
        IndexedDbQueueBox.prototype.reserveTimeoutEntries = async function (
            request: ResourceInboxTimeoutReservationRequest
        ) {
            const reserved = await observer.#originalReserveTimeoutEntries.call(this, request);
            observer.observeReturnedClaims(reserved.values());
            observer.observeQueueModuleIdentity(this);
            return reserved;
        };
        IndexedDbQueueBox.prototype.releaseEntries = async function (
            entries: ResourceEntry[],
            disposition: ResourceInboxReleaseDisposition
        ) {
            const released = await observer.#originalReleaseEntries.call(this, entries, disposition);
            observer.observeReleasedEntries(released.values());
            observer.observeQueueModuleIdentity(this);
            return released;
        };
    }

    private restoreQueueObservation(): void {
        IndexedDbQueueBox.prototype.readWorkPage = this.#originalReadWorkPage;
        IndexedDbQueueBox.prototype.readWorkPages = this.#originalReadWorkPages;
        IndexedDbQueueBox.prototype.reserveEntries = this.#originalReserveEntries;
        IndexedDbQueueBox.prototype.reserveTimeoutEntries = this.#originalReserveTimeoutEntries;
        IndexedDbQueueBox.prototype.releaseEntries = this.#originalReleaseEntries;
    }

    private assertQueueMethodsUnchanged(): void {
        if (
            IndexedDbQueueBox.prototype.readWorkPage !== this.#originalReadWorkPage ||
            IndexedDbQueueBox.prototype.readWorkPages !== this.#originalReadWorkPages ||
            IndexedDbQueueBox.prototype.reserveEntries !== this.#originalReserveEntries ||
            IndexedDbQueueBox.prototype.reserveTimeoutEntries !== this.#originalReserveTimeoutEntries ||
            IndexedDbQueueBox.prototype.releaseEntries !== this.#originalReleaseEntries
        ) {
            throw new Error('Mixed live/durable QueueBox observation cannot stack over another hook');
        }
    }

    private methodsRestored(): boolean {
        return this.#nativeRecorder.methodsRestored &&
            IndexedDbQueueBox.prototype.readWorkPage === this.#originalReadWorkPage &&
            IndexedDbQueueBox.prototype.readWorkPages === this.#originalReadWorkPages &&
            IndexedDbQueueBox.prototype.reserveEntries === this.#originalReserveEntries &&
            IndexedDbQueueBox.prototype.reserveTimeoutEntries === this.#originalReserveTimeoutEntries &&
            IndexedDbQueueBox.prototype.releaseEntries === this.#originalReleaseEntries;
    }

    private observeQueueModuleIdentity(queue: IndexedDbQueueBox): void {
        this.#queueHookModuleIdentityObserved ||= queue.constructor === IndexedDbQueueBox;
    }

    private observeQueueRead(page: ResourceInboxWorkPage): void {
        this.observeQueueEntries(page.entries, 'queue-read');
    }

    private observeReleasedEntries(entries: Iterable<ResourceEntry>): void {
        for (const entry of entries) {
            const phase = toReleasePhase(entry.status);
            if (phase !== undefined) {
                this.observeQueueEntry(entry, phase);
            }
        }
    }

    private observeQueueEntries(entries: Iterable<ResourceEntry>, phase: MixedLiveDurableQueuePhaseKind): void {
        for (const entry of entries) {
            this.observeQueueEntry(entry, phase);
        }
    }

    private observeQueueEntry(
        entry: ResourceEntry,
        phase: MixedLiveDurableQueuePhaseKind,
        observedAtEpochMs: number = Date.now()
    ): void {
        const decoded = this.decodeScopedDispatchEntry(entry);
        if (decoded === undefined) {
            return;
        }
        const lease = readObservedLease(entry, observedAtEpochMs);
        this.recordBounded(this.#queuePhases, {
            identity: decoded.identity,
            payloadKind: decoded.payloadKind,
            typeId: decoded.typeId,
            phase,
            status: entry.status,
            attempts: entry.dequeueAudit.attempts,
            observedAtEpochMs,
            leaseStartedAtEpochMs: lease?.startedAtEpochMs ?? null,
            leaseUntilEpochMs: lease?.untilEpochMs ?? null,
            leaseValidWhenReturned: phase === 'claim-reserved' ? lease?.validWhenReturned ?? false : null
        }, 'queue');
        if (phase.startsWith('release-')) {
            this.#returnedDispatchClaims.delete(decoded.identity);
        }
        if (phase === 'release-completed' && entry.status === EntityStatus.COMPLETED) {
            if (
                this.#completedDurableIdentities.has(decoded.identity) ||
                this.#completedDurableIdentities.size < OBSERVATION_SAMPLE_CAPACITY
            ) {
                this.#completedDurableIdentities.add(decoded.identity);
            }
            else {
                this.#droppedCompletedIdentityCount += 1;
            }
        }
    }

    private decodeScopedDispatchEntry(entry: ResourceEntry): MixedLiveDurableDecodedEntry | undefined {
        if (this.#inboundNamespace === undefined || entry.typeId !== toALInboundWorkType(this.#inboundNamespace)) {
            return undefined;
        }
        const effect = decodeALInboundWorkEntry(entry, this.#inboundNamespace);
        if (effect.payload.kind !== 'dispatch-local') {
            return undefined;
        }
        return {
            entry,
            identity: effect.payload.message.msgId,
            payloadKind: effect.payload.kind,
            typeId: null
        };
    }

    private observeReturnedClaims(entries: Iterable<ResourceEntry>): void {
        const returnedAtEpochMs = Date.now();
        for (const entry of entries) {
            const decoded = this.decodeScopedDispatchEntry(entry);
            if (decoded === undefined) {
                continue;
            }
            const lease = readObservedLease(entry, returnedAtEpochMs);
            this.observeQueueEntry(entry, 'claim-reserved', returnedAtEpochMs);
            if (lease?.validWhenReturned === true) {
                if (
                    this.#returnedDispatchClaims.has(decoded.identity) ||
                    this.#returnedDispatchClaims.size < OBSERVATION_SAMPLE_CAPACITY
                ) {
                    this.#returnedDispatchClaims.set(decoded.identity, {
                        identity: decoded.identity,
                        returnedAtEpochMs,
                        leaseStartedAtEpochMs: lease.startedAtEpochMs,
                        leaseUntilEpochMs: lease.untilEpochMs
                    });
                }
                else {
                    this.#droppedReturnedClaimCount += 1;
                }
            }
        }
    }

    private readOverlappingReturnedClaims(callbackStartedAtEpochMs: number): readonly string[] {
        return [...this.#returnedDispatchClaims.values()]
            .filter((claim) =>
                claim.returnedAtEpochMs <= callbackStartedAtEpochMs &&
                claim.leaseStartedAtEpochMs <= callbackStartedAtEpochMs &&
                claim.leaseUntilEpochMs > callbackStartedAtEpochMs &&
                !this.#durableCallbackStarted.has(claim.identity)
            )
            .map((claim) => claim.identity)
            .sort();
    }

    private recordInboundDiagnostic(event: ALInboundRuntimeDiagnosticsEvent): void {
        this.recordBounded(this.#inboundDiagnostics, event, 'inbound');
    }

    private recordOutboundDiagnostic(event: ALOutboundRuntimeDiagnosticsEvent): void {
        this.recordBounded(this.#outboundDiagnostics, event, 'outbound');
    }

    private recordBounded<T>(
        target: T[],
        value: T,
        kind: 'queue' | 'live' | 'durable' | 'inbound' | 'outbound'
    ): boolean {
        if (target.length < OBSERVATION_SAMPLE_CAPACITY) {
            target.push(value);
            return true;
        }
        switch (kind) {
            case 'queue':
                this.#droppedQueuePhaseCount += 1;
                break;
            case 'live':
                this.#droppedLiveObservationCount += 1;
                break;
            case 'durable':
                this.#droppedDurableCallbackCount += 1;
                break;
            case 'inbound':
                this.#droppedInboundDiagnosticCount += 1;
                break;
            case 'outbound':
                this.#droppedOutboundDiagnosticCount += 1;
        }
        return false;
    }

    private async readMarkedRows(): Promise<MixedLiveDurableRows> {
        const inboundNamespace = this.#inboundNamespace;
        if (inboundNamespace === undefined) {
            throw new Error('Mixed live/durable inbound namespace is not configured');
        }
        const database = await openExistingDatabase(this.#databaseName);
        try {
            return await readBoundedMarkedRows({
                database,
                storeName: this.#storeName,
                inboundNamespace,
                markedDurableIdentities: this.#markedDurableIdentities,
                rowCapacity: TERMINAL_READBACK_ROW_CAPACITY
            });
        }
        finally {
            database.close();
        }
    }
}

interface MixedLiveDurableDecodedEntry {
    readonly entry: ResourceEntry;
    readonly identity: string;
    readonly payloadKind: string;
    readonly typeId: string | null;
}

interface MixedLiveDurableRows extends ReadonlyArray<MixedLiveDurableDecodedEntry> {
    readonly scannedRowCount: number;
    readonly censoredByRowCapacity: boolean;
}

interface ReadBoundedMarkedRowsInput {
    readonly database: IDBDatabase;
    readonly storeName: string;
    readonly inboundNamespace: string;
    readonly markedDurableIdentities: ReadonlySet<string>;
    readonly rowCapacity: number;
}

export function installBrowserMixedLiveDurableObservation(
    durableTypeId: string,
    markedDurableIdentities: readonly string[]
): MixedLiveDurableObservation {
    return installMixedLiveDurableObservation({
        databaseName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: AL_ADMISSION_WORK_STORE_NAME,
        durableTypeId,
        markedDurableIdentities
    });
}

export function installMixedLiveDurableObservation(
    input: InstallMixedLiveDurableObservationInput
): MixedLiveDurableObservation {
    const global = mixedLiveDurableObservationGlobal();
    if (global.__rallarMixedLiveDurableObservation !== undefined) {
        throw new Error('Mixed live/durable observation is already installed in this page');
    }
    const observation = new MixedLiveDurableObservation(input);
    global.__rallarMixedLiveDurableObservation = observation;
    return observation;
}

export function readMixedLiveDurableObservation(): MixedLiveDurableObservation {
    const observation = mixedLiveDurableObservationGlobal().__rallarMixedLiveDurableObservation;
    if (observation === undefined) {
        throw new Error('Mixed live/durable observation is not installed in this page');
    }
    return observation;
}

interface MixedLiveDurableSemanticsContext {
    readonly databaseName: string;
    readonly storeName: string;
    readonly inboundNamespace: string;
    readonly identity: string;
    readonly nowMs: number;
    readonly observation: MixedLiveDurableObservation;
    readonly queue: IndexedDbQueueBox;
}

interface MixedLiveDurableInitialDispatch {
    readonly entry: ResourceEntry;
    readonly page: ResourceInboxWorkPage;
    readonly noClaimObservation: MixedLiveDurableLiveObservation;
}

interface MixedLiveDurableClaimProbe {
    readonly overlapObservation: MixedLiveDurableLiveObservation;
    readonly completedAfterRetry: readonly string[];
    readonly afterRetryObservation: MixedLiveDurableLiveObservation;
}

export async function runMixedLiveDurableObservationSemanticsProbe(
    databaseId: string
): Promise<MixedLiveDurableObservationSemanticsProbe> {
    const context = createMixedLiveDurableSemanticsContext(databaseId);
    let input: Parameters<typeof toMixedLiveDurableSemanticsProbe>[0] | undefined;
    let snapshot: MixedLiveDurableObservationSnapshot | undefined;
    try {
        const initial = await observeInitialDispatch(context);
        const completedAfterParent = await observeCompletedAdmissionParent(context);
        const claim = await observeDispatchClaimAndRetry(context, initial);
        await observeCompletedDispatchEffect(context);
        const doubleInstallationRejected = rejectDoubleObservationInstallation(context);
        input = {
            initial,
            claim,
            completedAfterParent,
            doubleInstallationRejected,
            snapshot: context.observation.snapshot()
        };
    }
    finally {
        snapshot = context.observation.dispose();
    }
    if (input === undefined || snapshot === undefined) {
        throw new Error('Mixed live/durable semantics probe did not produce an observation');
    }
    return toMixedLiveDurableSemanticsProbe({ ...input, snapshot });
}

function createMixedLiveDurableSemanticsContext(databaseId: string): MixedLiveDurableSemanticsContext {
    const databaseName = `playwright-mixed-live-durable-${databaseId}`;
    const storeName = 'entries';
    const inboundNamespace = `mixed-live-durable:${databaseId}:inbound:admission`;
    const identity = 'durable-probe';
    const observer = createCountingIndexedDbOperationObserver();
    const observation = installMixedLiveDurableObservation({
        databaseName,
        storeName,
        durableTypeId: 'room.mixed-durable.v1',
        markedDurableIdentities: [identity, 'refused-probe'],
        inboundNamespace
    });
    const queue = new IndexedDbQueueBox({ dbName: databaseName, storeName, observer });
    return { databaseName, storeName, inboundNamespace, identity, nowMs: Date.now(), observation, queue };
}

async function observeInitialDispatch(
    context: MixedLiveDurableSemanticsContext
): Promise<MixedLiveDurableInitialDispatch> {
    const write = computeDispatchEntry(context, `effect-${context.identity}`);
    await context.queue.enqueueIfAbsent(write.entry);
    const noClaimObservation = context.observation.observeLiveMessage({
        identity: 'live-probe',
        sequence: 1,
        sentAtEpochMs: context.nowMs,
        receivedAtEpochMs: Date.now(),
        markedForOverlap: true
    });
    const page = await context.queue.readWorkPage({
        typeId: write.entry.typeId,
        status: EntityStatus.NEW,
        maxToRead: 1,
        cursor: null
    });
    return { entry: write.entry, page, noClaimObservation };
}

async function observeCompletedAdmissionParent(
    context: MixedLiveDurableSemanticsContext
): Promise<readonly string[]> {
    const originalMessage = newALUnicastMessage(
        'sender',
        { topicId: 'room.mixed-durable', resourceId: context.identity, contextId: 'room' },
        'receiver',
        'room.mixed-durable.v1',
        { identity: context.identity },
        { ttlMs: 30_000 }
    );
    const message = {
        ...originalMessage,
        constraints: { ...originalMessage.constraints, expiresAtMs: context.nowMs + 30_000 }
    };
    const parent = computeALInboundWorkEntry({
        namespace: context.inboundNamespace,
        effectId: toALInboundPendingAdmissionId(message),
        payload: { kind: 'admit-message', msg: message, source: { kind: 'ws-client', peerId: 'sender' } },
        observedAtMs: context.nowMs,
        expireAtTimestamp: context.nowMs + 30_000
    });
    await context.queue.enqueueIfAbsent(parent.entry);
    const reserved = await context.queue.reserveEntries({
        typeIds: new Set([parent.entry.typeId]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1,
        observedEntries: [parent.entry]
    });
    await context.queue.releaseEntries([...reserved.values()], { status: EntityStatus.COMPLETED, delayMs: null });
    return context.observation.snapshot().completedDurableIdentities;
}

async function observeDispatchClaimAndRetry(
    context: MixedLiveDurableSemanticsContext,
    initial: MixedLiveDurableInitialDispatch
): Promise<MixedLiveDurableClaimProbe> {
    const reserved = await context.queue.reserveEntries({
        typeIds: new Set([initial.entry.typeId]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1,
        observedEntries: initial.page.entries
    });
    const overlapObservation = context.observation.observeLiveMessage({
        identity: 'live-probe-after-claim',
        sequence: 2,
        sentAtEpochMs: context.nowMs,
        receivedAtEpochMs: Date.now(),
        markedForOverlap: true
    });
    await context.queue.releaseEntries([...reserved.values()], { status: EntityStatus.RETRY, delayMs: 30_000 });
    const completedAfterRetry = context.observation.snapshot().completedDurableIdentities;
    const afterRetryObservation = context.observation.observeLiveMessage({
        identity: 'live-probe-after-retry',
        sequence: 3,
        sentAtEpochMs: context.nowMs,
        receivedAtEpochMs: Date.now(),
        markedForOverlap: true
    });
    return { overlapObservation, completedAfterRetry, afterRetryObservation };
}

async function observeCompletedDispatchEffect(context: MixedLiveDurableSemanticsContext): Promise<void> {
    const completedWrite = computeDispatchEntry(context, `completed-effect-${context.identity}`);
    await context.queue.enqueueIfAbsent(completedWrite.entry);
    const completedPage = await context.queue.readWorkPage({
        typeId: completedWrite.entry.typeId,
        status: EntityStatus.NEW,
        maxToRead: 8,
        cursor: null
    });
    const reserved = await context.queue.reserveEntries({
        typeIds: new Set([completedWrite.entry.typeId]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1,
        observedEntries: completedPage.entries.filter((entry) =>
            entry.key.contextId === completedWrite.entry.key.contextId
        )
    });
    await context.queue.releaseEntries([...reserved.values()], { status: EntityStatus.COMPLETED, delayMs: null });
}

function computeDispatchEntry(context: MixedLiveDurableSemanticsContext, effectId: string) {
    return computeALInboundWorkEntry({
        namespace: context.inboundNamespace,
        effectId,
        payload: {
            kind: 'dispatch-local',
            message: { senderId: 'sender', msgId: context.identity }
        },
        observedAtMs: context.nowMs,
        expireAtTimestamp: context.nowMs + 30_000
    });
}

function rejectDoubleObservationInstallation(context: MixedLiveDurableSemanticsContext): boolean {
    try {
        installMixedLiveDurableObservation({
            databaseName: context.databaseName,
            storeName: context.storeName,
            durableTypeId: 'room.mixed-durable.v1',
            markedDurableIdentities: [context.identity],
            inboundNamespace: context.inboundNamespace
        });
        return false;
    }
    catch {
        return true;
    }
}

function toMixedLiveDurableSemanticsProbe(
    input: Readonly<{
        initial: MixedLiveDurableInitialDispatch;
        claim: MixedLiveDurableClaimProbe;
        completedAfterParent: readonly string[];
        doubleInstallationRejected: boolean;
        snapshot: MixedLiveDurableObservationSnapshot;
    }>
): MixedLiveDurableObservationSemanticsProbe {
    const { initial, claim, completedAfterParent, doubleInstallationRejected, snapshot } = input;
    return {
        noClaimObservation: initial.noClaimObservation,
        overlapObservation: claim.overlapObservation,
        queuePhases: snapshot.queuePhases,
        completedAfterParent,
        completedAfterRetry: claim.completedAfterRetry,
        afterRetryObservation: claim.afterRetryObservation,
        completedDurableIdentities: snapshot.completedDurableIdentities,
        refusedIdentityObserved: snapshot.queuePhases.some((phase) => phase.identity === 'refused-probe') ||
            snapshot.completedDurableIdentities.includes('refused-probe') ||
            snapshot.liveObservations.some((live) => live.overlappingReturnedClaimIdentities.includes('refused-probe')),
        queueHookModuleIdentityObserved: snapshot.queueHookModuleIdentityObserved,
        doubleInstallationRejected,
        methodsRestored: snapshot.methodsRestored
    };
}

function mixedLiveDurableObservationGlobal(): MixedLiveDurableObservationGlobal {
    return globalThis as MixedLiveDurableObservationGlobal;
}

function toReleasePhase(status: string): MixedLiveDurableQueuePhaseKind | undefined {
    if (status === EntityStatus.COMPLETED) {
        return 'release-completed';
    }
    if (status === EntityStatus.RETRY) {
        return 'release-retry';
    }
    return FAILED_RELEASE_STATUSES.has(status) ? 'release-terminal-failure' : undefined;
}

function readObservedLease(
    entry: ResourceEntry,
    returnedAtEpochMs: number = Date.now()
): MixedLiveDurableObservedLease | undefined {
    const startTs = entry.dequeueAudit.startTs;
    if (entry.status !== EntityStatus.RESERVED || startTs === undefined) {
        return undefined;
    }
    const startedAtEpochMs = Number(
        startTs.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }).epochMilliseconds
    );
    const untilEpochMs = startedAtEpochMs + AL_INBOUND_WORK_LEASE_MS;
    return {
        startedAtEpochMs,
        untilEpochMs,
        validWhenReturned: entry.dequeueAudit.attempts > 0 &&
            startedAtEpochMs <= returnedAtEpochMs &&
            untilEpochMs > returnedAtEpochMs &&
            Number(entry.audit.expiryTs.epochMilliseconds) > returnedAtEpochMs
    };
}

async function openExistingDatabase(databaseName: string): Promise<IDBDatabase> {
    const request = indexedDB.open(databaseName);
    return await new Promise<IDBDatabase>((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener(
            'error',
            () => reject(request.error ?? new Error(`Failed to open IndexedDB ${databaseName}`)),
            { once: true }
        );
    });
}

async function readBoundedMarkedRows(input: ReadBoundedMarkedRowsInput): Promise<MixedLiveDurableRows> {
    const transaction = input.database.transaction(input.storeName, 'readonly');
    const request = transaction.objectStore(input.storeName).openCursor();
    const rows: MixedLiveDurableDecodedEntry[] = [];
    let scannedRowCount = 0;
    let censoredByRowCapacity = false;
    await new Promise<void>((resolve, reject) => {
        request.addEventListener('success', () => {
            const cursor = request.result;
            if (cursor === null) {
                resolve();
                return;
            }
            if (scannedRowCount >= input.rowCapacity) {
                censoredByRowCapacity = true;
                resolve();
                return;
            }
            scannedRowCount += 1;
            const entry = decodeStoredResourceEntry(decodeStoredResourceEntryValue(cursor.value));
            if (entry.typeId === toALInboundWorkType(input.inboundNamespace)) {
                const decoded = decodeALInboundWorkEntry(entry, input.inboundNamespace);
                if (
                    decoded.payload.kind === 'dispatch-local' &&
                    input.markedDurableIdentities.has(decoded.payload.message.msgId)
                ) {
                    rows.push({
                        entry,
                        identity: decoded.payload.message.msgId,
                        payloadKind: decoded.payload.kind,
                        typeId: null
                    });
                }
            }
            cursor.continue();
        });
        request.addEventListener(
            'error',
            () => reject(request.error ?? new Error('Mixed live/durable IndexedDB cursor failed')),
            { once: true }
        );
    });
    await readTransaction(transaction);
    return Object.assign(rows, { scannedRowCount, censoredByRowCapacity });
}

async function readTransaction(transaction: IDBTransaction): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve(), { once: true });
        transaction.addEventListener(
            'abort',
            () => reject(transaction.error ?? new Error('Mixed live/durable IndexedDB transaction aborted')),
            { once: true }
        );
        transaction.addEventListener(
            'error',
            () => reject(transaction.error ?? new Error('Mixed live/durable IndexedDB transaction failed')),
            { once: true }
        );
    });
}
