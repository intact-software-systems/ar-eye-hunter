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

    it('defines a no-browser two-server topology convergence recipe', () => {
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
        )).toHaveLength(2);
        expect(Object.values(connections).filter(connection =>
            connection.type === 'ws'
        )).toHaveLength(2);
        expect(Object.values(connections).some(connection =>
            connection.type === 'rtc'
        )).toBe(false);
        expect(JSON.stringify(recipe)).not.toContain('rallar-browser');
        expect(JSON.stringify(recipe)).not.toContain('RTCPeerConnection');
        expect((recipe.steps as Array<{ type?: string }>).some(step =>
            step.type === 'parallel'
        )).toBe(true);
    });

    it('defines bounded two-server multi-client and multi-group churn coverage', () => {
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
        expect(parallel.groups).toHaveLength(2);
        expect(parallel.groups?.map(group => {
            const loop = group.steps?.find(step => step.type === 'loop');
            return loop?.count;
        })).toEqual([6, 6]);
        expect(JSON.stringify(recipe)).toContain('disconnect');
        expect(JSON.stringify(recipe)).toContain('topology/reconfigure');
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
        expect(entry?.requires?.httpServices).toHaveLength(2);
        expect(entry?.requires?.playwright).not.toBe(true);

        const recipe = readRecipe(entry!.recipe);
        const steps = recipe.steps as Array<Record<string, unknown>>;
        const parallel = steps.find(step => step.name === 'runMediumScaleStateChurn') as {
            type?: string;
            maxConcurrency?: number;
            groups?: Array<{ name?: string; steps?: Array<Record<string, unknown>> }>;
        };
        expect(parallel.type).toBe('parallel');
        expect(parallel.maxConcurrency).toBe(15);
        expect(parallel.groups).toHaveLength(15);

        const clientGroups = parallel.groups!.filter(group =>
            group.name?.startsWith('client-lane-')
        );
        expect(clientGroups).toHaveLength(10);
        const clientLoops = clientGroups.map(group => group.steps?.find(step => step.type === 'loop'));
        expect(clientLoops.map(loop => loop?.count)).toEqual(Array(10).fill(10));
        expect(clientLoops.reduce((total, loop) => total + Number(loop?.count), 0)).toBe(100);

        const controlGroups = parallel.groups!.filter(group =>
            group.name?.startsWith('group-control-lane-')
        );
        expect(controlGroups).toHaveLength(5);
        expect(controlGroups.map(group => group.steps?.find(step => step.type === 'loop')?.count))
            .toEqual(Array(5).fill(10));

        const recipeText = JSON.stringify(recipe);
        const groupIds = ['groupOneId', 'groupTwoId', 'groupThreeId', 'groupFourId', 'groupFiveId'];
        groupIds.forEach(groupId => {
            expect(recipeText).toContain(`{${groupId}}/members/`);
            expect(recipeText).toContain(`{${groupId}}/sessions/`);
            expect(recipeText).toContain(`{${groupId}}/topology/config`);
            expect(recipeText).toContain(`{${groupId}}/topology/reconfigure`);
            expect(recipeText).toContain(`groups/{${groupId}}`);
            expect(recipeText).toContain(`final${groupId[0].toUpperCase()}${groupId.slice(1)}CausalRevision`);
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
    });

    it('advertises the API-v1 profile in recipe-matrix CLI usage', () => {
        const source = readFileSync(path.join(runnerRoot, 'recipe-matrix.mts'), 'utf8');

        expect(source).toContain('api-v1-black-box');
    });
});
