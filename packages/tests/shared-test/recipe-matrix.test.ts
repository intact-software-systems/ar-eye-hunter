import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type MatrixEntry = {
    id: string;
    recipe: string;
    category: string;
    mode: string;
    profiles: string[];
    expectedExitCode: number;
    artifactName?: string;
    requires?: {
        env?: string[];
        httpServices?: Array<{ name: string; env: string; default?: string }>;
        playwright?: boolean;
        livePreflight?: {
            timeoutMs?: number;
        };
    };
};

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const runnerRoot = path.join(repoRoot, 'packages/shared-test/black-box-runner');
const examplesRoot = path.join(runnerRoot, 'examples');
const testsRoot = path.join(runnerRoot, 'tests');
const matrixPath = path.join(runnerRoot, 'recipe-matrix.json');

function readMatrix(): { entries: MatrixEntry[] } {
    return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

function readRecipe(relativePath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(runnerRoot, relativePath), 'utf8'));
}

function listJsonRecipes(root: string, prefix: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        const entryPrefix = prefix + entry.name;
        const entryPath = path.join(root, entry.name);

        if (entry.isDirectory()) {
            return listJsonRecipes(entryPath, entryPrefix + '/');
        }

        return entry.isFile() && entry.name.endsWith('.json') ? [entryPrefix] : [];
    });
}

function rtcProviders(recipe: Record<string, unknown>): string[] {
    const connections = recipe.connections as Record<string, { type?: string; provider?: string }>;
    return Object.values(connections)
        .filter(connection => connection.type === 'rtc')
        .map(connection => connection.provider ?? '');
}

function flattenRecipeSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return steps.flatMap(step => {
        const nested = Array.isArray(step.steps)
            ? flattenRecipeSteps(step.steps as Array<Record<string, unknown>>)
            : [];
        const grouped = Array.isArray(step.groups)
            ? (step.groups as Array<{ steps?: Array<Record<string, unknown>> }>).flatMap(group =>
                flattenRecipeSteps(group.steps ?? [])
            )
            : [];
        return [step, ...nested, ...grouped];
    });
}

