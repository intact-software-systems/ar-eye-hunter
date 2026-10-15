import { createRallarBlackBoxEnsureGroupCommands } from '../../../fixtures/live-rtc-setup.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectReadiness
} from '../../../rallar-black-box-test-contracts.ts';

import { RESTORED_SESSION_RALLAR } from '../alm-conformance-session-commands.ts';
import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

/** Longer than the observed 2.7 s between a layout's acceptance and its follow-up re-plan. */
const LAYOUT_QUIET_WINDOW_MS = 3_500;
/**
 * The API serves a cohort's group joins one at a time, so the director's group requests get an allowance that grows
 * with the cohort; a player's join runs inside its connect, under the whole setup allowance.
 */
const GROUP_REQUEST_BASE_TIMEOUT_MS = 5_000;
const GROUP_REQUEST_TIMEOUT_PER_PARTICIPANT_MS = 250;
/** The hosted lane serves about 1.5 joining players per second at 50 members, so the cohort's connects wait in line. */
const PLAYER_CONNECT_TIMEOUT_PER_PARTICIPANT_MS = 650;
/** The connect's own deadline outlasts its readiness wait, so the wait reports its own outcome. */
const CONNECT_COMPLETION_MARGIN_MS = 5_000;

interface ConnectDeadline {
    readonly timeoutMs: number;
    readonly readiness: RallarBlackBoxTestRtcConnectReadiness | undefined;
}

export function createAlmScaleSetupCommands(
    input: AlmScaleRecipeInput,
    role: 'director' | 'player'
): readonly RallarBlackBoxTestCommand[] {
    const prefix = `alm-scale-${role}`;
    const created = createSetupBarrier(input, prefix, 'group-created');
    return [
        createSignInCommand(input, prefix),
        ...(role === 'director'
            ? [
                ...createDirectorEnsureGroupCommands(input, prefix),
                createConnectCommand(input, prefix, {
                    timeoutMs: input.readyTimeoutMs + CONNECT_COMPLETION_MARGIN_MS,
                    readiness: undefined
                }),
                createAppointCommand(input, prefix),
                created
            ]
            : [created, createPlayerConnectCommand(input, prefix)]),
        { ...createSetupBarrier(input, prefix, 'connected'), timeoutMs: computePlayerConnectTimeoutMs(input) },
        createAudienceWait(input, prefix),
        createSetupBarrier(input, prefix, 'appointed'),
        createDirectorWait(input, prefix),
        {
            kind: 'director.status',
            commandId: `${prefix}-ready-status`,
            roomRef: { ...input.group },
            refresh: true,
            timeoutMs: 5_000
        },
        createStableLayoutWait(input, prefix),
        createSetupBarrier(input, prefix, 'setup-complete'),
        { kind: 'storage.counters', commandId: `${prefix}-storage-reset`, reset: true },
        createSetupBarrier(input, prefix, 'traffic-ready')
    ];
}

/** Only the director writes the group: a player's room join admits it to the open group. */
function createDirectorEnsureGroupCommands(
    input: AlmScaleRecipeInput,
    prefix: string
): readonly RallarBlackBoxTestCommand[] {
    return createRallarBlackBoxEnsureGroupCommands({
        commandPrefix: prefix,
        requestPrefix: prefix,
        group: input.group,
        actor: '{auth.clientId}',
        timeoutMs: computeGroupRequestTimeoutMs(input)
    });
}

function computeGroupRequestTimeoutMs(input: AlmScaleRecipeInput): number {
    return Math.min(
        GROUP_REQUEST_BASE_TIMEOUT_MS + GROUP_REQUEST_TIMEOUT_PER_PARTICIPANT_MS * input.participantCount,
        input.readyTimeoutMs
    );
}

function createSignInCommand(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        commandId: `${prefix}-sign-in`,
        metadata: {
            purpose: 'Sign in under the setup allowance: a cohort registers serially on the API, ' +
                'so the lazy sign-in must not spend the group requests\' allowance.'
        },
        request: {
            method: 'GET',
            path: `/api/state/apps/${encodeURIComponent(input.group.applicationId)}` +
                `/workspaces/${encodeURIComponent(input.group.workspaceId)}/stats/me/realtime`
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        timeoutMs: input.readyTimeoutMs
    };
}

function createSetupBarrier(input: AlmScaleRecipeInput, prefix: string, phase: string): RallarBlackBoxTestCommand {
    return {
        kind: 'barrier',
        commandId: `${prefix}-${phase}`,
        barrierId: `alm-scale-${phase}`,
        timeoutMs: input.readyTimeoutMs
    };
}

