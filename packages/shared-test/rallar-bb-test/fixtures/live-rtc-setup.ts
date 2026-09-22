import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
export const RALLAR_BLACK_BOX_LIVE_API_BASE_URL = 'https://api.rallar.intactss.com';

export const RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS = 5_000;

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

export function computeRtcConnectCommandTimeoutMs(
    options: Readonly<{
        readyPeerCount?: number;
        readyTimeoutMs?: number;
    }>,
    fallbackTimeoutMs: number
): number {
    const readiness = rtcConnectReadiness(options);
    return readiness === undefined
        ? fallbackTimeoutMs
        : readiness.timeoutMs + RALLAR_BLACK_BOX_RTC_CONNECT_COMPLETION_MARGIN_MS;
}

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
        timeoutMs: 5_000,
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
                joinMode: 'open'
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
        timeoutMs: 5_000,
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