describe('black-box runner recipe matrix', () => {
    it('has unique entry ids and artifact names', () => {
        const { entries } = readMatrix();
        const ids = entries.map(entry => entry.id);
        const artifactNames = entries.map(entry => entry.artifactName ?? entry.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(artifactNames).size).toBe(artifactNames.length);
    });

    it('points every entry at a catalog recipe file', () => {
        const { entries } = readMatrix();
        const recipeRoots = ['examples/', 'tests/'];

        entries.forEach(entry => {
            expect(recipeRoots.some(root => entry.recipe.startsWith(root))).toBe(true);
            expect(entry.recipe.endsWith('.json')).toBe(true);
            expect(() => readFileSync(path.join(runnerRoot, entry.recipe), 'utf8')).not.toThrow();
        });
    });

    it('covers every example recipe at least once', () => {
        const { entries } = readMatrix();
        const covered = new Set(entries.map(entry => entry.recipe));
        const examples = listJsonRecipes(examplesRoot, 'examples/');

        expect([...covered].sort()).toEqual(expect.arrayContaining(examples.sort()));
    });

    it('covers every test recipe at least once', () => {
        const { entries } = readMatrix();
        const covered = new Set(entries.map(entry => entry.recipe));
        const tests = listJsonRecipes(testsRoot, 'tests/');

        expect(tests.length).toBeGreaterThan(0);
        expect([...covered].sort()).toEqual(expect.arrayContaining(tests.sort()));
    });

    it('uses rallar-signaling for signaling recipe examples and keeps one legacy rallar alias fixture', () => {
        const { entries } = readMatrix();
        const signalingEntries = entries.filter(entry => entry.category === 'rallar-signaling');

        expect(signalingEntries.map(entry => entry.id).sort()).toEqual([
            'rallar-signaling-two-peer-chat-dry',
            'rallar-signaling-two-peer-chat-live',
        ]);

        signalingEntries.forEach(entry => {
            expect(rtcProviders(readRecipe(entry.recipe))).toEqual([
                'rallar-signaling',
                'rallar-signaling',
            ]);
        });

        const legacyAliasFixture = JSON.parse(readFileSync(
            path.join(repoRoot, 'packages/tests/shared-test/examples/rtc-rallar-two-peer-chat.json'),
            'utf8',
        ));
        expect(rtcProviders(legacyAliasFixture)).toEqual(['rallar', 'rallar']);
    });

    it('classifies profiles and execution modes explicitly', () => {
        const { entries } = readMatrix();
        const profiles = new Set(entries.flatMap(entry => entry.profiles));

        expect(profiles.has('quick')).toBe(true);
        expect(profiles.has('dry')).toBe(true);
        expect(profiles.has('deterministic')).toBe(true);
        expect(profiles.has('soak')).toBe(true);
        expect(profiles.has('traffic')).toBe(true);
        expect(profiles.has('parallel')).toBe(true);
        expect(profiles.has('live')).toBe(true);
        expect(profiles.has('live-soak')).toBe(true);
        expect(profiles.has('live-traffic')).toBe(true);
        expect(profiles.has('live-parallel')).toBe(true);
        expect(profiles.has('api-v1-black-box')).toBe(true);
        expect(profiles.has('api-v1-black-box-recipes')).toBe(true);

        entries.forEach(entry => {
            expect(['dry-run', 'run']).toContain(entry.mode);
            expect(entry.profiles.length).toBeGreaterThan(0);
            expect([0, 1]).toContain(entry.expectedExitCode);
        });
    });

    it('offers an offline validation profile that lists recipes without live preflight gates', () => {
        const result = spawnSync('deno', [
            'run',
            '-A',
            path.join(runnerRoot, 'recipe-matrix.mts'),
            '--profile=validation',
            '--list',
        ], {
            cwd: repoRoot,
            encoding: 'utf8',
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');

        const lines = result.stdout.trim().split('\n').filter(Boolean);
        const recipes = lines.map(line => line.split('|')[2]?.trim());

        expect(lines.length).toBeGreaterThan(0);
        expect(new Set(recipes).size).toBe(recipes.length);
        expect(recipes).toContain('examples/rtc-rallar-browser-connect.json');
        expect(recipes).toContain('examples/rtc-rallar-two-peer-chat.json');
    });

    it('gates live browser and remote entries', () => {
        const { entries } = readMatrix();
        const liveEntries = entries.filter(entry => entry.profiles.includes('live'));

        liveEntries.forEach(entry => {
            expect(entry.requires).toBeTruthy();
        });

        const browserLiveEntries = entries.filter(entry => entry.profiles.includes('browser-live'));
        browserLiveEntries.forEach(entry => {
            expect(entry.requires?.playwright).toBe(true);
        });

        const remoteLiveEntries = entries.filter(entry => entry.profiles.includes('remote-live'));
        remoteLiveEntries.forEach(entry => {
            expect(entry.requires?.env).toContain('RALLAR_BLACK_BOX_CONTROL_BASE_URL');
            expect(entry.requires?.env).toContain('RALLAR_BLACK_BOX_AGENT_ID');
        });
    });

    it('gives AppInbox-backed API cluster preflight checks a realistic deadline', () => {
        const { entries } = readMatrix();
        const clusterEntries = entries.filter(entry =>
            entry.profiles.includes('api-v1-black-box-cluster')
        );

        expect(clusterEntries.length).toBeGreaterThan(0);
        clusterEntries.forEach(entry => {
            expect(entry.requires?.livePreflight?.timeoutMs).toBe(10_000);
        });
    });

    it('includes gated live-provider baselines for soak, traffic, and parallel RTC patterns', () => {
        const { entries } = readMatrix();
        const byProfile = (profile: string) => entries.filter(entry => entry.profiles.includes(profile));

        expect(byProfile('live-soak').map(entry => entry.id).sort()).toEqual([
            'browser-messages-rtc-same-connection-soak-live',
            'remote-messages-rtc-same-connection-soak-live',
        ]);
        expect(byProfile('live-traffic').map(entry => entry.id).sort()).toEqual([
            'browser-messages-rtc-seeded-traffic-live',
            'remote-messages-rtc-seeded-traffic-live',
        ]);
        expect(byProfile('live-parallel').map(entry => entry.id).sort()).toEqual([
            'browser-messages-rtc-parallel-groups-live',
            'remote-messages-rtc-parallel-groups-live',
        ]);

        for (const entry of [
            ...byProfile('live-soak'),
            ...byProfile('live-traffic'),
            ...byProfile('live-parallel'),
        ]) {
            expect(entry.mode).toBe('run');
            expect(entry.expectedExitCode).toBe(0);
            expect(entry.profiles).toContain('live');
            expect(entry.requires?.env).toContain('RALLAR_API_BASE_URL');
            expect(entry.requires?.env).toContain('RALLAR_ALICE_USERNAME');
            expect(entry.requires?.env).toContain('RALLAR_BOB_USERNAME');
        }
    });

    it('includes a dedicated live-crdt profile for CRDT validation rows', () => {
        const { entries } = readMatrix();
        const crdtLiveEntries = entries.filter(entry => entry.profiles.includes('live-crdt'));

        expect(crdtLiveEntries.map(entry => entry.id).sort()).toEqual([
            'crdt-admin-http-integrity-live',
            'crdt-browser-durable-late-join-catchup-live',
            'crdt-browser-local-persistence-reopen-live',
            'crdt-browser-rtc-with-ws-fallback-live',
            'crdt-browser-ws-convergence-live',
        ]);

        crdtLiveEntries.forEach(entry => {
            expect(entry.category).toBe('rallar-crdt');
            expect(entry.mode).toBe('run');
            expect(entry.expectedExitCode).toBe(0);
            expect(entry.profiles).toContain('live');
            expect(entry.requires?.env).toContain('RALLAR_API_BASE_URL');
        });

        crdtLiveEntries
            .filter(entry => entry.id !== 'crdt-admin-http-integrity-live')
            .forEach(entry => {
                expect(entry.requires?.playwright).toBe(true);
                expect(entry.requires?.env).toContain('RALLAR_ALICE_USERNAME');
            });

        const adminEntry = crdtLiveEntries.find(entry => entry.id === 'crdt-admin-http-integrity-live');
        expect(adminEntry?.requires?.env).toContain('RALLAR_ADMIN_ACCESS_TOKEN');
        expect(adminEntry?.requires?.env).toContain('RALLAR_CRDT_DOCUMENT_KEY');
    });

    it('defines a no-browser API-v1 black-box profile', () => {
        const { entries } = readMatrix();
        const apiEntries = entries.filter(entry => entry.profiles.includes('api-v1-black-box'));

        expect(apiEntries.map(entry => entry.id).sort()).toEqual([
            'api-v1-admin-operations',
            'api-v1-admin-support',
            'api-v1-auth-session',
            'api-v1-black-box-control-auth',
            'api-v1-client-state',
            'api-v1-group-presence',
            'api-v1-ice-config',
            'api-v1-openapi-topology-auth',
            'api-v1-scope-isolation',
            'api-v1-spa-statistics',
            'api-v1-websocket-topic-routing',
        ]);

        apiEntries.forEach(entry => {
            expect(entry.category).toBe('api-v1-black-box');
            expect(entry.recipe).toMatch(/^tests\/api-v1\/api-v1-.*\.json$/);
            expect(entry.mode).toBe('run');
            expect(entry.expectedExitCode).toBe(0);
            expect(entry.profiles).toContain('api-v1-black-box');
            expect(entry.profiles).not.toContain('browser-live');
            expect(entry.profiles).not.toContain('remote-live');
            expect(entry.requires?.playwright).not.toBe(true);
            expect(entry.requires?.httpServices).toEqual([
                {
                    name: 'Rallar API',
                    env: 'RALLAR_API_BASE_URL',
                    default: 'http://127.0.0.1:18080',
                },
            ]);
        });
    });

    it('defines a portable recipes-only API-v1 black-box profile', () => {
        const { entries } = readMatrix();
        const apiRecipeEntries = entries.filter(entry => entry.profiles.includes('api-v1-black-box-recipes'));

        expect(apiRecipeEntries.map(entry => entry.id).sort()).toEqual([
            'api-v1-admin-operations',
            'api-v1-admin-support',
            'api-v1-auth-session',
            'api-v1-client-state',
            'api-v1-group-presence',
            'api-v1-openapi-topology-auth',
            'api-v1-scope-isolation',
            'api-v1-spa-statistics',
            'api-v1-websocket-topic-routing',
        ]);

        apiRecipeEntries.forEach(entry => {
            expect(entry.category).toBe('api-v1-black-box');
            expect(entry.recipe).toMatch(/^tests\/api-v1\/api-v1-.*\.json$/);
            expect(entry.profiles).toContain('api-v1-black-box');
            expect(entry.requires?.playwright).not.toBe(true);
        });
    });

    it('covers client-state generation fencing and public idempotency conflicts', () => {
        const recipe = readRecipe('tests/api-v1/api-v1-client-state.json');
        const steps = recipe.steps as Array<{
            name?: string;
            request?: { body?: Record<string, unknown> };
            expect?: { status?: number };
        }>;
        const step = (name: string) => steps.find((candidate) => candidate.name === name);

        const first = step('upsertAlicePrincipal');
        const equivalent = step('replayEquivalentAlicePrincipal');
        const conflict = step('rejectConflictingAlicePrincipalReplay');
        expect(steps.indexOf(first!)).toBeLessThan(steps.indexOf(equivalent!));
        expect(steps.indexOf(equivalent!)).toBeLessThan(steps.indexOf(conflict!));
        expect(equivalent?.request?.body?.requestId).toBe(
            first?.request?.body?.requestId,
        );
        expect(Object.keys(equivalent?.request?.body ?? {})).not.toEqual(
            Object.keys(first?.request?.body ?? {}),
        );
        expect(conflict?.request?.body?.requestId).toBe(
            first?.request?.body?.requestId,
        );
        expect(conflict?.request?.body?.displayName).not.toBe(
            first?.request?.body?.displayName,
        );
        expect(conflict?.expect?.status).toBe(409);

        for (const name of [
            'connectAliceClientSession',
            'heartbeatAliceClientSession',
            'disconnectAliceClientSession',
        ]) {
            expect(step(name)?.request?.body?.generationId).toBe(
                '{clientGenerationId}',
            );
        }
    });

    it('keeps API-v1 black-box recipes free of RTC connections', () => {
        const { entries } = readMatrix();
        const apiEntries = entries.filter(entry => entry.profiles.includes('api-v1-black-box'));

        apiEntries.forEach(entry => {
            const recipe = readRecipe(entry.recipe);
            const connections = recipe.connections as Record<string, { type?: string }> | undefined;
            const connectionTypes = Object.values(connections ?? {}).map(connection => connection.type);

            expect(connectionTypes).not.toContain('rtc');
            expect(JSON.stringify(recipe)).not.toContain('rallar-browser');
            expect(JSON.stringify(recipe)).not.toContain('rallar-remote-browser');
        });
    });

    it('requires the tertiary HTTP service for every built-in Postgres cluster recipe', () => {
        const { entries } = readMatrix();
        const clusterRecipeIds = [
            'api-v1-state-read-convergence',
            'api-v1-rtc-topology-convergence',
            'api-v1-state-topology-churn',
            'api-v1-state-write-convergence',
            'api-v1-crdt-app-inbox',
            'api-v1-state-medium-scale-churn',
        ];

        for (const recipeId of clusterRecipeIds) {
            const entry = entries.find(candidate => candidate.id === recipeId);
            expect(
                entry?.requires?.httpServices?.map(service => service.env),
                recipeId,
            ).toEqual([
                'RALLAR_API_BASE_URL',
                'RALLAR_API_BASE_URL_SECONDARY',
                'RALLAR_API_BASE_URL_TERTIARY',
            ]);
        }
    });

    it('routes REST floor reads through the tertiary API after primary warmup and secondary mutation', () => {
        const { entries } = readMatrix();
        const entry = entries.find(candidate =>
            candidate.id === 'api-v1-state-read-convergence'
        );

        expect(entry?.requires?.httpServices?.map(service => service.env)).toEqual([
            'RALLAR_API_BASE_URL',
            'RALLAR_API_BASE_URL_SECONDARY',
            'RALLAR_API_BASE_URL_TERTIARY',
        ]);

        const recipe = readRecipe(entry!.recipe);
        const connections = recipe.connections as Record<string, { type?: string }>;
        expect(Object.keys(connections)).toEqual(['primary', 'secondary', 'tertiary']);
        const steps = recipe.steps as Array<Record<string, unknown>>;
        expect(steps.find(step => step.name === 'warmPrimaryClient')).toMatchObject({
            connection: 'primary',
        });
        expect(steps.find(step => step.name === 'mutateClientOnSecondary')).toMatchObject({
            connection: 'secondary',
        });
        expect(steps.find(step => step.name === 'readClientFloorOnTertiary')).toMatchObject({
            connection: 'tertiary',
            expect: { status: 200 },
        });
        expect(steps.find(step => step.name === 'readGroupFloorOnTertiary')).toMatchObject({
            connection: 'tertiary',
            expect: { status: 200 },
        });

        const assertion = steps.find(step => step.name === 'assertReadConvergenceEvidence');
        expect(JSON.stringify(assertion)).toContain('readClientFloorOnTertiary');
        expect(JSON.stringify(assertion)).toContain('readGroupFloorOnTertiary');
        expect(JSON.stringify(assertion)).toContain('rallar-state-revision');
        expect(JSON.stringify(assertion)).toContain('rallar-group-revision');
        expect(JSON.stringify(assertion)).toContain('rallar-presence-revision');
    });

    it('defines a no-browser three-server topology convergence recipe', () => {
        const { entries } = readMatrix();
        const entry = entries.find(candidate =>
            candidate.id === 'api-v1-rtc-topology-convergence'
        );

        expect(entry).toMatchObject({
            category: 'api-v1-black-box',
            mode: 'run',
            expectedExitCode: 0,
            profiles: ['api-v1-black-box-cluster'],
            requires: {
                httpServices: [
                    {
                        name: 'Rallar API primary',
                        env: 'RALLAR_API_BASE_URL',
                        default: 'http://127.0.0.1:18080',
                    },
                    {
                        name: 'Rallar API secondary',
                        env: 'RALLAR_API_BASE_URL_SECONDARY',
                        default: 'http://127.0.0.1:18081',
                    },
                    {
                        name: 'Rallar API tertiary',
                        env: 'RALLAR_API_BASE_URL_TERTIARY',
                        default: 'http://127.0.0.1:18082',
                    },
                ],
            },
        });
        expect(entry?.requires?.playwright).not.toBe(true);
        expect(entry?.profiles).not.toContain('api-v1-black-box-recipes');

        const recipe = readRecipe(entry!.recipe);
        const connections = recipe.connections as Record<
            string,
            { type?: string }
        >;
        expect(Object.values(connections).filter(connection =>
            connection.type === 'http'
        )).toHaveLength(3);
        expect(Object.values(connections).filter(connection =>
            connection.type === 'ws'
        )).toHaveLength(2);
        expect(connections.wsTertiary).toMatchObject({ type: 'ws' });
        expect(Object.values(connections).some(connection =>
            connection.type === 'rtc'
        )).toBe(false);
        expect(JSON.stringify(recipe)).not.toContain('rallar-browser');
        expect(JSON.stringify(recipe)).not.toContain('RTCPeerConnection');
        expect((recipe.steps as Array<{ type?: string }>).some(step =>
            step.type === 'parallel'
        )).toBe(true);
        const allSteps = flattenRecipeSteps(recipe.steps as Array<Record<string, unknown>>);
        expect(allSteps.find(step =>
            step.name === 'updateGroupThroughSecondary'
        )).toMatchObject({ connection: 'apiSecondary' });
        expect(allSteps.find(step =>
            step.name === 'waitForBothRevisionsOnTertiary'
        )).toMatchObject({ type: 'ws.wait', connection: 'wsTertiary' });
    });

    it('defines bounded three-server multi-client and multi-group churn coverage', () => {
        const { entries } = readMatrix();
        const entry = entries.find(candidate =>
            candidate.id === 'api-v1-state-topology-churn'
        );

        expect(entry).toMatchObject({
            category: 'api-v1-black-box',
            mode: 'run',
            expectedExitCode: 0,
            profiles: ['api-v1-black-box-cluster'],
        });
        expect(entry?.requires?.playwright).not.toBe(true);

        const recipe = readRecipe(entry!.recipe);
        const parallel = (recipe.steps as Array<Record<string, unknown>>)
            .find(step => step.name === 'runConcurrentClientChurn') as {
                type?: string;
                groups?: Array<{ steps?: Array<Record<string, unknown>> }>;
        };
        expect(parallel.type).toBe('parallel');
        expect(parallel.groups).toHaveLength(3);
        expect(parallel.groups?.map(group => {
            const loop = group.steps?.find(step => step.type === 'loop');
            return loop?.count;
        })).toEqual([4, 4, 4]);
        expect(parallel.groups?.map(group => {
            const steps = flattenRecipeSteps(group.steps ?? []);
            return new Set(steps.map(step => step.connection).filter(Boolean));
        })).toEqual([
            new Set(['apiPrimary']),
            new Set(['apiSecondary']),
            new Set(['apiTertiary']),
        ]);
        const finalReads = (recipe.steps as Array<Record<string, unknown>>)
            .filter(step => String(step.name).startsWith('read'))
            .filter(step =>
                String((step.request as { path?: string })?.path).includes('/groups/')
            );
        expect(new Set(finalReads.map(step => step.connection))).toEqual(
            new Set(['apiPrimary', 'apiTertiary']),
        );
        expect(JSON.stringify(recipe)).toContain('disconnect');
        expect(JSON.stringify(recipe)).toContain('topology/reconfigure');
    });

    it('defines three-server API state-write convergence with bounded causal polling', () => {
        const { entries } = readMatrix();
        const entry = entries.find(candidate =>
            candidate.id === 'api-v1-state-write-convergence'
        );

        expect(entry).toMatchObject({
            id: 'api-v1-state-write-convergence',
            recipe: 'tests/api-v1/api-v1-state-write-convergence.json',
            category: 'api-v1-black-box',
            mode: 'run',
            profiles: ['api-v1-black-box-cluster'],
            expectedExitCode: 0,
        });
        if (!entry) return;
        expect(entry.requires?.httpServices).toHaveLength(3);
        expect(entry.requires?.playwright).not.toBe(true);

        const recipe = readRecipe(entry.recipe);
        const steps = recipe.steps as Array<Record<string, unknown>>;
        const allSteps = flattenRecipeSteps(steps);
        const recipeText = JSON.stringify(recipe);
        for (const contender of ['Primary', 'Secondary']) {
            const registerName = `register${contender}Contender`;
            const loginName = `login${contender}Contender`;
            const deriveName = `derive${contender}ContenderAuthHeader`;
            const register = steps.find(step => step.name === registerName);
            const login = steps.find(step => step.name === loginName);
            expect(steps.indexOf(register!)).toBeLessThan(steps.indexOf(login!));
            expect(steps.indexOf(login!)).toBeLessThan(
                steps.indexOf(steps.find(step => step.name === deriveName)!),
            );
            expect(register?.request).toMatchObject({
                method: 'POST',
                path: '/api/auth/register',
                outputs: {
                    [`${contender.toLowerCase()}ContenderClientId`]: 'body.clientId',
                },
            });
            expect(register?.expect).toEqual({
                status: 201,
                body: { clientId: 'string' },
            });
            expect(login?.request).toMatchObject({
                method: 'POST',
                path: '/api/auth/login',
                outputs: {
                    [`${contender.toLowerCase()}ContenderAccessToken`]: {
                        path: 'body.accessToken',
                        secret: true,
                    },
                },
            });
            expect(login?.expect).toMatchObject({
                status: 200,
                body: { accessToken: 'string', sessionId: 'string' },
            });
        }
        const race = steps.find(step =>
            step.name === 'raceBoundedMembershipPresenceAndConfig'
        ) as {
            type?: string;
            maxConcurrency?: number;
            groups?: Array<{ steps?: Array<Record<string, unknown>> }>;
        };
        expect(race).toMatchObject({ type: 'parallel', maxConcurrency: 4 });
        expect(race.groups).toHaveLength(4);
        expect(new Set(race.groups?.flatMap(group =>
            (group.steps ?? []).map(step => step.connection)
        ))).toEqual(new Set(['apiPrimary', 'apiSecondary', 'apiTertiary']));
        const capacityAssertion = steps.find(step =>
            step.name === 'assertExactlyOneCapacityWinner'
        );
        expect(capacityAssertion).toMatchObject({
            type: 'assert',
            actual: {
                statuses: [
                    '{resultsByName.activatePrimaryContenderMembership.0.actual.statusCode}',
                    '{resultsByName.activateSecondaryContenderMembership.0.actual.statusCode}',
                ],
            },
            expect: {
                anyOf: [
                    { statuses: [200, 403] },
                    { statuses: [403, 200] },
                ],
            },
        });
        expect(steps.find(step => step.name === 'createBoundedGroup')?.request)
            .toMatchObject({ body: { maxMembers: 2, joinMode: 'open' } });

        const configNames = [
            'putInitialTopologyConfig',
            'deleteTopologyConfig',
            'putFinalTopologyConfig',
        ];
        const configSequence = steps.filter(step =>
            configNames.includes(String(step.name))
        );
        expect(configSequence.map(step => step.name)).toEqual(configNames);
        expect(configSequence.map(step =>
            (step.request as { method?: string })?.method
        )).toEqual(['PUT', 'DELETE', 'PUT']);
        expect(JSON.stringify(recipe)).not.toContain('/topology/reconfigure');
        const reconnect = allSteps.find(step => step.name === 'reconnectReusedSession');
        expect(reconnect?.request)
            .toMatchObject({
                path: expect.stringContaining('{reusedSessionId}'),
                body: {
                    generationId: 'generation-2-{runId}',
                    expiresAtEpochMs: expect.any(Number),
                },
                outputs: {
                    acceptedLifecyclePresenceRevision:
                        'body.causalRevision.presenceRevision',
                    acceptedLifecycleGenerationId:
                        'body.activeSessions.0.generationId',
                },
            });
        expect(steps.find(step => step.name === 'submitStaleExpiryCandidate'))
            .toBeUndefined();
        const captureExpiredPresenceAt = steps.find(step =>
            step.name === 'captureExpiredPresenceAt'
        );
        expect(captureExpiredPresenceAt).toMatchObject({
            type: 'set',
            output: 'expiredPresenceAtEpochMs',
            transform: { timestamp: true },
        });
        expect(steps.find(step => step.name === 'connectReusedSessionGenerationOne')?.request)
            .toMatchObject({
                body: {
                    generationId: 'generation-1-{runId}',
                    connectedAtEpochMs: '{expiredPresenceAtEpochMs}',
                    lastHeartbeatAtEpochMs: '{expiredPresenceAtEpochMs}',
                    expiresAtEpochMs: '{expiredPresenceAtEpochMs}',
                },
            });
        expect(steps.find(step => step.name === 'connectExpiredPresenceProbe')?.request)
            .toMatchObject({
                body: {
                    connectedAtEpochMs: '{expiredPresenceAtEpochMs}',
                    lastHeartbeatAtEpochMs: '{expiredPresenceAtEpochMs}',
                    expiresAtEpochMs: '{expiredPresenceAtEpochMs}',
                },
            });
        expect(steps.indexOf(captureExpiredPresenceAt!)).toBeLessThan(
            steps.indexOf(steps.find(step =>
                step.name === 'connectReusedSessionGenerationOne'
            )!),
        );
        const backgroundExpiry = steps.find(step =>
            step.name === 'waitForBackgroundExpiryReconciliation'
        );
        expect(backgroundExpiry).toMatchObject({
            type: 'set',
            request: { delayMs: expect.any(Number) },
        });
        expect(Number((backgroundExpiry?.request as { delayMs?: number })?.delayMs))
            .toBeGreaterThan(60_000);
        expect(allSteps.indexOf(reconnect!)).toBeLessThan(allSteps.indexOf(backgroundExpiry!));

        const pollDelays = steps.filter(step =>
            String(step.name).startsWith('delayBeforeStateConvergencePoll')
        );
        expect(pollDelays.map(step =>
            Number((step.request as { delayMs?: number })?.delayMs)
        )).toEqual([250, 500, 1000, 2000, 4000]);
        const polls = steps.filter(step =>
            String(step.name).startsWith('pollStateConvergenceAttempt')
        );
        expect(polls).toHaveLength(5);
        polls.forEach(step => expect(step).toMatchObject({
            type: 'parallel',
            maxConcurrency: 2,
            nonBlockingFailure: true,
        }));
        polls.forEach(step => {
            const pollConnections = new Set(
                flattenRecipeSteps([step])
                    .map(candidate => candidate.connection)
                    .filter(Boolean),
            );
            expect(pollConnections).toEqual(
                new Set(['apiPrimary', 'apiSecondary', 'apiTertiary']),
            );
        });
        for (const server of ['Primary', 'Secondary', 'Tertiary']) {
            expect(allSteps.find(step =>
                step.name === `read${server}DurableConfig`
            )).toMatchObject({
                type: 'http',
                connection: `api${server}`,
                request: {
                    method: 'GET',
                    path: expect.stringContaining('/topology/config'),
                },
                expect: {
                    body: {
                        durable: {
                            version:
                                '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
                            requestId: 'put-final-config-{groupId}-{runId}',
                        },
                    },
                },
            });
        }

        const finalAssertion = steps.find(step =>
            step.name === 'assertIdenticalFinalStateAndCausalHistory'
        );
        expect(finalAssertion).toMatchObject({
            type: 'assert',
            actual: {
                primary: expect.any(Object),
                secondary: expect.any(Object),
                tertiary: expect.any(Object),
                causalHistory: expect.any(Object),
            },
            expect: {
                body: expect.any(Object),
                monotonicPaths: expect.any(Array),
                missingActualValue: 'MISSING',
            },
        });
        expect(finalAssertion?.expect).toMatchObject({
            body: {
                primary: {
                    groupStateCausalRevision: {
                        presenceRevision: 'integer',
                    },
                    generationId: 'generation-2-{runId}',
                    postExpiryGenerationId: 'generation-2-{runId}',
                    sourceGroupStateCausalRevision:
                        '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
                    durableConfigVersion:
                        '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
                },
                secondary: {
                    sourceGroupStateCausalRevision:
                        '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
                    durableConfigVersion:
                        '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
                },
                tertiary: {
                    sourceGroupStateCausalRevision:
                        '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
                    durableConfigVersion:
                        '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
                },
                causalHistory: {
                    primary: {
                        topologyPresence: expect.any(Array),
                        topologyTuples: expect.any(Array),
                    },
                    secondary: {
                        topologyPresence: expect.any(Array),
                        topologyTuples: [
                            '{resultsByName.readPrimaryTopologyAttempt1.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
                            '{resultsByName.readPrimaryTopologyAttempt2.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
                            '{resultsByName.readPrimaryTopologyAttempt3.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
                            '{resultsByName.readPrimaryTopologyAttempt4.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
                            '{resultsByName.readPrimaryTopologyAttempt5.0.actual.body.snapshot.sourceGroupStateCausalRevision}',
                        ],
                    },
                    tertiary: {
                        topologyPresence: expect.any(Array),
                        topologyTuples: expect.any(Array),
                    },
                },
            },
        });
        expect((finalAssertion?.expect as { monotonicPaths?: unknown }).monotonicPaths)
            .toEqual(expect.arrayContaining([
                'causalHistory.primary.topologyPresence',
                'causalHistory.secondary.topologyPresence',
                'causalHistory.tertiary.topologyPresence',
            ]));
        for (const field of [
            '/members/', '/sessions/', '/topology/config',
            'groupStateCausalRevision', 'members', 'generationId',
            'postExpiryGenerationId', 'durableConfigVersion', 'config',
            'sourceGroupStateCausalRevision', 'topologyTuples',
        ]) expect(recipeText + JSON.stringify(finalAssertion)).toContain(field);
        expect(JSON.stringify(finalAssertion)).not.toContain('outboxIds');
    });

    it('uses the secondary auth boundary and tertiary fanout and catch-up for CRDT', () => {
        const recipe = readRecipe('tests/api-v1/api-v1-crdt-app-inbox.json');
        const steps = recipe.steps as Array<Record<string, unknown>>;

        expect(steps.find(step => step.name === 'loginCrdtReader')).toMatchObject({
            connection: 'apiSecondary',
        });
        expect(steps.find(step =>
            step.name === 'appendCrdtUpdateThroughPrimary'
        )).toMatchObject({ connection: 'wsPrimary' });
        expect(steps.find(step =>
            step.name === 'observeDurableFanoutOnTertiary'
        )).toMatchObject({ connection: 'wsTertiary' });
        expect(steps.find(step =>
            step.name === 'readCommittedCrdtThroughTertiary'
        )).toMatchObject({ connection: 'apiTertiary' });
    });

    it('defines the isolated 100-client five-group medium-scale state churn gate', () => {
        const { entries } = readMatrix();
        const entry = entries.find(candidate =>
            candidate.id === 'api-v1-state-medium-scale-churn'
        );

        expect(entry).toMatchObject({
            id: 'api-v1-state-medium-scale-churn',
            category: 'api-v1-black-box',
            mode: 'run',
            profiles: ['api-v1-black-box-medium-scale'],
            expectedExitCode: 0,
        });
        expect(entry?.requires?.httpServices).toHaveLength(3);
        expect(entry?.requires?.playwright).not.toBe(true);

        const recipe = readRecipe(entry!.recipe);
        const steps = recipe.steps as Array<Record<string, unknown>>;
        const generationStart = steps.find(step =>
            step.name === 'captureClientGenerationStartedAt'
        );
        expect(generationStart).toMatchObject({
            type: 'set',
            output: 'clientGenerationStartedAtEpochMs',
            transform: { timestamp: true },
        });
        const parallel = steps.find(step => step.name === 'runMediumScaleStateChurn') as {
            type?: string;
            maxConcurrency?: number;
            timeoutMs?: number;
            groups?: Array<{ name?: string; steps?: Array<Record<string, unknown>> }>;
        };
        expect(parallel.type).toBe('parallel');
        expect(parallel.maxConcurrency).toBe(15);
        expect(parallel.timeoutMs).toBe(300_000);
        expect(parallel.groups).toHaveLength(15);
        expect(Object.values(recipe.connections as Record<string, { timeoutMs?: number }>)
            .map(connection => connection.timeoutMs)).toEqual([15_000, 15_000, 15_000]);

        const clientGroups = parallel.groups!.filter(group =>
            group.name?.startsWith('client-lane-')
        );
        expect(clientGroups).toHaveLength(10);
        const clientLoops = clientGroups.map(group => group.steps?.find(step => step.type === 'loop'));
        expect(clientLoops.map(loop => loop?.count)).toEqual(Array(10).fill(10));
        expect(clientLoops.reduce((total, loop) => total + Number(loop?.count), 0)).toBe(100);
        const apiConnections = ['apiPrimary', 'apiSecondary', 'apiTertiary'];
        clientLoops.forEach((loop, laneIndex) => {
            const lane = laneIndex + 1;
            const flow = flattenRecipeSteps([loop!]);
            const writer = apiConnections[laneIndex % apiConnections.length];
            const verifier = apiConnections[(laneIndex + 1) % apiConnections.length];
            expect(flow.find(step =>
                step.name === `registerLane${lane}Client{loop.iteration}`
            )).toMatchObject({ connection: writer });
            expect(flow.find(step =>
                step.name === `heartbeatLane${lane}ClientSession{loop.iteration}`
            )).toMatchObject({ connection: verifier });
            expect(flow.find(step =>
                step.name === `disconnectLane${lane}ClientSession{loop.iteration}`
            )).toMatchObject({ connection: verifier });
        });

        const controlGroups = parallel.groups!.filter(group =>
            group.name?.startsWith('group-control-lane-')
        );
        expect(controlGroups).toHaveLength(5);
        expect(controlGroups.map(group => group.steps?.find(step => step.type === 'loop')?.count))
            .toEqual(Array(5).fill(10));
        controlGroups.forEach((group, index) => {
            const label = ['one', 'two', 'three', 'four', 'five'][index]!;
            const loop = group.steps?.find(step => step.type === 'loop');
            const operations = loop?.steps as Array<Record<string, unknown>>;
            expect(operations.map(operation => operation.connection)).toEqual([
                apiConnections[index % apiConnections.length],
                apiConnections[(index + 1) % apiConnections.length],
                apiConnections[(index + 2) % apiConnections.length],
                apiConnections[index % apiConnections.length],
            ]);
            for (const operationName of [
                `put${label}TopologyConfig{loop.iteration}`,
                `delete${label}TopologyConfig{loop.iteration}`,
                `putFinal${label}TopologyConfig{loop.iteration}`,
            ]) {
                const operation = operations.find(step => step.name === operationName);
                expect(operation?.expect).toMatchObject({
                    status: 200,
                    body: {
                        receipt: {
                            acceptedVersion: 'integer',
                            outboxIds: ['string'],
                        },
                    },
                });
            }
        });

        const recipeText = JSON.stringify(recipe);
        const groupIds = ['groupOneId', 'groupTwoId', 'groupThreeId', 'groupFourId', 'groupFiveId'];
        groupIds.forEach(groupId => {
            expect(recipeText).toContain(`{${groupId}}/members/`);
            expect(recipeText).toContain(`{${groupId}}/sessions/`);
            expect(recipeText).toContain(`{${groupId}}/topology/config`);
            expect(recipeText).toContain(`{${groupId}}/topology/reconfigure`);
            expect(recipeText).toContain(`groups/{${groupId}}`);
            const causalPrefix = `final${groupId[0].toUpperCase()}${groupId.slice(1)}`;
            expect(recipeText).toContain(`${causalPrefix}StateCausalRevision`);
            expect(recipeText).toContain(`${causalPrefix}PresenceCausalRevision`);
        });

        clientLoops.forEach(loop => {
            const flow = JSON.stringify(loop);
            expect(flow).toContain('/api/auth/register');
            expect(flow).toContain('/api/auth/login');
            expect(flow).toContain('/principal');
            expect(flow).toContain('/instances/');
            expect(flow).toContain('/sessions/');
            expect(flow).toContain('/heartbeat');
            expect(flow).toContain('/disconnect');
            expect(flow).toContain('x-forwarded-for');
            expect(flow).toMatch(/10\.\d+\.\{loop\.iteration\}\.1/);
        });

        clientLoops.forEach((loop, laneIndex) => {
            const lane = laneIndex + 1;
            const flow = flattenRecipeSteps([loop!]);
            const clientSessionSteps = flow.filter(step => {
                const request = step.request as { path?: string } | undefined;
                return request?.path?.includes(`/clients/{lane${lane}ClientId}/`) === true &&
                    request.path.includes('/sessions/');
            });
            const generationFor = (namePrefix: string) =>
                (clientSessionSteps.find(step => String(step.name).startsWith(namePrefix))
                    ?.request as { body?: { generationId?: string } } | undefined)
                    ?.body?.generationId;
            const connectedAtFor = (namePrefix: string) =>
                (clientSessionSteps.find(step => String(step.name).startsWith(namePrefix))
                    ?.request as { body?: { connectedAtEpochMs?: number } } | undefined)
                    ?.body?.connectedAtEpochMs;
            expect(generationFor(`connectLane${lane}ClientSession`))
                .toBe(`lane-${lane}-generation-1-{loop.iteration}-{runId}`);
            expect(connectedAtFor(`connectLane${lane}ClientSession`))
                .toBe('{clientGenerationStartedAtEpochMs}');
            expect(generationFor(`heartbeatLane${lane}ClientSession`))
                .toBe(`lane-${lane}-generation-1-{loop.iteration}-{runId}`);
            expect(generationFor(`disconnectLane${lane}ClientSession`))
                .toBe(`lane-${lane}-generation-1-{loop.iteration}-{runId}`);
            expect(generationFor(`reconnectLane${lane}ClientSession`))
                .toBe(`lane-${lane}-generation-2-{loop.iteration}-{runId}`);
            expect(connectedAtFor(`reconnectLane${lane}ClientSession`))
                .toBe('{clientGenerationStartedAtEpochMs}');
            const groupSessionSteps = flow.filter(step => {
                const request = step.request as { path?: string } | undefined;
                return request?.path?.includes('/groups/') === true &&
                    request.path.includes('/sessions/');
            });
            for (const step of groupSessionSteps) {
                const generationId = (step.request as {
                    body?: { generationId?: string };
                }).body?.generationId;
                if (String(step.name).startsWith(`reconnectLane${lane}ToRotatedGroup`)) {
                    expect(generationId)
                        .toBe(`lane-${lane}-generation-3-{loop.iteration}-{runId}`);
                } else {
                    expect(generationId)
                        .toBe(`lane-${lane}-generation-2-{loop.iteration}-{runId}`);
                }
            }
        });

        const churnIndex = steps.findIndex(step => step.name === 'runMediumScaleStateChurn');
        const afterChurn = steps.slice(churnIndex + 1);
        const pollDelays = afterChurn.filter(step =>
            String(step.name).startsWith('delayBeforeConvergencePoll')
        );
        expect(pollDelays.map(step => Number((step.request as { delayMs?: number })?.delayMs)))
            .toEqual([500, 1000, 2000, 4000, 8000]);
        const totalPollDelayMs = pollDelays.reduce((total, step) =>
            total + Number((step.request as { delayMs?: number })?.delayMs), 0
        );
        expect(totalPollDelayMs).toBeLessThanOrEqual(30_000);

        const pollSteps = afterChurn.filter(step =>
            String(step.name).startsWith('pollConvergenceAttempt')
        );
        expect(pollSteps).toHaveLength(5);
        pollSteps.forEach(step => {
            expect(step.type).toBe('parallel');
            expect(step.maxConcurrency).toBe(15);
            expect(step.nonBlockingFailure).toBe(true);
            expect((step.groups as unknown[])).toHaveLength(15);
            const clientReads = (step.groups as Array<{
                name: string;
                steps: Array<Record<string, unknown>>;
            }>).filter(group => group.name.startsWith('last-client-lane-'));
            expect(clientReads).toHaveLength(10);
            clientReads.forEach(group => {
                const request = group.steps[0]?.request as Record<string, unknown>;
                expect(request.method).toBe('GET');
                expect(String(request.path)).toMatch(/\/clients\/\{lane\d+ClientId\}\/presence$/);
                expect(request).not.toHaveProperty('body');
            });
        });

        const firstPollGroups = pollSteps[0].groups as Array<{
            name: string;
            steps: Array<Record<string, unknown>>;
        }>;
        expect(firstPollGroups.filter(group => group.name.startsWith('last-client-lane-')))
            .toHaveLength(10);
        expect(firstPollGroups.filter(group => group.name.startsWith('cluster-group-')))
            .toHaveLength(5);
        for (let lane = 1; lane <= 10; lane += 1) {
            const read = firstPollGroups.find(group => group.name === `last-client-lane-${lane}`)
                ?.steps[0];
            expect(read?.connection).toBe(apiConnections[lane % apiConnections.length]);
            expect(String((read?.request as { path?: string })?.path)).toContain(
                `/clients/{lane${lane}ClientId}/presence`,
            );
            expect(read?.expect).toMatchObject({
                body: {
                    principalId: `{lane${lane}ClientId}`,
                    isOnline: true,
                    activeSessions: [{
                        generationId: `lane-${lane}-generation-2-10-{runId}`,
                    }],
                },
            });
        }

        groupIds.forEach(groupId => {
            const groupLabel = groupId.replace(/^group/, '').replace(/Id$/, '').toLowerCase();
            const groupIndex = groupIds.indexOf(groupId);
            const pollingConnection = apiConnections[groupIndex % apiConnections.length];
            const verificationConnection = apiConnections[(groupIndex + 1) % apiConnections.length];
            const reconfigureConnection = apiConnections[(groupIndex + 2) % apiConnections.length];
            const polling = firstPollGroups.find(group =>
                group.name === `cluster-group-${groupLabel}`
            )?.steps[0];
            expect(polling?.connection).toBe(pollingConnection);
            expect(polling?.request).toMatchObject({
                outputs: {
                    [`final${groupId[0].toUpperCase()}${groupId.slice(1)}StateCausalRevision`]:
                        'body.causalRevision.groupRevision',
                    [`final${groupId[0].toUpperCase()}${groupId.slice(1)}PresenceCausalRevision`]:
                        'body.causalRevision.presenceRevision',
                },
            });

            const verification = afterChurn.find(step =>
                step.name === `verify${groupLabel}GroupAcrossCluster`
            );
            expect(verification).toMatchObject({ connection: verificationConnection });
            expect(verification?.expect).toMatchObject({
                body: {
                    causalRevision: {
                        groupRevision:
                            `{final${groupId[0].toUpperCase()}${groupId.slice(1)}StateCausalRevision}`,
                        presenceRevision:
                            `{final${groupId[0].toUpperCase()}${groupId.slice(1)}PresenceCausalRevision}`,
                    },
                },
            });

            const finalTopology = afterChurn.find(step =>
                step.name === `finalReconfigure${groupLabel}Topology`
            );
            expect(finalTopology).toMatchObject({ connection: reconfigureConnection });
            expect(finalTopology?.expect).toMatchObject({
                body: {
                    status: 'queued',
                    groupRef: {
                        applicationId: '{applicationId}',
                        workspaceId: '{workspaceId}',
                        groupId: `{${groupId}}`,
                    },
                    requestId: `final-reconfigure-{${groupId}}-{runId}`,
                    outboxId: 'string',
                },
            });
            expect((finalTopology?.request as { outputs?: Record<string, unknown> })?.outputs)
                .toBeUndefined();

            const controlLoop = controlGroups.find(group =>
                group.name === `group-control-lane-${groupIds.indexOf(groupId) + 1}`
            )?.steps?.find(step => step.type === 'loop');
            const finalConfig = (controlLoop?.steps as Array<Record<string, unknown>> | undefined)
                ?.find(step => step.name === `putFinal${groupLabel}TopologyConfig{loop.iteration}`);
            expect((finalConfig?.request as { outputs?: Record<string, unknown> })?.outputs)
                .toMatchObject({
                    [`final${groupId[0].toUpperCase()}${groupId.slice(1)}ConfigVersion`]:
                        'body.config.version',
                    [`final${groupId[0].toUpperCase()}${groupId.slice(1)}TopologyOutboxIds`]:
                        'body.receipt.outboxIds',
                });
        });

        const topologyPoll = afterChurn.find(step => step.name === 'pollFinalTopologyEffects');
        expect(topologyPoll).toMatchObject({ type: 'loop', count: 5, intervalMs: 5_000 });
        const topologyPollSteps = topologyPoll?.steps as Array<Record<string, unknown>>;
        expect(topologyPollSteps).toHaveLength(5);
        groupIds.forEach(groupId => {
            const groupLabel = groupId.replace(/^group/, '').replace(/Id$/, '').toLowerCase();
            const read = topologyPollSteps.find(step =>
                step.name === `observe${groupLabel}PublishedTopologyEffect{loop.iteration}`
            );
            expect(read).toMatchObject({
                type: 'http',
                nonBlockingFailure: true,
                expect: {
                    body: {
                        snapshot: {
                            version: 'integer',
                            sourceGroupStateCausalRevision: {
                                groupRevision:
                                    `{final${groupId[0].toUpperCase()}${groupId.slice(1)}StateCausalRevision}`,
                                presenceRevision:
                                    `{final${groupId[0].toUpperCase()}${groupId.slice(1)}PresenceCausalRevision}`,
                            },
                        },
                    },
                },
            });
        });
        expect(afterChurn.find(step => step.name === 'assertFinalTopologyEffectsConverged'))
            .toMatchObject({
                type: 'assert',
                expect: {
                    body: {
                        statuses: {
                            one: 'SUCCESS',
                            two: 'SUCCESS',
                            three: 'SUCCESS',
                            four: 'SUCCESS',
                            five: 'SUCCESS',
                        },
                    },
                },
            });

        expect(recipeText).not.toContain('body.groupStateCausalRevision');
        expect(recipeText).not.toContain('body.groupPresenceCausalRevision');
        expect(recipeText).not.toContain('body.receipt.outboxId"');

        const receipts = afterChurn.find(step =>
            step.name === 'assertFinalBoundedConvergenceAndCausalHistory'
        );
        expect(receipts).toMatchObject({
            type: 'assert',
            actual: expect.any(Object),
            expect: { body: expect.any(Object) },
        });
        expect((receipts?.actual as Record<string, unknown>).causalHistory)
            .toEqual(expect.any(Object));
        expect((receipts?.expect as { missingActualValue?: unknown }).missingActualValue)
            .toBe('MISSING');
        expect((receipts?.expect as { monotonicPaths?: unknown }).monotonicPaths)
            .toEqual(expect.any(Array));

        groupIds.forEach(groupId => {
            const groupLabel = groupId.replace(/^group/, '').replace(/Id$/, '').toLowerCase();
            const groupIndex = groupIds.indexOf(groupId);
            const finalTopology = afterChurn.find(step =>
                step.name === `finalReconfigure${groupLabel}Topology`
            );
            expect((finalTopology?.request as { body?: Record<string, unknown> })?.body?.publish).toBe(true);

            const observedEffect = topologyPollSteps.find(step =>
                step.name === `observe${groupLabel}PublishedTopologyEffect{loop.iteration}`
            );
            expect(observedEffect).toMatchObject({
                type: 'http',
                connection: apiConnections[groupIndex % apiConnections.length],
                request: {
                    method: 'GET',
                    path: expect.stringContaining('/topology'),
                },
            });
            expect((observedEffect?.request as { outputs?: Record<string, unknown> })?.outputs)
                .toHaveProperty(`observedGroup${groupId.slice(5, -2)}IdTopologySnapshotVersion`);
        });

        const receiptEffects = afterChurn.find(step =>
            step.name === 'assertPublishedTopologyEffectsMatchReceipts'
        );
        expect(receiptEffects).toMatchObject({
            type: 'assert',
            actual: { receipts: expect.any(Object), observedEffects: expect.any(Object) },
            expect: { body: expect.any(Object) },
        });
        expect(receiptEffects?.actual).toMatchObject({
            receipts: {
                groupOneId: '{finalGroupOneIdTopologyOutboxIds}',
                groupTwoId: '{finalGroupTwoIdTopologyOutboxIds}',
                groupThreeId: '{finalGroupThreeIdTopologyOutboxIds}',
                groupFourId: '{finalGroupFourIdTopologyOutboxIds}',
                groupFiveId: '{finalGroupFiveIdTopologyOutboxIds}',
            },
        });
        expect(receiptEffects?.expect).toMatchObject({
            body: {
                receipts: {
                    groupOneId: ['string'],
                    groupTwoId: ['string'],
                    groupThreeId: ['string'],
                    groupFourId: ['string'],
                    groupFiveId: ['string'],
                },
            },
        });
    });

    it('advertises the API-v1 profile in recipe-matrix CLI usage', () => {
        const source = readFileSync(path.join(runnerRoot, 'recipe-matrix.mts'), 'utf8');

        expect(source).toContain('api-v1-black-box');
    });
});
