import { describe, expect, it } from 'vitest';

import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { BlackBoxFetch } from '@shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import { toExecutableInteractions } from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface StateReadObservation {
    readonly clientFloor: number;
    readonly groupFloor: number;
    readonly presenceFloor: number;
    readonly clientRevision: number;
    readonly groupRevision: number;
    readonly presenceRevision: number;
    readonly invalid: string;
}

interface StateReadHttpPort {
    readonly fetch: BlackBoxFetch;
    readonly requests: { readonly method: string; readonly host: string; readonly path: string; }[];
}

const EQUAL_FLOORS: StateReadObservation = {
    clientFloor: 2,
    groupFloor: 3,
    presenceFloor: 5,
    clientRevision: 2,
    groupRevision: 3,
    presenceRevision: 5,
    invalid: ''
};

describe('API-v1 state-read convergence recipe', () => {
    it.each([
        { name: 'equal floors', observation: EQUAL_FLOORS },
        {
            name: 'hosted presence projection advances from zero to one',
            observation: { ...EQUAL_FLOORS, groupFloor: 1, presenceFloor: 0, groupRevision: 1, presenceRevision: 1 }
        },
        { name: 'newer scalar', observation: { ...EQUAL_FLOORS, clientRevision: 4 } },
        { name: 'newer group component', observation: { ...EQUAL_FLOORS, groupRevision: 4 } },
        { name: 'both causal components advance', observation: { ...EQUAL_FLOORS, groupRevision: 4, presenceRevision: 6 } }
    ])('accepts $name while proving body and canonical headers agree', async ({ observation }) => {
        const http = createStateReadHttpPort(observation);
        const report = await executeStateReadRecipe(http.fetch);

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.assertReadConvergenceEvidence[0].status).toBe('SUCCESS');
        expect(http.requests.filter(({ path }) => path.includes('?'))).toEqual([
            {
                method: 'GET',
                host: 'tertiary.test',
                path: `/api/state/apps/state-read-semantic/workspaces/default-semantic/clients/alice?minStateRevision=${observation.clientFloor}`
            },
            {
                method: 'GET',
                host: 'secondary.test',
                path: '/api/state/apps/state-read-semantic/workspaces/default-semantic/clients/alice?minStateRevision=9007199254740991'
            },
            {
                method: 'GET',
                host: 'tertiary.test',
                path:
                    `/api/state/apps/state-read-semantic/workspaces/default-semantic/groups/snapshot-room-semantic?minGroupRevision=${observation.groupFloor}&minPresenceRevision=${observation.presenceFloor}`
            },
            {
                method: 'GET',
                host: 'primary.test',
                path: `/api/state/apps/state-read-semantic/workspaces/default-semantic/groups/snapshot-room-semantic?minGroupRevision=${observation.groupFloor}`
            }
        ]);
        expect(http.requests.filter(({ method }) => method !== 'GET').map(({ host }) => host)).toEqual([
            'primary.test',
            'primary.test',
            'secondary.test',
            'primary.test',
            'secondary.test'
        ]);
    });

    it.each([
        { name: 'scalar below minimum', observation: { ...EQUAL_FLOORS, clientRevision: 1 } },
        { name: 'dominated causal tuple', observation: { ...EQUAL_FLOORS, groupRevision: 2, presenceRevision: 4 } },
        { name: 'newer group but older presence', observation: { ...EQUAL_FLOORS, groupRevision: 4, presenceRevision: 4 } },
        { name: 'older group but newer presence', observation: { ...EQUAL_FLOORS, groupRevision: 2, presenceRevision: 6 } }
    ])('refuses $name', async ({ observation }) => {
        const report = await executeStateReadRecipe(createStateReadHttpPort(observation).fetch);
        expect(report.summary.failure).toBeGreaterThan(0);
    });

    it.each([
        'wrong scalar header',
        'wrong group header',
        'wrong presence header',
        'missing scalar header',
        'missing group header',
        'missing presence header',
        'noncanonical scalar header',
        'noncanonical group header',
        'noncanonical presence header',
        'text scalar body',
        'text group body',
        'text presence body',
        'unsatisfied floor accepted',
        'wrong unsatisfied code',
        'partial floor accepted',
        'wrong partial code'
    ])('refuses %s', async (invalid) => {
        const report = await executeStateReadRecipe(createStateReadHttpPort({ ...EQUAL_FLOORS, invalid }).fetch);
        expect(report.summary.failure).toBeGreaterThan(0);
    });
});

