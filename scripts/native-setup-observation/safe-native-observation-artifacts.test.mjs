import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeSafeNativeObservationArtifacts } from './write-safe-native-observation-artifacts.mjs';

const CHILD_CASE =
    'fourteen automatic receiver ACKs cross native API sockets and complete the exact origin receipt after release';
const CUSTODY = {
    baseCommit: '1f3dc1d962d8000506023bb6606bfc27e2ee5424',
    headCommit: 'a'.repeat(40),
    nodeVersion: 'v24.0.0',
    denoVersion: '2.9.7',
    runnerOS: 'Linux',
    runnerImage: 'ubuntu24',
    runnerImageVersion: '20261014.1.0',
    sourceHashes: [{ path: 'apps/api-v1/test/db/native-session-test-fixture.ts', sha256: 'b'.repeat(64) }]
};
const LIMITS = { maxInputBytes: 1_000_000, maxLineBytes: 16_384, maxObservations: 100, maxCountReports: 20 };

function completionPoll(overrides = {}) {
    return {
        type: 'rallar.timing',
        component: 'app-inbox-phase',
        operation: 'wait-poll',
        status: 'ok',
        atEpochMs: 1_791_943_548_153,
        durationMs: 0,
        requestId: 'native-room-presence-12',
        details: {
            type: 'GROUP_PRESENCE_CONNECT',
            topicId: 'GROUP_PRESENCE_CONNECT',
            contextId: 'native-context',
            resourceId: 'native-room-presence-12',
            queueObservation: 'COMPLETED',
            attempts: 1
        },
        ...overrides
    };
}

async function createArtifactFixture(context) {
    const directory = await mkdtemp(join(tmpdir(), 'native-phase-artifact-test-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const rawDirectory = join(directory, 'raw');
    const safeDirectory = join(directory, 'safe');
    await mkdir(rawDirectory);
    await writeFile(join(rawDirectory, 'exit-code'), '1\n');
    return { rawDirectory, safeDirectory, custody: CUSTODY, limits: LIMITS };
}

async function readArtifacts(fixture) {
    const summary = JSON.parse(await readFile(join(fixture.safeDirectory, 'summary.json'), 'utf8'));
    const lines = (await readFile(join(fixture.safeDirectory, 'observations.jsonl'), 'utf8')).trim();
    return { summary, observations: lines ? lines.split('\n').map((line) => JSON.parse(line)) : [] };
}

test('preserves actual selected poll and fetch observations with original failure/count evidence', async (context) => {
    const fixture = await createArtifactFixture(context);
    const fetchReturn = {
        type: 'native.http.phase',
        stage: 'fetch-return',
        requestId: 'native-room-presence-12',
        processId: 4242,
        atEpochMs: 1_791_943_548_154,
        monotonicMs: 5100.5,
        elapsedMs: 4702.1,
        status: 200
    };
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${CHILD_CASE} ...`,
            JSON.stringify(completionPoll()),
            JSON.stringify(fetchReturn),
            `${CHILD_CASE} ... FAILED (22s)`,
            'FAILED | 657 passed | 1 failed (6m2s)'
        ].join('\n')
    );
    await writeFile(join(fixture.rawDirectory, 'stderr.log'), 'unselected private failure details\n');
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(summary.originalExitCode, 1);
    assert.deepEqual(summary.testCounts.map(({ passed, failed }) => ({ passed, failed })), [{
        passed: 657,
        failed: 1
    }]);
    assert.equal(summary.nativeCases.find((value) => value.id === 'receiver-receipts-child')?.outcome, 'failed');
    assert.equal(observations.length, 2);
    assert.equal(observations[0].caseId, 'receiver-receipts-child');
    assert.equal(observations[0].details.queueObservation, 'COMPLETED');
    assert.equal(observations[0].details.attempts, 1);
    assert.equal(observations[1].stage, 'fetch-return');
    assert.equal(observations[1].processId, 4242);
    assert.equal(observations[1].elapsedMs, 4702.1);
    assert.deepEqual((await readdir(fixture.safeDirectory)).sort(), ['observations.jsonl', 'summary.json']);
});

test('rejects unsafe event fields and never exports raw payload, credentials or error text', async (context) => {
    const fixture = await createArtifactFixture(context);
    const dangerous = completionPoll({ payload: 'PRIVATE_PAYLOAD_MARKER', authorization: 'PRIVATE_CREDENTIAL_MARKER' });
    const safeFailure = completionPoll({
        status: 'error',
        error: { message: 'PRIVATE_ERROR_MARKER', stack: 'PRIVATE_STACK_MARKER' }
    });
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${CHILD_CASE} ...`,
            JSON.stringify(dangerous),
            JSON.stringify(safeFailure),
            'PRIVATE_RAW_MARKER',
            JSON.stringify({ sessionTicket: 'PRIVATE_TICKET_MARKER' })
        ].join('\n')
    );
    await writeFile(join(fixture.rawDirectory, 'stderr.log'), 'PRIVATE_STDERR_MARKER');
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(summary.coverage.rejectedEvents, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 'error');
    const exported = await readFile(join(fixture.safeDirectory, 'summary.json'), 'utf8') +
        await readFile(join(fixture.safeDirectory, 'observations.jsonl'), 'utf8');
    assert.equal(exported.includes('PRIVATE_'), false);
    assert.equal(exported.includes('authorization'), false);
    assert.equal(exported.includes('stack'), false);
});

