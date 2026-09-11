import { onTestFinished, vi } from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
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

const INBOUND_TEST_EFFECT_PREPARATION: ALInboundEffectPreparationDependencies = {
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

export function createInboundTestStores(input: CreateInboundTestStoresInput): ALInboundRuntimeStores {
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
        admissionStore: createALInboundAdmissionStore({
            nowMs: Date.now,
            namespace: input.namespace,
            backend,
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}

export interface InboundTestRuntime {
    readonly runtime: ALInboundMessageRuntime;
    readonly stores: ALInboundRuntimeStores;
    readonly queueEngine: InboxOutboxEngine;
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    /** One entry per dispatched message, so an absent delivery reads as an empty list. */
    readonly delivered: readonly string[];
}

export interface CreateInboundTestRuntimeInput {
    readonly stores: ALInboundRuntimeStores;
    readonly effectWorkerId: string;
    /** Absent leaves the runtime's own default: every planned local delivery may be dispatched. */
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
    /** Absent leaves the policy's plan as it stands. */
    readonly plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan;
}

/** The runtime never owns its engine here: a test drives every round it runs beyond a commit's own. */
export function createInboundTestRuntime(input: CreateInboundTestRuntimeInput): InboundTestRuntime {
    const queueEngine = new InboxOutboxEngine();
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const delivered: string[] = [];
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
        dispatchInboxEntry: async () => {
            delivered.push('dispatched');
        },
        sendControlMessage: async () => {},
        diagnostics: (event) => diagnostics.push(event),
        effectWorkerId: input.effectWorkerId
    });
    onTestFinished(() => runtime.dispose());
    return { runtime, stores: input.stores, queueEngine, diagnostics, delivered };
}

export interface InboundTestMessageInput {
    readonly msgId: string;
    /** Absent leaves the message unordered, so it carries no ordering track. */
    readonly seq?: number;
    /** Absent leaves the message untracked, so its admission reads no supersedence pair. */
    readonly supersedenceKey?: string;
}

export function createInboundTestMessage(input: InboundTestMessageInput): ALMessage {
    const message = newALUnicastMessage(
        INBOUND_TEST_SENDER_PEER_ID,
        { topicId: INBOUND_TEST_ORDERING_KEY, resourceId: input.msgId, contextId: 'room' },
        INBOUND_TEST_SELF_PEER_ID,
        'chat.private-text.v1',
        { text: input.msgId },
        {
            ttlMs: 60_000,
            qos: input.supersedenceKey === undefined ? undefined : {
                supersedence: { algo: 'latest-wins', opts: { supersedenceKey: input.supersedenceKey } }
            }
        }
    );
    return {
        ...message,
        id: { ...message.id, msgId: input.msgId },
        ordering: input.seq === undefined
            ? undefined
            : { orderingKey: INBOUND_TEST_ORDERING_KEY, seq: input.seq }
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