/** The appointment needs only the director's own session, so the first layout with peers is already rooted at it. */
function createAppointCommand(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'director.appoint',
        commandId: `${prefix}-appoint`,
        roomRef: { ...input.group },
        timeoutMs: 5_000
    };
}

/** Only a player connects after a peer exists: the director's readiness would wait on players the barrier still holds. */
function createPlayerConnectCommand(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    const timeoutMs = computePlayerConnectTimeoutMs(input);
    return createConnectCommand(input, prefix, {
        timeoutMs,
        readiness: { minReadyPeers: 1, timeoutMs: timeoutMs - CONNECT_COMPLETION_MARGIN_MS, intervalMs: 100 }
    });
}

/** The connected barrier waits for every player's connect, so it shares the players' connect allowance. */
function computePlayerConnectTimeoutMs(input: AlmScaleRecipeInput): number {
    return input.readyTimeoutMs + PLAYER_CONNECT_TIMEOUT_PER_PARTICIPANT_MS * input.participantCount;
}

function createConnectCommand(
    input: AlmScaleRecipeInput,
    prefix: string,
    deadline: ConnectDeadline
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
        timeoutMs: deadline.timeoutMs,
        ...(deadline.readiness === undefined ? {} : { readiness: deadline.readiness }),
        rallar: {
            ...RESTORED_SESSION_RALLAR,
            almDiagnostics: input.almDiagnostics,
            username: '{auth.username}',
            timeoutMs: input.readyTimeoutMs,
            typeId: 'room.ar-eye-hunter.director.intent.v1',
            topicId: 'room.ar-eye-hunter.director',
            messageSelector: { topicId: 'room.ar-eye-hunter.director' },
            messageTypeIds: ['room.ar-eye-hunter.director.intent.v1', 'room.ar-eye-hunter.director.event.v1']
        }
    };
}

function createAudienceWait(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    const path = `/api/state/apps/${encodeURIComponent(input.group.applicationId)}` +
        `/workspaces/${encodeURIComponent(input.group.workspaceId)}/groups/${encodeURIComponent(input.group.groupId)}`;
    return {
        kind: 'loop',
        commandId: `${prefix}-audience-ready`,
        count: Math.ceil(input.readyTimeoutMs / 200),
        intervalMs: 200,
        timeoutMs: input.readyTimeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'http.request',
                commandId: `${prefix}-audience`,
                request: { method: 'GET', path },
                response: { body: 'json', acceptedStatusCodes: [200] },
                timeoutMs: 5_000
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-audience`,
                operator: 'equals',
                expected: input.participantCount,
                source:
                    `resultCache.${prefix}-audience-ready:i{loop.iteration}:c1:${prefix}-audience.value.body.activeSessions.length`
            }
        ]
    };
}

function createDirectorWait(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: `${prefix}-director-ready`,
        count: Math.ceil(input.readyTimeoutMs / 200),
        intervalMs: 200,
        timeoutMs: input.readyTimeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'director.status',
                commandId: `${prefix}-director-status`,
                roomRef: { ...input.group },
                refresh: true,
                timeoutMs: 5_000
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-director-active`,
                operator: 'equals',
                expected: true,
                source:
                    `resultCache.${prefix}-director-ready:i{loop.iteration}:c1:${prefix}-director-status.value.directorStatus.active`
            }
        ]
    };
}

/** Readiness repeats until no plan from its own group revision, which would replace the ready layout, appears. */
function createStableLayoutWait(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: `${prefix}-layout-stable`,
        count: Math.floor(input.readyTimeoutMs / LAYOUT_QUIET_WINDOW_MS),
        timeoutMs: input.readyTimeoutMs + LAYOUT_QUIET_WINDOW_MS,
        until: 'first-success',
        commands: [
            {
                kind: 'formation.readiness',
                commandId: `${prefix}-layout-readiness`,
                roomRef: { ...input.group },
                timeoutMs: 5_000
            },
            {
                kind: 'wait',
                commandId: `${prefix}-layout-replan`,
                absent: true,
                timeoutMs: LAYOUT_QUIET_WINDOW_MS,
                match: {
                    topic: 'rallar.browser.formation.layout',
                    payloadFields: { 'data.kind': 'layoutPlanned', 'data.role': 'planned' },
                    payloadPath: 'data.identity',
                    contains: `"groupRevision":{resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                        `${prefix}-layout-readiness.value.formation.causalRevision.groupRevision},`
                }
            }
        ]
    };
}
