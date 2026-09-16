import type {
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedGroupRef
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { toHetznerRoomProofCommands } from './hetzner-room-proof-commands.ts';

const CONTROL_TOPIC = 'black-box.group-assertions.control';
const LEAK_PROBE_TOPIC = 'black-box.group-assertions.leak-probe';
const ENSURE_GROUP_REQUEST_ID = 'c9602657-7db6-48c2-b9dd-fadf8e4f76eb-{runtimeIdentity}';
const ENSURE_MEMBER_REQUEST_ID = 'f026327b-5bb1-4246-9694-cec49a0ca372-{runtimeIdentity}';

export const HETZNER_GROUP_ASSERTIONS_RECIPE_ID = 'group-assertions-recipe';

// One room only, per the Hetzner isolation contract: each agent proves
// delivery with a same-room control frame, holds an absence window against
// the leak-probe marker, then polls the shared group snapshot until both
// members converged and records one final read as coordinator evidence.
export function createHetznerGroupAssertionsRecipe(
    group: RallarBlackBoxDistributedGroupRef
): RallarBlackBoxTestRecipe {
    const roomRef = {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
    const statePrefix = `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}`;
    const groupSnapshotPath = `${statePrefix}/groups/${group.groupId}`;

    return {
        schemaVersion: 1,
        recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
        name: 'Group assertions recipe',
        continueOnFailure: false,
        metadata: {
            profile: 'group-assertions',
            group: roomRef
        },
        commands: [
            ...toHetznerRoomProofCommands({
                group: roomRef,
                prefix: 'group-assertions',
                connection: 'groupAssertionsRtc',
                controlTopic: CONTROL_TOPIC,
                leakProbeTopic: LEAK_PROBE_TOPIC,
                groupRequestId: ENSURE_GROUP_REQUEST_ID,
                memberRequestId: ENSURE_MEMBER_REQUEST_ID,
                absencePurpose:
                    'Per-agent absence window; the coordinator noneMatch assertion then proves no agent anywhere recorded a leak-probe match.'
            }),
            toGroupMembershipConvergenceLoop(groupSnapshotPath),
            {
                kind: 'http.request',
                commandId: 'group-assertions-members-read',
                timeoutMs: 5_000,
                metadata: {
                    purpose: 'Final converged snapshot read; the coordinator allEqual and ' +
                        'allMatch assertions compare this value across every agent.'
                },
                request: {
                    method: 'GET',
                    path: groupSnapshotPath
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200]
                }
            },
            {
                kind: 'stats',
                commandId: 'group-assertions-stats'
            }
        ]
    };
}

// The authoring rule composes allEqual with allMatch: allEqual alone passes
// when every agent agrees on the same wrong value, so the known expectation
// rides beside it, and noneMatch states the isolation claim fleet-wide.
export function createHetznerGroupAssertions(
    expectedParticipantCount: number
): readonly RallarBlackBoxDistributedGroupAssertion[] {
    return [
        {
            groupAssertionId: 'members-converge-all-equal',
            description: 'Every agent read the same converged member count.',
            aggregate: 'allEqual',
            source: {
                recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
                commandId: 'group-assertions-members-read',
                path: 'body.memberCount'
            }
        },
        {
            groupAssertionId: 'members-expected-count',
            description: 'The converged member count matches the fleet size.',
            aggregate: 'allMatch',
            source: {
                recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
                commandId: 'group-assertions-members-read',
                path: 'body.memberCount'
            },
            predicate: {
                operator: 'equals',
                expected: expectedParticipantCount
            }
        },
        {
            groupAssertionId: 'no-agent-observed-leak',
            description: 'No agent anywhere matched the leak-probe marker during its ' +
                'absence window.',
            aggregate: 'noneMatch',
            source: {
                recipeId: HETZNER_GROUP_ASSERTIONS_RECIPE_ID,
                commandId: 'group-assertions-no-leak-probe',
                path: 'matched'
            },
            predicate: {
                operator: 'equals',
                expected: true
            }
        }
    ];
}

function toGroupMembershipConvergenceLoop(groupSnapshotPath: string): RallarBlackBoxTestCommand {
    return {
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
                    path: groupSnapshotPath
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200]
                }
            },
            {
                kind: 'assert',
                commandId: 'group-assertions-membership-converged',
                source: 'lastResult.value.body.memberCount',
                operator: 'gte',
                expected: 2
            }
        ]
    };
}
