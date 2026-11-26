import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
import {
    createStableRtcLayoutWait,
    toStableRtcLayoutWaitTimeoutMs
} from '../../../fixtures/create-stable-rtc-layout-wait.ts';
import {
    computeRtcConnectOwnTimeoutMs,
    createRallarBlackBoxEnsureGroupCommands
} from '../../../fixtures/live-rtc-setup.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectReadiness
} from '../../../rallar-black-box-test-contracts.ts';

import { RESTORED_SESSION_RALLAR } from '../alm-conformance-session-commands.ts';
import { computeCommandsTimeoutMs } from '../cell/compute-commands-timeout-ms.ts';
import { createAlmCohortBarrier } from './create-alm-cohort-barrier.ts';
import { toAlmCohortCommandPrefix } from './to-alm-cohort-command-prefix.ts';

/** The one agent that writes the group and connects before any peer exists, or one of the agents that join it. */
export type AlmCohortRole = 'owner' | 'member';

/** What a cohort's pages hear: the channel fields of their connect's `rallar` block. */
export interface AlmCohortChannel {
    readonly typeId: string;
    readonly topicId: string;
    /** Absent, the connect opens the one typed channel of `typeId`; present, it hears the topic for `messageTypeIds`. */
    readonly messageSelector?: Readonly<{ topicId: string; }>;
    /** The types a `messageSelector` hears over RTC; a connect with no selector names none. */
    readonly messageTypeIds?: readonly string[];
}

export interface AlmCohortSetupInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** The owner and every member. */
    readonly participantCount: number;
    readonly readyTimeoutMs: number;
    readonly almDiagnostics: boolean;
    /** The cohort's name: it names the barriers, and with a role's name that role's commands and connection. */
    readonly scope: string;
    readonly roleNames: Readonly<Record<AlmCohortRole, string>>;
    readonly channel: AlmCohortChannel;
}

/** One role's setup in the three stretches a family may put steps of its own between. */
export interface AlmCohortSetupCommands {
    /** The sign-in and, for the owner, its group and its connect. */
    readonly entry: readonly RallarBlackBoxTestCommand[];
    /** The group-created barrier, a member's connect behind it, the connected barrier and the audience wait. */
    readonly gathering: readonly RallarBlackBoxTestCommand[];
    /** The accepted-layout gate, the stable-layout wait and the setup-complete barrier. */
    readonly settling: readonly RallarBlackBoxTestCommand[];
}

/** A readiness whose layout is replaced is read again this soon, since its quiet window may already have elapsed. */
const LAYOUT_RECHECK_INTERVAL_MS = 500;
/** A promotion still in flight lands within this; a setup with no accepted layout by then fails instead of looping. */
const ACCEPTED_LAYOUT_GATE_MS = 5_000;
const LAYOUT_READINESS_TIMEOUT_MS = 5_000;
/**
 * The API serves a cohort's group joins one at a time, so the owner's group requests, and a read a family queues behind
 * the joins, get an allowance that grows with the cohort; a member's join runs inside its connect.
 */
const GROUP_REQUEST_BASE_TIMEOUT_MS = 5_000;
const GROUP_REQUEST_TIMEOUT_PER_PARTICIPANT_MS = 250;
/**
 * The hosted lane serves about 1.5 joining members per second at 50 members, and a member's readiness waits for peers
 * whose joins queue on that same lane, so it grows with the cohort.
 */
const MEMBER_READINESS_TIMEOUT_PER_PARTICIPANT_MS = 650;

export function createAlmCohortSetupCommands(input: AlmCohortSetupInput, role: AlmCohortRole): AlmCohortSetupCommands {
    const prefix = toCommandPrefix(input, role);
    const barrier = { scope: input.scope, roleName: input.roleNames[role] };
    // Every role's connected barrier waits for the members' connects.
    const memberConnect = createMemberConnectCommand(input);
    return {
        entry: [
            createSignInCommand(input, prefix),
            ...(role === 'owner'
                ? [...createOwnerEnsureGroupCommands(input, prefix), createConnectCommand(input, prefix, undefined)]
                : [])
        ],
        gathering: [
            createAlmCohortBarrier({ ...barrier, phase: 'group-created', timeoutMs: input.readyTimeoutMs }),
            ...(role === 'member' ? [memberConnect] : []),
            createAlmCohortBarrier({
                ...barrier,
                phase: 'connected',
                timeoutMs: computeCommandsTimeoutMs([memberConnect], 'the connected barrier')
            }),
            createAudienceWait(input, prefix)
        ],
        settling: [
            createAcceptedLayoutGate(input, prefix),
            createStableRtcLayoutWait({ group: input.group, prefix, settleTimeoutMs: input.readyTimeoutMs }),
            // The setup-complete barrier shares the stable wait's limit: its window opens at the first arrival, and
            // one agent can wait out a hold another did not see.
            createAlmCohortBarrier({
                ...barrier,
                phase: 'setup-complete',
                timeoutMs: toStableRtcLayoutWaitTimeoutMs(input.readyTimeoutMs)
            })
        ]
    };
}

