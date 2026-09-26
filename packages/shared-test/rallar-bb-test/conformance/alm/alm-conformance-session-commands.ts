import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    STATS_TIMEOUT_MS,
    toBudgetMs
} from './alm-conformance-budgets.ts';
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
        rallar: { typeId, topicId: ALM_CONFORMANCE_TOPIC_ID },
        timeoutMs: CONNECT_TIMEOUT_MS,
        ...(input.carrier === 'ws' ? {} : {
            readiness: {
                minReadyPeers: 1,
                timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
                intervalMs: CONNECT_READINESS_INTERVAL_MS
            }
        })
    };
}

export function toStatsCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'stats',
        commandId: toCommandId(step, 'stats'),
        timeoutMs: toBudgetMs(STATS_TIMEOUT_MS, step.input.deadlineMs)
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
