import { API_MUTATION_COMPLETION_WAIT_MAX_ELAPSED_MS } from '@shared/api/mutation/api-mutation-completion-wait-max-elapsed-ms.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
export const RALLAR_BLACK_BOX_LIVE_API_BASE_URL = 'https://api.rallar.intactss.com';

export const RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS = 5_000;

export const RALLAR_BLACK_BOX_RTC_READINESS_TIMEOUT_MS = 45_000;

/**
 * The SDK connect runs the WebSocket ticket request and then the connect mutation, and each answers once its mutation
 * completes or the server's completion wait ends, so the recipe names two such waits plus the completion margin.
 */
export const RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS = 2 * API_MUTATION_COMPLETION_WAIT_MAX_ELAPSED_MS +
    RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS;

/**
 * Each ensure-group and ensure-member request answers once its mutation completes or the server's completion wait
 * ends, so its budget is that wait plus the same completion margin the RTC connect gets.
 */
export const RALLAR_BLACK_BOX_ENSURE_GROUP_TIMEOUT_MS = API_MUTATION_COMPLETION_WAIT_MAX_ELAPSED_MS +
    RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS;

export interface RallarBlackBoxLiveRecipeOptions {
    readonly group?: RallarBlackBoxDistributedGroupRef;
    readonly apiBaseUrl?: string;
    readonly actor?: string;
    readonly connection?: string;
    readonly readyPeerCount?: number;
    readonly readyTimeoutMs?: number;
}

function stateApiPathSegment(value: string): string {
    return encodeURIComponent(value);
}

function stateApiActorPathSegment(value: string): string {
    return value.includes('{') ? value : stateApiPathSegment(value);
}

export function defaultRallarBlackBoxGroup(): RallarBlackBoxDistributedGroupRef {
    return {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'rallar-black-box-room'
    };
}

export function groupRoomRef(group: RallarBlackBoxDistributedGroupRef): RallarBlackBoxDistributedGroupRef {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
}

export function rtcConnectReadiness(
    options: Readonly<{
        readyPeerCount?: number;
        readyTimeoutMs?: number;
    }>
): { minReadyPeers: number; timeoutMs: number; intervalMs: number; } | undefined {
    if (
        typeof options.readyPeerCount !== 'number' ||
        !Number.isFinite(options.readyPeerCount) ||
        options.readyPeerCount <= 0
    ) {
        return undefined;
    }

    return {
        minReadyPeers: Math.max(1, Math.round(options.readyPeerCount)),
        timeoutMs: typeof options.readyTimeoutMs === 'number' &&
                Number.isFinite(options.readyTimeoutMs)
            ? Math.max(1, Math.round(options.readyTimeoutMs))
            : 5_000,
        intervalMs: 100
    };
}

export interface RtcConnectOwnTimeoutInput {
    /** The connect's `rallar.timeoutMs`, which bounds the SDK connect and, apart, the room join. */
    readonly sdkTimeoutMs: number;
    /** Whether the connect names a room, which the runtime joins once the SDK connect completed. */
    readonly joinsRoom: boolean;
}

/**
 * A connect's own timeout: the runtime runs the SDK connect and then, when the connect names a room, the room join,
 * each under the SDK timeout, and only after both its readiness wait, under the readiness's own timeout.
 */
export function computeRtcConnectOwnTimeoutMs(input: RtcConnectOwnTimeoutInput): number {
    const sdkOperationCount = input.joinsRoom ? 2 : 1;
    return sdkOperationCount * input.sdkTimeoutMs + RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS;
}

/** A connect that joins a room under the establishment SDK timeout, which it names as its `rallar.timeoutMs`. */
export const RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS = computeRtcConnectOwnTimeoutMs({
    sdkTimeoutMs: RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS,
    joinsRoom: true
});

export function createRallarBlackBoxEnsureGroupRequestId(
    input: Readonly<{
        requestPrefix: string;
        group: RallarBlackBoxDistributedGroupRef;
    }>
): string {
    return ensureGroupRequestId(input.requestPrefix, 'group');
}

function ensureGroupRequestId(
    requestPrefix: string,
    operation: 'group' | 'member'
): string {
    return `${requestPrefix}-ensure-${operation}-{runtimeIdentity}`;
}

export function createRallarBlackBoxEnsureGroupCommands(
    input: EnsureGroupInput
): readonly RallarBlackBoxTestCommand[] {
    const actor = input.actor ?? '{auth.clientId}';
    const encodedApplicationId = stateApiPathSegment(input.group.applicationId);
    const encodedWorkspaceId = stateApiPathSegment(input.group.workspaceId);
    const encodedGroupId = stateApiPathSegment(input.group.groupId);
    const actorPathSegment = stateApiActorPathSegment(actor);
    const groupStatePath = `/api/state/apps/${encodedApplicationId}/workspaces/${encodedWorkspaceId}/groups`;
    const groupMemberPath = `${groupStatePath}/${encodedGroupId}/members/${actorPathSegment}`;
    const groupRequestKey = input.groupRequestId ?? createRallarBlackBoxEnsureGroupRequestId(input);
    const memberRequestKey = input.memberRequestId ?? ensureGroupRequestId(input.requestPrefix, 'member');

    return [
        toEnsureGroupCommand({ input, groupStatePath, groupRequestKey }),
        toEnsureMemberCommand({ input, groupMemberPath, memberRequestKey })
    ];
}

interface EnsureGroupInput {
    readonly commandPrefix: string;
    readonly requestPrefix: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly actor?: string;
    readonly groupRequestId?: string;
    readonly memberRequestId?: string;
    /** The cohort the group is created for; absent creates it under the server's default capacity. */
    readonly maxMembers?: number;
    readonly timeoutMs: number;
}

interface EnsureGroupCommandInput {
    readonly input: EnsureGroupInput;
    readonly groupStatePath: string;
    readonly groupRequestKey: string;
}

function toEnsureGroupCommand(context: EnsureGroupCommandInput): RallarBlackBoxTestCommand {
    const { input, groupStatePath, groupRequestKey } = context;
    return {
        kind: 'http.request',
        commandId: `${input.commandPrefix}-ensure-group`,
        timeoutMs: input.timeoutMs,
        metadata: {
            purpose: 'Ensure the backend group exists before RTC room join.',
            idempotent: true,
            group: input.group
        },
        request: {
            method: 'POST',
            path: `${groupStatePath}/requests/${groupRequestKey}`,
            body: {
                groupId: input.group.groupId,
                displayName: input.group.groupId,
                kind: 'room',
                joinMode: 'open',
                ...(input.maxMembers === undefined ? {} : { maxMembers: input.maxMembers })
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200, 201, 409]
        }
    };
}

interface EnsureMemberCommandInput {
    readonly input: EnsureGroupInput;
    readonly groupMemberPath: string;
    readonly memberRequestKey: string;
}

function toEnsureMemberCommand(context: EnsureMemberCommandInput): RallarBlackBoxTestCommand {
    const { input, groupMemberPath, memberRequestKey } = context;
    return {
        kind: 'http.request',
        commandId: `${input.commandPrefix}-ensure-member`,
        timeoutMs: input.timeoutMs,
        metadata: {
            purpose: 'Ensure the logged-in browser client is an active group member ' +
                'before RTC room join.',
            idempotent: true,
            group: input.group
        },
        request: {
            method: 'PUT',
            path: `${groupMemberPath}/requests/${memberRequestKey}`,
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
