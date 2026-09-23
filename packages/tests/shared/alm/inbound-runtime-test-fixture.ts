import { onTestFinished, vi } from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    type ALMessageHandlingPlan,
    type ALQosPolicyRequest
} from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionRead,
    type ALInboundAdmissionStore,
    type ALInboundCommitBundle,
    type ALInboundPlanner
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import { ALInboundMessageRuntime, type ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import {
    readALInboundEffectFacts,
    type ALInboundEffectPreparationDependencies
} from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import type { IndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const INBOUND_TEST_SELF_PEER_ID = 'receiver';
export const INBOUND_TEST_SENDER_PEER_ID = 'sender';
const INBOUND_TEST_ORDERING_KEY = 'chat';
export const INBOUND_TEST_SOURCE: ALInboundMessageRuntime.Source = {
    kind: 'ws-client',
    peerId: INBOUND_TEST_SENDER_PEER_ID
};

/** The policy's own plan for the fixture's two peers: what every inbound owner here admits with. */
export const planInboundTestMessage: ALInboundPlanner = (msg, _source, observations) =>
    planALMessageHandling(msg, {
        ...observations,
        selfPeerId: INBOUND_TEST_SELF_PEER_ID,
        fromPeerId: INBOUND_TEST_SENDER_PEER_ID
    });

export const INBOUND_TEST_EFFECT_PREPARATION: ALInboundEffectPreparationDependencies = {
    newControlId: crypto.randomUUID.bind(crypto),
    selfPeerId: INBOUND_TEST_SELF_PEER_ID,
    createInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
};

export type InboundTestStorage = 'memory' | 'indexeddb';

export interface CreateInboundTestStoresInput {
    readonly namespace: string;
    readonly storage: InboundTestStorage;
    /** The IndexedDB backend's observer; a memory store has no operations to observe. */
    readonly observer: IndexedDbOperationObserver;
}

export interface InboundTestBackendStores {
    readonly backend: ALAdmissionWorkBackend;
    readonly stores: ALInboundRuntimeStores;
}

export function createInboundTestBackendStores(input: CreateInboundTestStoresInput): InboundTestBackendStores {
    const backend = input.storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `${input.namespace}-${crypto.randomUUID()}`,
            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: input.observer
        });
    return {
        backend,
        stores: {
            admissionStore: createALInboundAdmissionStore({
                nowMs: Date.now,
                namespace: input.namespace,
                backend,
                orderingTrackTtlMs: 60_000,
                supersedenceTrackTtlMs: 60_000,
                retention: normalizeALRuntimeStoreRetention()
            }),
            workQueue: backend.workQueue
        }
    };
}

export function createInboundTestStores(input: CreateInboundTestStoresInput): ALInboundRuntimeStores {
    return createInboundTestBackendStores(input).stores;
}

export type InboundTestEffectCall = 'dispatched' | 'control-sent';

export interface InboundTestRuntime {
    readonly runtime: ALInboundMessageRuntime;
    readonly stores: ALInboundRuntimeStores;
    readonly queueEngine: InboxOutboxEngine;
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    /** One entry per dispatched message, so an absent delivery reads as an empty list. */
    readonly delivered: readonly string[];
    /** One entry per port call in run order, so a batch's dispatch-before-control order is visible. */
    readonly sequence: readonly InboundTestEffectCall[];
}

export interface CreateInboundTestRuntimeInput {
    readonly stores: ALInboundRuntimeStores;
    readonly effectWorkerId: string;
    /** Absent leaves the runtime's own default: every planned local delivery may be dispatched. */
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
    /** Absent leaves the policy's plan as it stands. */
    readonly plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan;
    /** Absent lets every dispatch complete; `retry` reschedules the claim that ran it. */
    readonly dispatchOutcome?: 'completed' | 'retry';
    /** Absent leaves a retained admission's replay authorized by the source it captured. */
    readonly readPendingAdmissionAuthority?: ALInboundMessageRuntime.Dependencies['readPendingAdmissionAuthority'];
    /** Absent settles every dispatch immediately; a message this awaits holds that claim's batch open until it resolves. */
    readonly gateDispatch?: (msg: ALMessage) => Promise<void>;
}

/** The runtime never owns its engine here: a test drives every round it runs beyond a commit's own. */
export function createInboundTestRuntime(input: CreateInboundTestRuntimeInput): InboundTestRuntime {
    const queueEngine = new InboxOutboxEngine();
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const delivered: string[] = [];
    const sequence: InboundTestEffectCall[] = [];
    const runtime = new ALInboundMessageRuntime({
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: INBOUND_TEST_SELF_PEER_ID,
            stores: input.stores,
            queueEngine,
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
        }),
        planIncomingMessage: (msg, source, observations) => {
            const plan = planInboundTestMessage(msg, source, observations);
            return input.plan?.(plan) ?? plan;
        },
        canDispatchMessage: input.canDispatchMessage,
        readPendingAdmissionAuthority: input.readPendingAdmissionAuthority,
        dispatchInboxEntry: async (entry) => {
            await input.gateDispatch?.(decodePersistedALMessage(entry.resource));
            delivered.push('dispatched');
            sequence.push('dispatched');
            return input.dispatchOutcome;
        },
        sendControlMessage: async () => {
            sequence.push('control-sent');
        },
        diagnostics: (event) => diagnostics.push(event),
        effectWorkerId: input.effectWorkerId
    });
    onTestFinished(() => runtime.dispose());
    return { runtime, stores: input.stores, queueEngine, diagnostics, delivered, sequence };
}