test('refuses malformed numeric values while retaining valid selected evidence', async (context) => {
    const fixture = await createArtifactFixture(context);
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${CHILD_CASE} ...`,
            JSON.stringify(completionPoll({ durationMs: -1 })),
            JSON.stringify(completionPoll({ atEpochMs: 'PRIVATE_CLOCK_MARKER' })),
            JSON.stringify(completionPoll()).replace('"durationMs":0', '"durationMs":1e999'),
            '{"type":"rallar.timing", malformed',
            JSON.stringify(completionPoll())
        ].join('\n')
    );
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(summary.coverage.rejectedEvents, 3);
    assert.equal(summary.coverage.malformedJsonLines, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].durationMs, 0);
});

test('labels missing streams, absent case outcomes and invalid exit evidence without inventing success', async (context) => {
    const fixture = await createArtifactFixture(context);
    await writeFile(join(fixture.rawDirectory, 'exit-code'), 'not-an-exit\n');
    await writeFile(join(fixture.rawDirectory, 'stdout.log'), `${CHILD_CASE} ...\n${JSON.stringify(completionPoll())}`);
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary } = await readArtifacts(fixture);
    assert.equal(summary.originalExitCode, null);
    assert.equal(summary.coverage.invalidExitEvidence, true);
    assert.deepEqual(summary.coverage.missingStreams, ['stderr']);
    assert.equal(summary.nativeCases.find((value) => value.id === 'receiver-receipts-child')?.outcome, 'missing');
    assert.deepEqual(summary.testCounts, []);
});

test('bounds oversized raw lines and observation output with explicit loss evidence', async (context) => {
    const fixture = await createArtifactFixture(context);
    fixture.limits = { ...LIMITS, maxLineBytes: 1024, maxObservations: 2 };
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${CHILD_CASE} ...`,
            'PRIVATE_LONG_MARKER'.repeat(200),
            ...Array.from({ length: 5 }, () => JSON.stringify(completionPoll()))
        ].join('\n')
    );
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(observations.length, 2);
    assert.equal(summary.coverage.oversizedLines, 1);
    assert.equal(summary.coverage.observationOverflow, 3);
    assert.equal(JSON.stringify({ summary, observations }).includes('PRIVATE_LONG_MARKER'), false);
});

