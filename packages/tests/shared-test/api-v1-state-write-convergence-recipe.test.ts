import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
    mkdtemp,
    rm,
    writeFile
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { parseBlackBoxRunnerReport, type BlackBoxRunnerReport } from '@shared-test/black-box-runner/artifacts/artifact-reader.ts';
import { validateBlackBoxRunnerScenarioRecipe } from '@shared-test/black-box-runner/schema.ts';
import type { GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

const recipePath = 'tests/api-v1/api-v1-state-write-convergence.json';
const scenarioCliPath = fileURLToPath(new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url));
const expectedGenerationId = 'generation-2-presence-regression';

interface PresenceLaneRead {
    readonly recipe: JsonWireObject;
    readonly steps: readonly JsonWireObject[];
    readonly race: JsonWireObject;
    readonly groups: readonly JsonWireObject[];
    readonly presenceSteps: readonly JsonWireObject[];
}

function readPresenceLane(): PresenceLaneRead {
    const recipe = requireRecipeObject(decodeJsonWireValue(readApiV1Recipe(recipePath)), 'recipe');
    assert.equal(validateBlackBoxRunnerScenarioRecipe(recipe).ok, true);
    assert.ok(Array.isArray(recipe.steps));
    const steps = recipe.steps.map((step) => requireRecipeObject(step, 'recipe step'));
    const race = steps.find((step) => step.name === 'raceBoundedMembershipPresenceAndConfig');
    assert.ok(race);
    assert.ok(Array.isArray(race.groups));
    const groups = race.groups.map((group) => requireRecipeObject(group, 'parallel lane'));
    const lane = groups.find((group) => group.name === 'reused-session-presence-lane');
    assert.ok(lane);
    assert.ok(Array.isArray(lane.steps));
    const presenceSteps = lane.steps.map((step) => requireRecipeObject(step, 'presence step'));
    return { recipe, steps, race, groups, presenceSteps };
}

function isRecipeObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecipeObject(value: JsonWireValue | undefined, label: string): JsonWireObject {
    assert.ok(isRecipeObject(value), `${label} must be a JSON object`);
    return value;
}

function toPresenceSummary(presenceRevision: number, session: GroupPresenceSession | null): GroupSnapshot {
    const snapshot = createGroupSnapshot(5, []);
    return {
        ...snapshot,
        group: { ...snapshot.group, presenceVersion: presenceRevision },
        causalRevision: { groupRevision: 5, presenceRevision },
        activeSessions: session ? [session] : [],
        onlineMemberCount: session ? 1 : 0
    };
}

function createPresenceSession(generationId: string, sessionId = 'reused-session'): GroupPresenceSession {
    const generationVersion = generationId === expectedGenerationId ? 2 : 1;
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId: 'alice',
        sessionId,
        generationId,
        generationVersion,
        connectedAtEpochMs: generationVersion,
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

interface ObservedPresenceRequest {
    readonly method: string | undefined;
    readonly url: string | undefined;
}

interface PresenceSummaryServer {
    readonly baseUrl: string;
    readonly requests: readonly ObservedPresenceRequest[];
}

async function startPresenceSummaryServer(summaries: readonly GroupSnapshot[]): Promise<PresenceSummaryServer> {
    assert.ok(summaries.length > 0);
    const requests: ObservedPresenceRequest[] = [];
    let readCount = 0;
    const server = createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        const summary = request.method === 'PUT'
            ? toPresenceSummary(2, null)
            : summaries[Math.min(readCount++, summaries.length - 1)];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(summary));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    onTestFinished(() =>
        new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        })
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

interface PresencePollOverride {
    readonly maxAttempts: number;
    readonly backoffMs: number;
}

interface PresenceLaneRunInputDto {
    readonly baseUrl: string;
    readonly pollOverride: PresencePollOverride | null;
}

interface PresenceLaneRunResult {
    readonly code: number | null;
    readonly report: BlackBoxRunnerReport;
}