export interface InboundTestMessageInput {
    readonly msgId: string;
    /** Absent leaves the message unordered, so it carries no ordering track. */
    readonly seq?: number;
    /** Absent leaves the message untracked, so its admission reads no supersedence pair. */
    readonly supersedenceKey?: string;
    /** Absent leaves the message unacknowledged, so its admission writes no `send-control` row. */
    readonly acknowledged?: boolean;
}

export function createInboundTestMessage(input: InboundTestMessageInput): ALMessage {
    const message = newALUnicastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: INBOUND_TEST_ORDERING_KEY, resourceId: input.msgId, contextId: 'room' },
        INBOUND_TEST_SELF_PEER_ID,
        'chat.private-text.v1',
        { text: input.msgId },
        { ttlMs: 60_000, qos: toInboundTestQos(input) }
    );
    return {
        ...message,
        id: { ...message.id, msgId: input.msgId },
        ordering: input.seq === undefined
            ? undefined
            : { orderingKey: INBOUND_TEST_ORDERING_KEY, seq: input.seq }
    };
}

function toInboundTestQos(input: InboundTestMessageInput): ALQosPolicyRequest | undefined {
    if (input.supersedenceKey === undefined && input.acknowledged !== true) {
        return undefined;
    }
    return {
        ...(input.supersedenceKey === undefined ? {} : {
            supersedence: { algo: 'latest-wins', opts: { supersedenceKey: input.supersedenceKey } }
        }),
        ...(input.acknowledged === true ? { ack: { algo: 'hop' } } : {})
    };
}

export async function readInboundTestDecisionSurface(
    admissionStore: ALInboundAdmissionStore,
    msg: ALMessage,
    nowMs = Date.now()
): Promise<ALInboundAdmissionRead> {
    return await admissionStore.readIncomingMessage({
        msg,
        source: INBOUND_TEST_SOURCE,
        nowMs,
        prePlan: planInboundTestMessage(msg, INBOUND_TEST_SOURCE, { nowMs })
    });
}

/**
 * The real admission path's own bundle, so every row it leaves behind is a real one: one clock
 * reading threaded through the read, the plan it feeds, and the effect facts, exactly as
 * `ALInboundMessageAdmission.attempt` threads its own.
 */
export async function readInboundTestAdmission(
    admissionStore: ALInboundAdmissionStore,
    msg: ALMessage
): Promise<ALInboundCommitBundle> {
    const nowMs = Date.now();
    const read = await readInboundTestDecisionSurface(admissionStore, msg, nowMs);
    const plan = planInboundTestMessage(msg, INBOUND_TEST_SOURCE, computeALInboundPlanningObservations(read));
    const facts = readALInboundEffectFacts(nowMs, INBOUND_TEST_EFFECT_PREPARATION);
    return computeALInboundAdmission({ read, plan, facts, canForward: false });
}

/** The admission the runtime composes, over the caller's own stores, so a pin can drive it directly. */
export function createInboundTestAdmission(stores: ALInboundRuntimeStores): ALInboundMessageAdmission {
    const admission = new ALInboundMessageAdmission({
        admissionStore: stores.admissionStore,
        clock: { nowMs: Date.now },
        effectPreparation: INBOUND_TEST_EFFECT_PREPARATION,
        planIncomingMessage: planInboundTestMessage,
        workPort: createTestALInboundWorkPort({ ...stores, nowMs: Date.now })
    });
    onTestFinished(() => admission.dispose());
    return admission;
}

/**
 * Lands the message's own provenance row between the next admission's read and its conditional
 * write, so the conflict that follows is the store's own fence rejecting a stale decision. Only the
 * interleaving belongs to the caller: both commits are the store's own, and the suite's
 * `vi.restoreAllMocks()` removes the seam.
 */
export function setNextInboundCommitConflicted(admissionStore: ALInboundAdmissionStore): void {
    const commitBundle = admissionStore.commitBundle.bind(admissionStore);
    vi.spyOn(admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        const competing = await commitBundle({
            ...bundle,
            mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'),
            durableEffects: []
        });
        if (competing !== 'committed') {
            throw new Error(`The competing writer left the surface unmoved: ${competing}`);
        }
        return await commitBundle(bundle);
    });
}

/**
 * Lands a complete second write between the next write phase's fence snapshot and its
 * conditional write: the callback has computed its mutations and nothing has committed yet,
 * which is the exact window a store-global revision turns into a false conflict.
 */
export function setNextAdmissionWritePhaseInterleaved(
    backend: ALAdmissionWorkBackend,
    interleave: () => Promise<void>
): void {
    const write = backend.write.bind(backend);
    vi.spyOn(backend, 'write').mockImplementationOnce(
        async (operation, executionExpiresAtMs) =>
            await write(async (transaction) => {
                const result = await operation(transaction);
                await interleave();
                return result;
            }, executionExpiresAtMs)
    );
}