test('keeps shared native request labels separated by their actual child case boundaries', async (context) => {
    const fixture = await createArtifactFixture(context);
    const native15 =
        'fifteen native same-user sessions complete concurrent room setup through default automatic queues';
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${native15} ...`,
            JSON.stringify(completionPoll()),
            `${native15} ... ok (22s)`,
            `${CHILD_CASE} ...`,
            JSON.stringify(completionPoll()),
            `${CHILD_CASE} ... FAILED (22s)`
        ].join('\n')
    );
    await writeSafeNativeObservationArtifacts(fixture);
    const { observations } = await readArtifacts(fixture);
    assert.deepEqual(observations.map((value) => value.caseId), ['native15-child', 'receiver-receipts-child']);
});

test('retains complete evidence before the input byte cap and labels the truncated stream', async (context) => {
    const fixture = await createArtifactFixture(context);
    const prefix = `${CHILD_CASE} ...\n${JSON.stringify(completionPoll())}\n`;
    fixture.limits = { ...LIMITS, maxInputBytes: Buffer.byteLength(prefix) };
    await writeFile(join(fixture.rawDirectory, 'stdout.log'), `${prefix}PRIVATE_AFTER_INPUT_CAP`);
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(observations.length, 1);
    assert.deepEqual(summary.coverage.inputOverflowStreams, ['stdout']);
    assert.equal(JSON.stringify({ summary, observations }).includes('PRIVATE_AFTER_INPUT_CAP'), false);
});

test('retains missing-run evidence when a tool version was unavailable before test execution', async (context) => {
    const fixture = await createArtifactFixture(context);
    fixture.custody = { ...CUSTODY, denoVersion: null };
    await rm(join(fixture.rawDirectory, 'exit-code'));
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(summary.custody.denoVersion, null);
    assert.equal(summary.originalExitCode, null);
    assert.deepEqual(summary.coverage.missingStreams, ['stdout', 'stderr']);
    assert.deepEqual(observations, []);
});

test('limits nested count reports without combining child results into the parent total', async (context) => {
    const fixture = await createArtifactFixture(context);
    fixture.limits = { ...LIMITS, maxCountReports: 1 };
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        'ok | 1 passed | 0 failed\nFAILED | 657 passed | 1 failed'
    );
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary } = await readArtifacts(fixture);
    assert.deepEqual(summary.testCounts.map(({ passed, failed }) => ({ passed, failed })), [{ passed: 1, failed: 0 }]);
    assert.equal(summary.coverage.countOverflow, 1);
});

test('preserves the committed-transaction to terminal-poll result chain without exposing canonical opaque keys', async (context) => {
    const fixture = await createArtifactFixture(context);
    const transaction = completionPoll({
        operation: 'transaction',
        durationMs: 18.25,
        atEpochMs: 1_791_943_547_169,
        details: {
            type: 'GROUP_PRESENCE_CONNECT',
            topicId: 'GROUP_PRESENCE_CONNECT',
            contextId: 'PRIVATE_CONTEXT_MARKER',
            resourceId: 'native-room-presence-12',
            senderId: 'PRIVATE_SENDER_MARKER',
            selectedLane: 'NEW',
            queueAgeMs: 17.5,
            dueAgeMs: 17.5,
            attempt: 1
        }
    });
    const result = completionPoll({ operation: 'read-result', atEpochMs: 1_791_943_548_153, durationMs: 0.25 });
    const wait = completionPoll({ operation: 'wait-completion', atEpochMs: 1_791_943_548_153, durationMs: 980 });
    const command = completionPoll({ component: 'app-inbox', operation: 'enqueueAndWaitForResult', durationMs: 1000 });
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${CHILD_CASE} ...`,
            ...[transaction, completionPoll(), wait, result, command].map((event) => JSON.stringify(event))
        ].join('\n')
    );
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.deepEqual(observations.map((event) => event.operation), [
        'transaction',
        'wait-poll',
        'wait-completion',
        'read-result',
        'enqueueAndWaitForResult'
    ]);
    assert.equal(observations[0].atEpochMs, 1_791_943_547_169);
    assert.equal(observations[0].durationMs, 18.25);
    assert.equal(observations[0].details.attempt, 1);
    assert.equal(observations[0].details.selectedLane, 'NEW');
    assert.equal(observations[0].details.resourceId, 'native-room-presence-12');
    assert.match(observations[0].details.contextIdSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify({ summary, observations }).includes('PRIVATE_'), false);
});

test('rejects non-string request identities and preserves later valid records and outcomes', async (context) => {
    const fixture = await createArtifactFixture(context);
    const response = {
        type: 'native.http.phase',
        stage: 'fetch-return',
        requestId: 'native-room-presence-12',
        processId: 4242,
        atEpochMs: 1_791_943_548_154,
        monotonicMs: 5100.5,
        elapsedMs: 4702.1,
        status: 200
    };
    await writeFile(
        join(fixture.rawDirectory, 'stdout.log'),
        [
            `${CHILD_CASE} ...`,
            JSON.stringify({ ...response, requestId: ['native-room-presence-12'] }),
            JSON.stringify({ ...response, requestId: { toString: null } }),
            JSON.stringify(response),
            `${CHILD_CASE} ... FAILED (22s)`,
            'FAILED | 657 passed | 1 failed (6m2s)'
        ].join('\n')
    );
    await writeSafeNativeObservationArtifacts(fixture);
    const { summary, observations } = await readArtifacts(fixture);
    assert.equal(summary.coverage.rejectedEvents, 2);
    assert.deepEqual(summary.coverage.unreadableStreams, []);
    assert.equal(summary.originalExitCode, 1);
    assert.equal(summary.nativeCases.find((value) => value.id === 'receiver-receipts-child')?.outcome, 'failed');
    assert.deepEqual(summary.testCounts.map(({ passed, failed }) => ({ passed, failed })), [{
        passed: 657,
        failed: 1
    }]);
    assert.deepEqual(observations.map(({ requestId, stage }) => ({ requestId, stage })), [
        { requestId: 'native-room-presence-12', stage: 'fetch-return' }
    ]);
});

test('reports simultaneous invalid input fields before creating any artifacts', async (context) => {
    const fixture = await createArtifactFixture(context);
    fixture.limits = { ...LIMITS, maxInputBytes: 0 };
    fixture.custody = { ...CUSTODY, headCommit: 'invalid-head' };
    await assert.rejects(writeSafeNativeObservationArtifacts(fixture), (error) => {
        assert.deepEqual(error.issues?.map((issue) => issue.field) ?? [], [
            'limits.maxInputBytes',
            'custody.headCommit'
        ]);
        return true;
    });
    await assert.rejects(readdir(fixture.safeDirectory), { code: 'ENOENT' });
});
