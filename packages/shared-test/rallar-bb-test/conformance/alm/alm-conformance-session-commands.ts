import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';

import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    RESPONSE_MARGIN_MS,
    STATS_TIMEOUT_MS,
    toBudgetMs
} from './alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toRoomRef,
    toScenarioTypeId
} from './alm-conformance-step-identities.ts';

const ENSURE_TIMEOUT_MS = 5_000;
const CONNECT_READINESS_INTERVAL_MS = 100;
const OWNER_LEASE_LAPSE_TOPIC = 'rallar.black-box.alm.owner-lease-lapsed';

/** A connect that keeps the auth session its document already holds: no credentials, so it never signs in afresh. */
export const RESTORED_SESSION_RALLAR = { username: '', password: '', restoreSession: true } as const;

export function toEnsureGroupCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const group = step.input.group;
    return {
        kind: 'http.request',
        commandId: toCommandId(step, 'ensure-group'),
        timeoutMs: toBudgetMs(ENSURE_TIMEOUT_MS, step.input.deadlineMs),
        metadata: {
            purpose: 'Ensure the backend group exists before the ALM carrier connects.',
            idempotent: true,
            group: toRoomRef(group)
        },
        request: {
            method: 'POST',
            path: `${toStatePrefix(group)}/groups/requests/${toEnsureRequestId(step, 'group')}`,
            body: {
                groupId: group.groupId,
                displayName: group.groupId,
                kind: 'room',
                joinMode: 'open'
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200, 201, 409]
        }
    };
}

export function toEnsureMemberCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const group = step.input.group;
    return {
        kind: 'http.request',
        commandId: toCommandId(step, 'ensure-member'),
        timeoutMs: toBudgetMs(ENSURE_TIMEOUT_MS, step.input.deadlineMs),
        metadata: {
            purpose: 'Ensure the logged-in browser client is an active group member ' +
                'before the ALM carrier connects.',
            idempotent: true,
            group: toRoomRef(group)
        },
        request: {
            method: 'PUT',
            path: `${toStatePrefix(group)}/groups/${group.groupId}/members/{auth.clientId}` +
                `/requests/${toEnsureRequestId(step, 'member')}`,
            body: {
                status: 'active'
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200, 201]
        }
    };
}

export function toConnectCommand(step: AlmConformanceStepInput): RallarBlackBoxTestRtcConnectCommand {
    const input = step.input;
    const typeId = toScenarioTypeId(step);
    return {
        kind: 'rtc.connect',
        commandId: toCommandId(step, 'connect'),
        connection: toConnectionName(step),
        actor: '{auth.clientId}',
        roomId: input.group.groupId,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomRef: toRoomRef(input.group),
        transport: input.carrier === 'ws' ? 'messages.ws' : 'messages.rtc',
        rallar: {
            typeId,
            topicId: ALM_CONFORMANCE_TOPIC_ID,
            ...(step.role === 'successor' ? RESTORED_SESSION_RALLAR : {}),
            ...(installsRecoveryOwner(step) ? { recoveryOwner: 'record' } : {})
        },
        timeoutMs: CONNECT_TIMEOUT_MS,
        ...(input.carrier === 'ws' || !waitsForReadyPeers(step) ? {} : {
            readiness: {
                minReadyPeers: toPeerCount(step.roles) - 1,
                timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
                intervalMs: CONNECT_READINESS_INTERVAL_MS
            }
        })
    };
}

/** Only a recipient's channel receives, so only its connect installs the lane's recording owner. */
function installsRecoveryOwner(step: AlmConformanceStepInput): boolean {
    return step.input.recoveryOwner === 'record' && (step.role === 'receiver' || step.role === 'recipient-b');
}

/**
 * The sender waits for every recipient, so the audience it freezes never misses one. In a three-agent scenario the
 * recipients do not wait: each one arms its own faults right after it connects, and the sender starts only after
 * that connect (D45).
 */
function waitsForReadyPeers(step: AlmConformanceStepInput): boolean {
    return step.role === 'sender' || !step.roles.includes('recipient-b');
}

/** The successor is a second page of the sender's session, so the two are one peer. */
function toPeerCount(roles: readonly AlmConformanceRole[]): number {
    return roles.filter((role) => role !== 'successor').length;
}