async function runPresenceLane(input: PresenceLaneRunInputDto): Promise<PresenceLaneRunResult> {
    const { recipe, presenceSteps } = readPresenceLane();
    const directory = await mkdtemp(path.join(tmpdir(), 'state-write-presence-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const steps = presenceSteps.map((step) => {
        if (step.type !== 'http.poll-until' || !input.pollOverride) {
            return step;
        }
        const request = requireRecipeObject(step.request, 'poll request');
        return {
            ...step,
            request: { ...request, poll: { ...requireRecipeObject(request.poll, 'poll limits'), ...input.pollOverride } }
        };
    });
    const configPath = path.join(directory, 'recipe.json');
    await writeFile(
        configPath,
        JSON.stringify({
            ...recipe,
            variables: {
                runId: 'presence-regression',
                rallarApiBaseUrlTertiary: input.baseUrl,
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'group-1',
                reusedSessionId: 'reused-session',
                ownerClientId: 'alice',
                ownerAuthHeader: 'Bearer fixture-only'
            },
            steps
        })
    );
    const result = await runScenarioCli(configPath);
    const parsed = parseBlackBoxRunnerReport(result.stdout);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    assert.ok(parsed.value);
    return { code: result.code, report: parsed.value };
}

interface ScenarioCliResult {
    readonly code: number | null;
    readonly stdout: string;
}

function runScenarioCli(configPath: string): Promise<ScenarioCliResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('deno', ['run', '-A', scenarioCliPath, '--workingDirectory', path.dirname(configPath), '--config', path.basename(configPath)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15_000
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (signal) {
                reject(new Error(`Scenario CLI terminated with ${signal}: ${stderr}`));
                return;
            }
            if (!stdout.trim()) {
                reject(new Error(`Scenario CLI exited ${code} without a report: ${stderr}`));
                return;
            }
            resolve({ code, stdout });
        });
    });
}

