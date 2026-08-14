import type {
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupRef,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';

const CONTROL_TOPIC = 'black-box.group-assertions.control';
const LEAK_PROBE_TOPIC = 'black-box.group-assertions.leak-probe';

export const HETZNER_GROUP_ASSERTIONS_RECIPE_ID = 'group-assertions-recipe';

// One room only, per the Hetzner isolation contract: each agent proves
// delivery with a same-room control frame, holds an absence window against
// the leak-probe marker, then polls the shared group snapshot until both
// members converged and records one final read as coordinator evidence.
export function createHetznerGroupAssertionsRecipe(
    group: RallarBlackBoxDistributedGroupRef,
): RallarBlackBoxTestRecipe {
    const roomRef = {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
    };
    const scopedGroup = `${group.applicationId}:${group.workspaceId}:${group.groupId}`;
    const statePrefix = `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}`;
    const groupSnapshotPath = `${statePrefix}/groups/${group.groupId}`;

    return {
        recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
        name: 'Group assertions recipe',
        continueOnFailure: false,
        metadata: {
            profile: 'group-assertions',
            group: roomRef,
        },
        commands: [
            {
                kind: 'http.request',
                commandId: 'group-assertions-ensure-group',
                timeoutMs: 5_000,
                metadata: {
                    purpose: 'Ensure the backend group exists before RTC room join.',
                    idempotent: true,
                    group: roomRef,
                },
                request: {
                    method: 'POST',
                    path: `${statePrefix}/groups`,
                    body: {
                        requestId: `group-assertions:ensure-group:${scopedGroup}:{auth.sessionId}`,
                        groupId: group.groupId,
                        displayName: group.groupId,
                        kind: 'room',
                        joinMode: 'open',
                    },
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200, 201, 409],
                },
            },
            {
                kind: 'http.request',
                commandId: 'group-assertions-ensure-member',
                timeoutMs: 5_000,
                metadata: {
                    purpose: 'Ensure the logged-in browser client is an active group member ' +
                        'before RTC room join.',
                    idempotent: true,
                    group: roomRef,
                },
                request: {
                    method: 'PUT',
                    path: `${statePrefix}/groups/${group.groupId}/members/{auth.clientId}`,
                    body: {
                        requestId: `group-assertions:ensure-member:${scopedGroup}` +
                            ':{auth.clientId}:{auth.sessionId}',
                        status: 'active',
                    },
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200, 201],
                },
            },
            {
                kind: 'rtc.connect',
                commandId: 'group-assertions-connect',
                connection: 'groupAssertionsRtc',
                actor: '{auth.clientId}',
                roomId: group.groupId,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                timeoutMs: 15_000,
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10_000,
                    intervalMs: 100,
                },
            },
            {
                kind: 'rtc.send',
                commandId: 'group-assertions-send-control',
                connection: 'groupAssertionsRtc',
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomRef,
                transport: 'realtime',
                send: {
                    roomId: group.groupId,
                    roomRef,
                    data: {
                        topic: CONTROL_TOPIC,
                        marker: 'same-room-positive-control',
                        actor: '{auth.clientId}',
                    },
                },
                timeoutMs: 3_000,
            },
            {
                kind: 'wait',
                commandId: 'group-assertions-positive-control',
                timeoutMs: 10_000,
                metadata: {
                    purpose: 'Same-room positive control: the control frame must arrive ' +
                        'before any absence claim.',
                },
                match: {
                    kind: 'message',
                    connection: 'groupAssertionsRtc',
                    topic: 'rallar.browser.realtime.message',
                    payloadPath: 'data.topic',
                    equals: CONTROL_TOPIC,
                },
            },
            {
                kind: 'wait',
                commandId: 'group-assertions-no-leak-probe',
                absent: true,
                timeoutMs: 4_000,
                metadata: {
                    purpose: 'Per-agent absence window; the coordinator noneMatch assertion ' +
                        'then proves no agent anywhere recorded a leak-probe match.',
                },
                match: {
                    kind: 'message',
                    connection: 'groupAssertionsRtc',
                    topic: 'rallar.browser.realtime.message',
                    payloadPath: 'data.topic',
                    equals: LEAK_PROBE_TOPIC,
                },
            },
            {
                kind: 'loop',
                commandId: 'group-assertions-membership-poll',
                until: 'first-success',
                count: 20,
                intervalMs: 500,
                commands: [
                    {
                        kind: 'http.request',
                        commandId: 'group-assertions-membership-read',
                        timeoutMs: 5_000,
                        request: {
                            method: 'GET',
                            path: groupSnapshotPath,
                        },
                        response: {
                            body: 'json',
                            acceptedStatusCodes: [200],
                        },
                    },
                    {
                        kind: 'assert',
                        commandId: 'group-assertions-membership-converged',
                        source: 'lastResult.value.body.memberCount',
                        operator: 'gte',
                        expected: 2,
                    },
                ],
            },
            {
                kind: 'http.request',
                commandId: 'group-assertions-members-read',
                timeoutMs: 5_000,
                metadata: {
                    purpose: 'Final converged snapshot read; the coordinator allEqual and ' +
                        'allMatch assertions compare this value across every agent.',
                },
                request: {
                    method: 'GET',
                    path: groupSnapshotPath,
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200],
                },
            },
            {
                kind: 'stats',
                commandId: 'group-assertions-stats',
            },
        ],
    };
}

// The authoring rule composes allEqual with allMatch: allEqual alone passes
// when every agent agrees on the same wrong value, so the known expectation
// rides beside it, and noneMatch states the isolation claim fleet-wide.
export function createHetznerGroupAssertions(
    expectedParticipantCount: number,
): readonly RallarBlackBoxDistributedGroupAssertion[] {
    return [
        {
            groupAssertionId: 'members-converge-all-equal',
            description: 'Every agent read the same converged member count.',
            aggregate: 'allEqual',
            source: {
                recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
                commandId: 'group-assertions-members-read',
                path: 'body.memberCount',
            },
        },
        {
            groupAssertionId: 'members-expected-count',
            description: 'The converged member count matches the fleet size.',
            aggregate: 'allMatch',
            source: {
                recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
                commandId: 'group-assertions-members-read',
                path: 'body.memberCount',
            },
            predicate: {
                operator: 'equals',
                expected: expectedParticipantCount,
            },
        },
        {
            groupAssertionId: 'no-agent-observed-leak',
            description: 'No agent anywhere matched the leak-probe marker during its ' +
                'absence window.',
            aggregate: 'noneMatch',
            source: {
                recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
                commandId: 'group-assertions-no-leak-probe',
                path: 'matched',
            },
            predicate: {
                operator: 'equals',
                expected: true,
            },
        },
    ];
}