/** One group request's allowance, which never exceeds the setup's own. */
export function computeAlmCohortGroupRequestTimeoutMs(
    input: Pick<AlmCohortSetupInput, 'participantCount' | 'readyTimeoutMs'>
): number {
    return Math.min(
        GROUP_REQUEST_BASE_TIMEOUT_MS + GROUP_REQUEST_TIMEOUT_PER_PARTICIPANT_MS * input.participantCount,
        input.readyTimeoutMs
    );
}

function toCommandPrefix(input: AlmCohortSetupInput, role: AlmCohortRole): string {
    return toAlmCohortCommandPrefix(input.scope, input.roleNames[role]);
}

/**
 * Only the owner writes the group: a member's room join admits it to the open group. Its capacity is the cohort, the
 * owner and every member, so the join that completes the roster replans at once (D288).
 */
function createOwnerEnsureGroupCommands(
    input: AlmCohortSetupInput,
    prefix: string
): readonly RallarBlackBoxTestCommand[] {
    return createRallarBlackBoxEnsureGroupCommands({
        commandPrefix: prefix,
        requestPrefix: prefix,
        group: input.group,
        actor: '{auth.clientId}',
        maxMembers: input.participantCount,
        timeoutMs: computeAlmCohortGroupRequestTimeoutMs(input)
    });
}

function createSignInCommand(input: AlmCohortSetupInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        commandId: `${prefix}-sign-in`,
        metadata: {
            purpose: 'Sign in under the setup allowance: a cohort registers serially on the API, ' +
                'so the lazy sign-in must not spend the group requests\' allowance. ' +
                'Under strict state reads the read is the session\'s own client snapshot, one point read.'
        },
        request: {
            method: 'GET',
            path: `/api/state/apps/${encodeURIComponent(input.group.applicationId)}` +
                `/workspaces/${encodeURIComponent(input.group.workspaceId)}/clients`
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        timeoutMs: input.readyTimeoutMs
    };
}

/**
 * Only a member connects after a peer exists: the owner's readiness would wait on members the barrier still holds.
 * The runtime connects under the connect's own timeout and only then waits for readiness under the readiness's, so the
 * connected barrier, which waits for every member's connect, covers both, one after the other.
 */
function createMemberConnectCommand(input: AlmCohortSetupInput): RallarBlackBoxTestCommand {
    const readinessTimeoutMs = input.readyTimeoutMs +
        MEMBER_READINESS_TIMEOUT_PER_PARTICIPANT_MS * input.participantCount;
    return createConnectCommand(input, toCommandPrefix(input, 'member'), {
        minReadyPeers: 1,
        timeoutMs: readinessTimeoutMs,
        intervalMs: 100
    });
}

/** Every connect joins the room, each under the SDK timeout, so a slow join reports the SDK's own outcome. */
function createConnectCommand(
    input: AlmCohortSetupInput,
    prefix: string,
    readiness: RallarBlackBoxTestRtcConnectReadiness | undefined
): RallarBlackBoxTestCommand {
    return {
        kind: 'rtc.connect',
        commandId: `${prefix}-connect`,
        connection: prefix,
        actor: '{auth.clientId}',
        roomId: input.group.groupId,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomRef: { ...input.group },
        transport: 'messages.rtc',
        timeoutMs: computeRtcConnectOwnTimeoutMs({ sdkTimeoutMs: input.readyTimeoutMs, joinsRoom: true }),
        ...(readiness === undefined ? {} : { readiness }),
        rallar: {
            ...RESTORED_SESSION_RALLAR,
            almDiagnostics: input.almDiagnostics,
            username: '{auth.username}',
            timeoutMs: input.readyTimeoutMs,
            ...input.channel
        }
    };
}

/**
 * The page's own room snapshot, kept current over its WS state stream, must hold every cohort session; each change
 * to it is forwarded as a formation change carrying its active session count, so the wait reads nothing from the API.
 */
function createAudienceWait(input: AlmCohortSetupInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: `${prefix}-audience-ready`,
        timeoutMs: input.readyTimeoutMs,
        match: {
            kind: 'diagnostic',
            topic: 'rallar.browser.formation.changed',
            payloadFields: {
                'data.roomRef.applicationId': input.group.applicationId,
                'data.roomRef.workspaceId': input.group.workspaceId,
                'data.roomRef.groupId': input.group.groupId,
                'data.activeSessionCount': input.participantCount
            }
        }
    };
}

function createAcceptedLayoutGate(input: AlmCohortSetupInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: `${prefix}-layout-accepted`,
        count: Math.ceil(ACCEPTED_LAYOUT_GATE_MS / LAYOUT_RECHECK_INTERVAL_MS),
        intervalMs: LAYOUT_RECHECK_INTERVAL_MS,
        timeoutMs: ACCEPTED_LAYOUT_GATE_MS + LAYOUT_READINESS_TIMEOUT_MS,
        until: 'first-success',
        commands: [
            {
                kind: 'formation.readiness',
                commandId: `${prefix}-layout-accepted-readiness`,
                roomRef: { ...input.group },
                timeoutMs: LAYOUT_READINESS_TIMEOUT_MS
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-layout-accepted`,
                operator: 'exists',
                source: `resultCache.${prefix}-layout-accepted:i{loop.iteration}:c1:` +
                    `${prefix}-layout-accepted-readiness.value.acceptedHeldSinceEpochMs`
            }
        ]
    };
}