/**
 * Holds a successor's connect until the closed owner page's last work lease has lapsed. A held claim stays reserved
 * until its lease ends, so a takeover before then finds the row leased and its first batch claims nothing; after it,
 * that batch claims the row. Nothing emits the topic, so the wait only lets the lease run out.
 */
export function toOwnerLeaseLapseWait(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, 'owner-lease-lapses'),
        match: { kind: 'diagnostic', topic: OWNER_LEASE_LAPSE_TOPIC },
        absent: true,
        timeoutMs: AL_OUTBOUND_WORK_LEASE_MS + RESPONSE_MARGIN_MS
    };
}

export function toStatsCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'stats',
        commandId: toCommandId(step, 'stats'),
        timeoutMs: toBudgetMs(STATS_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/**
 * The browser fills an omitted TTL with 30 seconds. The absence proof, the end of the old document, and one
 * reserved-work lease consume that before the next owner can submit, so an original that must survive its document
 * states a longer lifetime.
 */
const RECOVERY_MARGIN_MS = 60_000;

/**
 * The browser's store ids, `<prefix>:<sessionId>` (`browser-al-runtime-identity.ts`, which this Deno-loaded catalog
 * cannot import). The session inbound store batches every engine round. An outbound store reports when its first work
 * batch runs, which for a store without work can be long after the connect or never before the document ends, so a
 * wait names the store that holds the original.
 */
export const RECOVERED_STORE_PREFIXES = {
    sessionInbound: 'browser-session-inbound',
    ws: 'browser-ws-client',
    rtc: 'browser-rtc-overlay',
    wsCheckpoint: 'browser-ws-client-checkpoint',
    rtcCheckpoint: 'browser-rtc-overlay-checkpoint'
} as const;

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

export interface AlmConformanceRecoveredStore {
    readonly name: string;
    readonly storeIdPrefix: string;
    readonly lane: '' | '/ws';
    /** The connect whose result names the session the store id embeds. */
    readonly connectName: string;
    readonly timeoutMs: number;
}

/** The absence window plus the time the next owner of the original needs before it can submit. */
export function toRecoveryTtlMs(deadlineMs: number): number {
    return deadlineMs - RESPONSE_MARGIN_MS + RECOVERY_MARGIN_MS;
}

/** The fallback carrier's hold hands the original to WS before its page ends, so only `rtc` leaves it in the overlay. */
export function toOriginalStorePrefix(carrier: AlmConformanceCarrier): string {
    return carrier === 'rtc' ? RECOVERED_STORE_PREFIXES.rtc : RECOVERED_STORE_PREFIXES.ws;
}

/** The checkpoint store of the lane that holds a held original at the end of its page, as {@link toOriginalStorePrefix}. */
export function toCheckpointStorePrefix(carrier: AlmConformanceCarrier): string {
    return carrier === 'rtc' ? RECOVERED_STORE_PREFIXES.rtcCheckpoint : RECOVERED_STORE_PREFIXES.wsCheckpoint;
}

/**
 * The one `recovery` a durable store, or one lane of a shared store, reports after its first work batch, matched in
 * its emitted key order (`kind`, `storeId`, `outcome`). The store id embeds the session the named connect restored,
 * read from that connect's result, and a shared store's lane follows it.
 */
export function toStoreRecoveryWait(
    step: AlmConformanceStepInput,
    store: AlmConformanceRecoveredStore
): RallarBlackBoxTestCommand {
    const sessionId = `{resultCache.${toCommandId(step, store.connectName)}.value.sessionId}`;
    return {
        kind: 'wait',
        commandId: toCommandId(step, store.name),
        match: {
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains:
                `"kind":"recovery","storeId":"${store.storeIdPrefix}:${sessionId}${store.lane}","outcome":{"kind":"restored"`
        },
        timeoutMs: store.timeoutMs
    };
}

function toEnsureRequestId(
    step: AlmConformanceStepInput,
    operation: 'group' | 'member'
): string {
    return `alm-conformance-{runtimeIdentity}-${step.input.carrier}-${step.scenarioKey}` +
        `-${step.role}-${operation}`;
}

function toStatePrefix(group: RallarBlackBoxDistributedGroupRef): string {
    return `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}`;
}