function executeStateReadRecipe(fetch: BlackBoxFetch): ReturnType<typeof executeBlackBox> {
    const recipe = readApiV1Recipe('tests/api-v1/api-v1-state-read-convergence.json');
    return executeBlackBox(
        toExecutableInteractions({
            ...recipe,
            variables: {
                ...recipe.variables,
                apiPrimary: 'http://primary.test',
                apiSecondary: 'http://secondary.test',
                apiTertiary: 'http://tertiary.test',
                runId: 'semantic',
                aliceUsername: 'alice',
                alicePassword: 'test-password'
            }
        }),
        0,
        { failFast: true, dependencies: { now: Date.now, createUuid: () => 'state-read-semantic', fetch } }
    );
}

function createStateReadHttpPort(observation: StateReadObservation): StateReadHttpPort {
    const requests: StateReadHttpPort['requests'] = [];
    const fetch: BlackBoxFetch = async (url, request) => {
        const parsed = new URL(String(url));
        const method = request?.method ?? 'GET';
        requests.push({ method, host: parsed.host, path: parsed.pathname + parsed.search });
        if (parsed.pathname.includes('/auth/login/')) {
            return Response.json({ clientId: 'alice', sessionId: 'alice-session', accessToken: 'semantic-token' });
        }
        if (method === 'GET' && parsed.searchParams.get('minStateRevision') === '9007199254740991') {
            return Response.json({ code: observation.invalid === 'wrong unsatisfied code' ? 'wrong' : 'state-revision-floor-not-satisfied' }, {
                status: observation.invalid === 'unsatisfied floor accepted' ? 200 : 409
            });
        }
        if (method === 'GET' && parsed.searchParams.has('minGroupRevision') && !parsed.searchParams.has('minPresenceRevision')) {
            return Response.json({ code: observation.invalid === 'wrong partial code' ? 'wrong' : 'invalid-group-causal-revision' }, {
                status: observation.invalid === 'partial floor accepted' ? 200 : 400
            });
        }
        if (parsed.pathname.includes('/clients/')) {
            return method === 'GET' ? toStateReadResponse('client', observation) : Response.json({ stateRevision: observation.clientFloor });
        }
        if (method === 'POST') {
            return Response.json({ group: { groupId: 'snapshot-room-semantic' } }, { status: 201 });
        }
        return method === 'GET' ? toStateReadResponse('group', observation) : Response.json({
            causalRevision: { groupRevision: observation.groupFloor, presenceRevision: observation.presenceFloor }
        });
    };
    return { fetch, requests };
}

function toStateReadResponse(kind: 'client' | 'group', observation: StateReadObservation): Response {
    const revisions = kind === 'client'
        ? [{ name: 'scalar', header: 'Rallar-State-Revision', value: observation.clientRevision }]
        : [
            { name: 'group', header: 'Rallar-Group-Revision', value: observation.groupRevision },
            { name: 'presence', header: 'Rallar-Presence-Revision', value: observation.presenceRevision }
        ];
    const headers: Record<string, string> = { 'Rallar-State-Source': 'durable' };
    for (const revision of revisions) {
        if (observation.invalid !== `missing ${revision.name} header`) {
            headers[revision.header] = observation.invalid === `wrong ${revision.name} header`
                ? String(revision.value + 1)
                : observation.invalid === `noncanonical ${revision.name} header`
                ? `0${revision.value}`
                : String(revision.value);
        }
    }
    const body = kind === 'client'
        ? {
            stateRevision: observation.invalid === 'text scalar body' ? String(observation.clientRevision) : observation.clientRevision
        }
        : {
            causalRevision: {
                groupRevision: observation.invalid === 'text group body' ? String(observation.groupRevision) : observation.groupRevision,
                presenceRevision: observation.invalid === 'text presence body' ? String(observation.presenceRevision) : observation.presenceRevision
            }
        };
    return Response.json(body, { headers });
}
