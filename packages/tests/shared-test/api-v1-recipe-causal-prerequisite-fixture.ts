import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { BlackBoxFetch } from '@shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import { toExecutableInteractions } from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

export interface CapturedRecipeRequest {
    readonly method: string;
    readonly path: string;
    readonly atEpochMs: number;
    readonly body: string | undefined;
}

export interface RecipeHttpPort {
    readonly fetch: BlackBoxFetch;
    readonly requests: CapturedRecipeRequest[];
}

export interface RecipeSegmentInput {
    readonly recipe: string;
    readonly start: string;
    readonly end: string | undefined;
    readonly outputs: ApiJsonObject;
    readonly fetch: BlackBoxFetch;
}

export interface RecipeTopologyInput {
    readonly groupRevision: number;
    readonly presenceRevision: number;
    readonly version: number;
    readonly activeSessionIds: readonly string[];
}

export const GROUP_PATH = '/api/state/apps/causal-app/workspaces/causal-workspace/groups/causal-group';
export const ALICE: ApiJsonObject = { sessionId: 'alice-session', principalId: 'alice', generationId: 'generation-fence-semantic', status: 'active' };
export const BOB: ApiJsonObject = { sessionId: 'bob-session', principalId: 'bob', generationId: 'generation-fence-semantic', status: 'active' };
export const AUTH_OUTPUTS: ApiJsonObject = {
    aliceClientId: 'alice',
    aliceSessionId: 'alice-session',
    aliceAuthHeader: 'Bearer alice-test',
    bobClientId: 'bob',
    bobSessionId: 'bob-session',
    bobAuthHeader: 'Bearer bob-test'
};

export function executeRecipeSegment(input: RecipeSegmentInput): ReturnType<typeof executeBlackBox> {
    const recipe = readApiV1Recipe(`tests/api-v1/${input.recipe}.json`);
    const steps = recipe.steps ?? [];
    const start = steps.findIndex(({ name }) => name === input.start);
    const end = input.end === undefined ? steps.length - 1 : steps.findIndex(({ name }) => name === input.end);
    if (start < 0 || end < start) {
        throw new Error(`Missing semantic recipe segment ${input.recipe}: ${input.start}..${input.end}`);
    }
    return executeBlackBox(
        toExecutableInteractions({
            ...recipe,
            variables: {
                apiPrimary: 'http://causal.test',
                rallarApiBaseUrl: 'http://causal.test',
                applicationId: 'causal-app',
                workspaceId: 'causal-workspace',
                groupId: 'causal-group',
                fenceGroupId: 'causal-group',
                runId: 'semantic',
                aliceUsername: 'alice',
                alicePassword: 'test-password'
            },
            steps: [
                ...Object.entries(input.outputs).map(([output, value]) => ({ name: `seed-${output}`, type: 'set', output, value })),
                ...steps.slice(start, end + 1)
            ]
        }),
        0,
        { failFast: true, dependencies: { now: Date.now, createUuid: () => 'causal-semantic', fetch: input.fetch } }
    );
}

export function createRecipeHttpPort(respond: (request: CapturedRecipeRequest) => Response): RecipeHttpPort {
    const requests: CapturedRecipeRequest[] = [];
    const fetch: BlackBoxFetch = async (url, request) => {
        const captured = {
            method: request?.method ?? 'GET',
            path: new URL(String(url)).pathname,
            atEpochMs: Date.now(),
            body: request?.body ? String(request.body) : undefined
        };
        requests.push(captured);
        return respond(captured);
    };
    return { fetch, requests };
}

export function toGroupSnapshot(groupRevision: number, presenceRevision: number, activeSessions: readonly ApiJsonValue[]): ApiJsonObject {
    return {
        group: {
            groupId: 'causal-group',
            lifecycleState: 'planned',
            formationEpoch: 1,
            formationAttemptCount: 0,
            establishmentStartedAtEpochMs: null,
            snapshotVersion: 4
        },
        causalRevision: { groupRevision, presenceRevision },
        onlineMemberCount: activeSessions.length > 1 ? 2 : 1,
        activeSessions: [...activeSessions]
    };
}

export function toTopology(input: RecipeTopologyInput): ApiJsonObject {
    const { groupRevision, presenceRevision, version, activeSessionIds } = input;
    return {
        groupRef: { applicationId: 'causal-app', workspaceId: 'causal-workspace', groupId: 'causal-group' },
        snapshot: { state: 'active', sourceGroupStateCausalRevision: { groupRevision, presenceRevision }, version, activeSessionIds: [...activeSessionIds] }
    };
}