describe('API-v1 state-write convergence recipe', () => {
    it('preserves the concurrent workload and expiry and convergence bounds', () => {
        const { recipe, steps, race, groups, presenceSteps } = readPresenceLane();
        expect(race).toMatchObject({ type: 'parallel', maxConcurrency: 4, timeoutMs: 30_000 });
        expect(groups.map((group) => group.name)).toEqual([
            'primary-membership-contender',
            'secondary-membership-contender',
            'reused-session-presence-lane',
            'topology-config-lane'
        ]);
        const connections = requireRecipeObject(recipe.connections, 'recipe connections');
        expect(Object.values(connections)).toHaveLength(3);
        for (const connection of Object.values(connections)) {
            expect(connection).toMatchObject({ type: 'http', timeoutMs: 15_000 });
        }
        expect(presenceSteps.map((step) => step.name)).toEqual([
            'reconnectReusedSession',
            'pollReusedSessionGenerationTwo'
        ]);
        expect(presenceSteps[0]).toMatchObject({
            type: 'http',
            connection: 'apiTertiary',
            request: { method: 'PUT', body: { generationId: 'generation-2-{runId}', expiresAtEpochMs: Number.MAX_SAFE_INTEGER } },
            expect: { status: 200, body: { causalRevision: { groupRevision: 'integer', presenceRevision: 'integer' } } }
        });
        expect(presenceSteps[1]).toMatchObject({
            type: 'http.poll-until',
            connection: 'apiTertiary',
            request: { poll: { maxAttempts: 10, maxDurationMs: 10_000, backoffMs: 100, backoffMultiplier: 2 } }
        });
        expect(steps.find((step) => step.name === 'waitForBackgroundExpiryReconciliation')).toMatchObject({
            request: { delayMs: 65_000 }
        });
        const delays = steps.filter((step) => String(step.name).startsWith('delayBeforeStateConvergencePoll'));
        expect(delays.map((step) => requireRecipeObject(step.request, 'delay request').delayMs)).toEqual([250, 500, 1000, 2000, 4000]);
        const polls = steps.filter((step) => String(step.name).startsWith('pollStateConvergenceAttempt'));
        expect(polls).toHaveLength(5);
        for (const poll of polls) {
            expect(poll).toMatchObject({ type: 'parallel', maxConcurrency: 2, timeoutMs: 30_000, nonBlockingFailure: true });
        }
    });

    // API-v1 convergence recipe maintainers own these supplementary guards until
    // full-run mutation tests detect removal of each capacity, expiry and causal proof obligation.
    it('keeps the bounded group and exactly one successful capacity contender', () => {
        const { steps } = readPresenceLane();
        expect(steps.find((step) => step.name === 'createBoundedGroup')).toMatchObject({
            request: { body: { maxMembers: 2 } }
        });
        expect(steps.find((step) => step.name === 'assertExactlyOneCapacityWinner')).toMatchObject({
            type: 'assert',
            actual: {
                statuses: [
                    '{resultsByName.activatePrimaryContenderMembership.0.actual.statusCode}',
                    '{resultsByName.activateSecondaryContenderMembership.0.actual.statusCode}'
                ]
            },
            expect: { anyOf: [{ statuses: [200, 403] }, { statuses: [403, 200] }] }
        });
    });

    it('seeds expired sessions before reconnect so background expiry is exercised', () => {
        const { steps, race } = readPresenceLane();
        const capture = steps.find((step) => step.name === 'captureExpiredPresenceAt');
        assert.ok(capture);
        expect(capture).toMatchObject({ type: 'set', output: 'expiredPresenceAtEpochMs', transform: { timestamp: true } });
        for (const name of ['connectReusedSessionGenerationOne', 'connectExpiredPresenceProbe']) {
            const seed = steps.find((step) => step.name === name);
            assert.ok(seed);
            expect(seed).toMatchObject({
                request: {
                    body: {
                        connectedAtEpochMs: '{expiredPresenceAtEpochMs}',
                        lastHeartbeatAtEpochMs: '{expiredPresenceAtEpochMs}',
                        expiresAtEpochMs: '{expiredPresenceAtEpochMs}'
                    }
                }
            });
            expect(steps.indexOf(capture)).toBeLessThan(steps.indexOf(seed));
            expect(steps.indexOf(seed)).toBeLessThan(steps.indexOf(race));
        }
    });

    it('compares three independently read final states and requires monotonic causal histories', () => {
        const { steps } = readPresenceLane();
        const final = steps.find((step) => step.name === 'assertIdenticalFinalStateAndCausalHistory');
        assert.ok(final);
        expect(final.type).toBe('assert');
        const actual = requireRecipeObject(final.actual, 'final actual state');
        const expected = requireRecipeObject(final.expect, 'final expectation');
        const body = requireRecipeObject(expected.body, 'final expected state');
        const history = requireRecipeObject(actual.causalHistory, 'actual causal history');
        const expectedHistory = requireRecipeObject(body.causalHistory, 'expected causal history');
        expect(expected.missingActualValue).toBe('MISSING');
        const historyFields = ['groupState', 'presence', 'topologyGroupState', 'topologyPresence'];
        const servers = [
            { key: 'primary', suffix: 'Primary' },
            { key: 'secondary', suffix: 'Secondary' },
            { key: 'tertiary', suffix: 'Tertiary' }
        ];
        for (const { key, suffix } of servers) {
            expect(actual[key]).toEqual({
                groupStateCausalRevision: `{resultsByName.read${suffix}GroupAttempt5.0.actual.body.causalRevision}`,
                members: `{resultsByName.read${suffix}GroupAttempt5.0.actual.body.members}`,
                generationId: `{resultsByName.read${suffix}GroupAttempt5.0.actual.body.activeSessions.0.generationId}`,
                postExpiryGenerationId: '{resultsByName.readPostExpiryGeneration.0.actual.body.activeSessions.0.generationId}',
                durableConfigVersion: `{resultsByName.read${suffix}DurableConfig.0.actual.body.durable.version}`,
                config: `{resultsByName.read${suffix}DurableConfig.0.actual.body.durable.config}`,
                sourceGroupStateCausalRevision: `{resultsByName.read${suffix}TopologyAttempt5.0.actual.body.snapshot.sourceGroupStateCausalRevision}`
            });
            expect(body[key]).toEqual({
                groupStateCausalRevision: key === 'primary'
                    ? { groupRevision: 'integer', presenceRevision: 'integer' }
                    : '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}',
                members: '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.members}',
                generationId: 'generation-2-{runId}',
                postExpiryGenerationId: 'generation-2-{runId}',
                durableConfigVersion: '{resultsByName.putFinalTopologyConfig.0.actual.body.receipt.acceptedVersion}',
                config: key === 'primary'
                    ? { topologyKind: 'mesh', degreeLimit: 4 }
                    : '{resultsByName.readPrimaryDurableConfig.0.actual.body.durable.config}',
                sourceGroupStateCausalRevision: '{resultsByName.readPrimaryGroupAttempt5.0.actual.body.causalRevision}'
            });
            if (key !== 'primary') {
                const serverExpectedHistory = requireRecipeObject(expectedHistory[key], `${key} expected causal history`);
                expect(serverExpectedHistory.topologyTuples).toEqual(
                    [1, 2, 3, 4, 5].map((attempt) =>
                        `{resultsByName.readPrimaryTopologyAttempt${attempt}.0.actual.body.snapshot.sourceGroupStateCausalRevision}`
                    )
                );
            }
            const serverHistory = requireRecipeObject(history[key], `${key} causal history`);
            for (const field of historyFields) {
                expect(serverHistory[field]).toHaveLength(5);
            }
        }
        expect(expected.monotonicPaths).toEqual(
            servers.flatMap(({ key }) => historyFields.map((field) => `causalHistory.${key}.${field}`))
        );
    });

    it('waits through empty, stale-generation and wrong-session summaries before accepting generation two', async () => {
        const server = await startPresenceSummaryServer([
            toPresenceSummary(3, null),
            toPresenceSummary(4, createPresenceSession('generation-1-presence-regression')),
            toPresenceSummary(5, createPresenceSession(expectedGenerationId, 'different-session')),
            toPresenceSummary(6, createPresenceSession(expectedGenerationId))
        ]);
        const { code, report } = await runPresenceLane({ baseUrl: server.baseUrl, pollOverride: null });
        expect(code).toBe(0);
        expect(report.summary.failure).toBe(0);
        expect(report.resultsList[0]).toMatchObject({ name: 'reconnectReusedSession', status: 'SUCCESS' });
        expect(report.resultsList.find((result) => result.name === 'pollReusedSessionGenerationTwo')).toMatchObject({
            status: 'SUCCESS',
            pollAttempts: 4,
            pollExhausted: false
        });
        expect(report.outputs).toMatchObject({
            reconnectGroupRevision: 5,
            reconnectPresenceRevision: 2,
            acceptedLifecyclePresenceRevision: 6,
            acceptedLifecycleGenerationId: expectedGenerationId
        });
        expect(server.requests.map((request) => request.method)).toEqual(['PUT', 'GET', 'GET', 'GET', 'GET']);
        for (const request of server.requests.slice(1)) {
            expect(request.url).toBe('/api/state/apps/app-1/workspaces/workspace-1/groups/group-1?minGroupRevision=5&minPresenceRevision=2');
        }
    });

    it.each([
        { label: 'missing session', session: null },
        { label: 'stale generation', session: createPresenceSession('generation-1-presence-regression') },
        { label: 'wrong session', session: createPresenceSession(expectedGenerationId, 'different-session') }
    ])('fails within the poll bound for persistent $label even when the causal floor advances', async ({ session }) => {
        const server = await startPresenceSummaryServer([
            toPresenceSummary(3, session),
            toPresenceSummary(4, session),
            toPresenceSummary(5, session)
        ]);
        const { code, report } = await runPresenceLane({
            baseUrl: server.baseUrl,
            pollOverride: { maxAttempts: 3, backoffMs: 0 }
        });
        expect(code).toBe(1);
        expect(report.summary.failure).toBe(1);
        expect(report.resultsList.find((result) => result.name === 'pollReusedSessionGenerationTwo')).toMatchObject({
            status: 'FAILURE',
            pollAttempts: 3,
            pollExhausted: true
        });
        expect(report.outputs).not.toHaveProperty('acceptedLifecyclePresenceRevision');
        expect(report.outputs).not.toHaveProperty('acceptedLifecycleGenerationId');
        expect(server.requests.map((request) => request.method)).toEqual(['PUT', 'GET', 'GET', 'GET']);
    });
});
