import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import {
    readRecorderJsonlRows,
    type RecorderJsonlFailure,
    type RecorderJsonlRead
} from '@shared-test/black-box-runner/artifacts/read-recorder-jsonl-rows.ts';
import { readRtcNativeAcquisition, type RtcNativeCapturedConnection } from '@shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    createCapturedNativeConnectionFixture,
    createCompactedRecipeNativeRecorderFixture,
    createNativeAcquisitionSnapshotFixture,
    createNativeRecorderRowsFixture,
    createRawRecipeNativeRecorderFixture,
    createRecipeNativeConnectionFixture,
    toFixtureJson
} from './rtc-native-acquisition-fixture.ts';

async function* toFixtureBytes(jsonl: string): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(jsonl);
}

describe('complete recorder native admission', () => {
    let recorderJsonl = '';
    beforeEach(() => {
        recorderJsonl = '';
    });

    function readFixtureAcquisition(connection: RtcNativeCapturedConnection) {
        return readRtcNativeAcquisition(connection, 'fixture:recorder', readRecorderJsonlRows(toFixtureBytes(recorderJsonl), 8_388_608));
    }

    it.each(['clean', 'source-error', 'late-disposal', 'late-limit-disposal', 'late-nested-disposal'])(
        'requires actual byte-source EOF before proof: %s',
        async (variant) => {
            const rows = createNativeRecorderRowsFixture();
            const activeCapture: RtcSignalingDiagnostics.CaptureStatus = {
                scopeId: { status: 'observed', value: 'scope-a' },
                scope: 'active',
                ordinaryRowsSuppressed: false,
                admissionLimited: false,
                payloadLimited: false
            };
            const native = createNativeAcquisitionSnapshotFixture(activeCapture);
            const open = {
                kind: 'rtc-diagnostic',
                agentId: 'agent-a',
                value: {
                    topic: 'rallar.browser.rtc.signaling_diagnostics',
                    payload: {
                        data: toFixtureJson({
                            kind: 'native-state',
                            trigger: 'channel-open',
                            localSessionId: 'session-a',
                            peerSessionId: 'session-b',
                            atEpochMs: 121,
                            native: { ...native, state: { ...native.state, channelState: { status: 'observed', value: 'open' } } }
                        })
                    }
                }
            };
            rows.push(open);
            const disposedCapture: RtcSignalingDiagnostics.CaptureStatus = { ...activeCapture, scope: 'disposed' };
            const disposalBodies = {
                'late-disposal': {
                    kind: 'native-observation-status',
                    stage: 'disposed',
                    availability: { status: 'observed', value: 'enabled' },
                    capture: disposedCapture
                },
                'late-limit-disposal': { kind: 'native-observation-limit', limit: 'ordinary-rows', identity: native.identity, capture: disposedCapture },
                'late-nested-disposal': { kind: 'native-state', trigger: 'connection', native: { ...native, capture: disposedCapture } }
            };
            const disposal = Object.hasOwn(disposalBodies, variant)
                ? disposalBodies[variant as keyof typeof disposalBodies]
                : undefined;
            const appended = disposal === undefined ? [] : [{
                ...open,
                value: {
                    ...open.value,
                    payload: { data: toFixtureJson({ localSessionId: 'session-a', peerSessionId: 'session-b', atEpochMs: 122, ...disposal }) }
                }
            }, open];
            const reached = Promise.withResolvers<void>();
            const finish = Promise.withResolvers<void>();
            let closed = false;
            async function* source(): AsyncGenerator<Uint8Array> {
                try {
                    yield Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
                    reached.resolve();
                    await finish.promise;
                    if (variant === 'source-error') {
                        throw new Error('private-source-sentinel');
                    }
                    yield Buffer.from(appended.map((row) => JSON.stringify(row)).join('\n'));
                }
                finally {
                    closed = true;
                }
            }
            let settled = false;
            const pending = readRtcNativeAcquisition(createCapturedNativeConnectionFixture(), 'fixture:bytes', readRecorderJsonlRows(source(), 8_388_608));
            void pending.then(() => {
                settled = true;
            });
            await reached.promise;
            expect(settled).toBe(false);
            finish.resolve();
            const acquired = await pending;
            expect(closed).toBe(true);
            if (variant === 'clean') {
                expect(acquired.left).toBeUndefined();
                expect(acquired.right?.source.completeness).toBe('complete');
            }
            else {
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe(variant === 'source-error' ? 'acquisition-failed' : 'native-scope-disposed');
                expect(JSON.stringify(acquired.left)).not.toContain('private-source-sentinel');
            }
        }
    );

    it('refuses an iterator failure after a completion event and refuses missing completion', async () => {
        const jsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n');
        const complete = await Array.fromAsync(readRecorderJsonlRows(toFixtureBytes(jsonl), 8_388_608));
        async function* failedAfterCompletion() {
            yield* complete;
            throw new Error('source failed after terminal observation');
        }
        const connection = createCapturedNativeConnectionFixture();
        const failed = await readRtcNativeAcquisition(connection, 'fixture:terminal', failedAfterCompletion());
        expect(failed.right).toBeUndefined();
        expect(failed.left).toMatchObject({ reason: 'acquisition-failed', source: { completeness: 'incomplete' } });
        async function* missingCompletion() {
            yield* complete.filter((read) => read.right?.kind === 'row');
        }
        const missing = await readRtcNativeAcquisition(connection, 'fixture:terminal', missingCompletion());
        expect(missing.right).toBeUndefined();
        expect(missing.left?.reason).toBe('acquisition-failed');
        async function* failureEvent() {
            yield* complete;
            yield Either.ofLeft<RecorderJsonlFailure, RecorderJsonlRead>({
                code: 'runtime-read-failed' as const,
                cause: new Error('late failure'),
                bytesRead: Buffer.byteLength(jsonl),
                decodedRecords: 2
            });
        }
        const late = await readRtcNativeAcquisition(connection, 'fixture:terminal', failureEvent());
        expect(late.left?.reason).toBe('acquisition-failed');
    });

    it('refuses malformed recognized native evidence after valid proof', async () => {
        const rows = createNativeRecorderRowsFixture();
        const malformed = structuredClone(rows[1]);
        const event = ((malformed.value as Record<string, ApiJsonValue>).payload as Record<string, ApiJsonValue>).data as Record<string, ApiJsonValue>;
        event.credential = 'private-native-sentinel';
        recorderJsonl = [...rows, malformed].map((row) => JSON.stringify(row)).join('\n');
        const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'acquisition-failed', source: { completeness: 'incomplete', malformedRows: 1 } });
        expect(JSON.stringify(acquired.left)).not.toContain('private-native-sentinel');
    });

    it('refuses a clean empty supplied source without inventing Connect evidence', async () => {
        const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'connect-result-unavailable', source: { completeness: 'complete', bytesRead: 0, decodedRecords: 0 } });
    });

    describe('attributed recipe Native acquisition', () => {
        it.each([0, 1])('acquires an actual-shaped compact immediate child at acknowledged position %s', async (childIndex) => {
            const connection = createRecipeNativeConnectionFixture();
            connection.recipeAttribution.childIndex = childIndex;
            const { root, actual, child, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            if (childIndex === 1) {
                actual.results = [{ ...child, commandId: 'preceding-health', kind: 'health' }, child];
                actual.resultCount = 2;
            }
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';

            const acquired = await readFixtureAcquisition(connection);

            expect(acquired.left).toBeUndefined();
            expect(acquired.right?.connection).toMatchObject({
                commandId: 'connect-native-a',
                sessionId: 'session-a',
                receipt: {
                    configuration: { mode: 'native', origin: 'host' },
                    connectionId: { status: 'observed', value: 'connection-a' },
                    nativeScopeId: { status: 'observed', value: 'scope-a' },
                    nativeCoverage: 'partial'
                }
            });
            expect(acquired.right?.initialized).toMatchObject({ stage: 'initialized', localSessionId: 'session-a', capture: { scope: 'active' } });
            expect(acquired.right?.source).toMatchObject({ durableOrigin: 'unknown', malformedRows: 0, oversizedRows: 0, completeness: 'complete' });
        });

        describe.each(['wrong', 'missing'])('%s recipe root proof', (variant) => {
            it.each(
                [
                    ['root', 'kind'],
                    ['root', 'commandId'],
                    ['root', 'agentId'],
                    ['root', 'transport'],
                    ['root', 'connection'],
                    ['root', 'action'],
                    ['root', 'status'],
                    ['actual', 'recipeId'],
                    ['invocation', 'invocationId'],
                    ['invocation', 'recipeBodyId']
                ] as const
            )('refuses %s.%s even with a matching child and initialized scope', async (owner, field) => {
                const connection = createRecipeNativeConnectionFixture();
                const fixture = createCompactedRecipeNativeRecorderFixture(connection);
                if (variant === 'missing') {
                    delete fixture[owner][field];
                }
                else {
                    fixture[owner][field] = 'unrelated';
                }
                recorderJsonl = [fixture.root, fixture.initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            });
        });

        it.each(['null', 'empty', 'opaque', 'limited', 'invalid', 'no-status', 'no-omission-fact'])('refuses %s recipe evidence', async (variant) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, actual, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            const evidence: Record<string, Record<string, ApiJsonValue>['resultEvidence']> = {
                null: null,
                empty: {},
                opaque: 'finite',
                limited: { status: 'limited', payloadsOmitted: true },
                invalid: { status: 'invalid', payloadsOmitted: true },
                'no-status': { payloadsOmitted: true },
                'no-omission-fact': { status: 'finite' }
            };
            actual.resultEvidence = evidence[variant];
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        describe.each(['empty', 'wrong'])('%s acknowledged identity', (variant) => {
            it.each(['rootCommandId', 'recipeId', 'invocationId', 'recipeBodyId'] as const)('refuses acknowledged %s', async (field) => {
                const connection = createRecipeNativeConnectionFixture();
                connection.recipeAttribution[field] = variant === 'empty' ? '' : 'unrelated';
                const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            });
        });

        it.each([-1, 1, 0.5, NaN, Infinity])('refuses unavailable or invalid acknowledged child position %s', async (childIndex) => {
            const connection = createRecipeNativeConnectionFixture();
            connection.recipeAttribution.childIndex = childIndex;
            const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it.each(['absent', 'missing-position', 'missing-identity', 'opaque', 'null'] as const)('refuses %s recipe attribution', async (variant) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            if (variant === 'absent') {
                Reflect.deleteProperty(connection, 'recipeAttribution');
            }
            else if (variant === 'opaque' || variant === 'null') {
                Object.defineProperty(connection, 'recipeAttribution', { value: variant === 'opaque' ? 'acknowledged' : null });
            }
            else {
                Reflect.deleteProperty(connection.recipeAttribution, variant === 'missing-position' ? 'childIndex' : 'invocationId');
            }
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it('never substitutes a standalone Connect when recipe attribution is present', async () => {
            const connection = createRecipeNativeConnectionFixture();
            const rows = createNativeRecorderRowsFixture();
            rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: toFixtureJson(connection.receipt) } };
            recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it.each([
            ['commandId', 'unrelated'],
            ['kind', 'health'],
            ['status', 'failed'],
            ['ok', false],
            ['replayed', true],
            ['startedAtEpochMs', 'opaque'],
            ['endedAtEpochMs', null],
            ['durationMs', 'opaque']
        ])('refuses a wrong or malformed immediate child %s', async (field, value) => {
            const connection = createRecipeNativeConnectionFixture();
            const fixture = createCompactedRecipeNativeRecorderFixture(connection);
            fixture.child[String(field)] = value;
            recorderJsonl = [fixture.root, fixture.initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it.each(['missing-list', 'opaque-list', 'opaque-child', 'nested-child', 'duplicate-id', 'missing-value'])(
            'refuses %s immediate child proof',
            async (variant) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, actual, child, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                if (variant === 'missing-list') {
                    delete actual.results;
                }
                else if (variant === 'missing-value') {
                    delete child.value;
                }
                else {
                    actual.results = variant === 'opaque-list'
                        ? { results: [child] }
                        : variant === 'opaque-child'
                        ? [{ payload: child }]
                        : variant === 'nested-child'
                        ? [{ ...child, kind: 'recipe.run', value: { results: [child] } }]
                        : [child, { ...child, kind: 'health' }];
                }
                recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            }
        );

        it.each(['transport', 'connection', 'sessionId'] as const)('refuses the wrong child %s', async (field) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, value, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            value[field] = 'previous';
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it.each(['configuration', 'application', 'connectionId', 'nativeScopeId', 'configurationVersion', 'nativeAvailability', 'nativeCoverage', 'readout'])(
            'refuses changed complete child capture %s',
            async (field) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, value, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                const receipt = toFixtureJson(connection.receipt) as Record<string, ApiJsonValue>;
                if (field === 'readout') {
                    value.rtcCapture = { status: 'unavailable', reason: 'absent' };
                }
                else {
                    const changedFacts: Record<string, ApiJsonValue> = {
                        configuration: { mode: 'native', origin: 'step' },
                        application: { status: 'applied', mode: 'off' },
                        connectionId: { status: 'observed', value: 'previous-connection' },
                        nativeScopeId: { status: 'observed', value: 'previous-scope' },
                        configurationVersion: 2,
                        nativeAvailability: { status: 'observed', value: 'disabled' },
                        nativeCoverage: 'attached'
                    };
                    receipt[field] = changedFacts[field];
                    value.rtcCapture = { status: 'observed', value: receipt };
                }
                recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            }
        );

        it.each(['absent', 'agent', 'session', 'scope', 'availability', 'inactive', 'malformed'])(
            'refuses %s recipe initialization without changing the Connect failure boundary',
            async (variant) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                const value = initialized.value as Record<string, ApiJsonValue>;
                const event = (value.payload as Record<string, ApiJsonValue>).data as Record<string, ApiJsonValue>;
                if (variant === 'agent') {
                    initialized.agentId = 'agent-b';
                }
                else if (variant === 'session') {
                    event.localSessionId = 'previous-session';
                }
                else if (variant === 'availability') {
                    event.availability = { status: 'observed', value: 'disabled' };
                }
                else if (variant === 'malformed') {
                    event.credential = 'private-native-sentinel';
                }
                else if (variant === 'scope' || variant === 'inactive') {
                    event.capture = {
                        ...(event.capture as Record<string, ApiJsonValue>),
                        ...(variant === 'scope' ? { scopeId: { status: 'observed', value: 'previous-scope' } } : { scope: 'disposed' })
                    };
                }
                recorderJsonl = (variant === 'absent' ? [root] : [root, initialized]).map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe(
                    variant === 'inactive'
                        ? 'native-scope-disposed'
                        : variant === 'malformed' || variant === 'availability'
                        ? 'acquisition-failed'
                        : 'initialized-status-unavailable'
                );
                expect(JSON.stringify(acquired.left)).not.toContain('private-native-sentinel');
            }
        );

        describe.each(['before', 'after'])('recipe disposal %s initialization', (order) => {
            it.each(['status', 'limit', 'lifetime', 'state'])('refuses the matching scope carried by %s', async (carrier) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                const disposed = structuredClone(initialized);
                const value = disposed.value as Record<string, ApiJsonValue>;
                const capture: RtcSignalingDiagnostics.CaptureStatus = {
                    scopeId: { status: 'observed', value: 'scope-a' },
                    scope: 'disposed',
                    ordinaryRowsSuppressed: false,
                    admissionLimited: false,
                    payloadLimited: false
                };
                const native = createNativeAcquisitionSnapshotFixture(capture);
                const bodies = {
                    status: { kind: 'native-observation-status', stage: 'disposed', availability: { status: 'observed', value: 'enabled' }, capture },
                    limit: { kind: 'native-observation-limit', limit: 'ordinary-rows', identity: native.identity, capture },
                    lifetime: { kind: 'native-lifetime', action: 'retiring', retirement: 'reset', native },
                    state: { kind: 'native-state', trigger: 'connection', native }
                };
                value.payload = { data: toFixtureJson({ localSessionId: 'session-a', atEpochMs: 121, ...bodies[carrier as keyof typeof bodies] }) };
                recorderJsonl = (order === 'before' ? [disposed, root, initialized] : [root, initialized, disposed]).map((row) =>
                    JSON.stringify(row)
                ).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { malformedRows: 0, oversizedRows: 0 } });
            });
        });
    });

    describe('complete raw recipe Native acquisition', () => {
        it.each([17_156, 19_300])('admits an attributed recipe root of at least %s bytes through clean EOF', async (size) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, actual, initialized } = createRawRecipeNativeRecorderFixture(connection);
            actual.padding = 'x'.repeat(size);
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.left).toBeUndefined();
            expect(acquired.right?.connection).toEqual(connection);
        });

        it('refuses a malformed trailing row after apparent complete native proof', async () => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, initialized } = createRawRecipeNativeRecorderFixture(connection);
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n{broken';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('acquisition-failed');
        });

        it.each([0, 1])('acquires the complete raw immediate child at acknowledged position %s', async (childIndex) => {
            const connection = createRecipeNativeConnectionFixture();
            connection.recipeAttribution.childIndex = childIndex;
            const { root, actual, child, initialized } = createRawRecipeNativeRecorderFixture(connection);
            if (childIndex === 1) {
                actual.results = [{ ...child, commandId: 'preceding-health', kind: 'health' }, child];
            }
            recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';

            const acquired = await readFixtureAcquisition(connection);

            expect(acquired.left).toBeUndefined();
            expect(acquired.right).toEqual({
                connection,
                initialized: {
                    kind: 'native-observation-status',
                    localSessionId: 'session-a',
                    atEpochMs: 120,
                    stage: 'initialized',
                    availability: { status: 'observed', value: 'enabled' },
                    capture: {
                        scopeId: { status: 'observed', value: 'scope-a' },
                        scope: 'active',
                        ordinaryRowsSuppressed: false,
                        admissionLimited: false,
                        payloadLimited: false
                    }
                },
                source: {
                    endpoint: `fixture:recorder`,
                    durableOrigin: 'unknown',
                    bytesRead: Buffer.byteLength(recorderJsonl),
                    decodedRecords: 2,
                    malformedRows: 0,
                    oversizedRows: 0,
                    completeness: 'complete'
                }
            });
        });

        it.each(['acknowledged-invocation', 'canonical-child', 'duplicate-command', 'replayed-child', 'capture-readout'])(
            'refuses raw %s without substituting compaction metadata for proof',
            async (variant) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, actual, invocation, child, value, initialized } = createRawRecipeNativeRecorderFixture(connection);
                if (variant === 'acknowledged-invocation') {
                    invocation.invocationId = 'previous-invocation';
                }
                else if (variant === 'canonical-child') {
                    child.durationMs = 'opaque';
                }
                else if (variant === 'duplicate-command') {
                    actual.results = [child, { ...child }];
                }
                else if (variant === 'replayed-child') {
                    child.replayed = true;
                }
                else {
                    value.rtcCapture = { status: 'unavailable', reason: 'absent' };
                }
                recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await readFixtureAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            }
        );

        it('refuses a complete raw Connect when its current initialization is absent', async () => {
            const connection = createRecipeNativeConnectionFixture();
            const { root } = createRawRecipeNativeRecorderFixture(connection);
            recorderJsonl = JSON.stringify(root) + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('initialized-status-unavailable');
        });

        it.each(['before', 'after'])('refuses current raw scope disposal %s initialization', async (order) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, initialized } = createRawRecipeNativeRecorderFixture(connection);
            const disposed = structuredClone(initialized);
            const event = ((disposed.value as Record<string, ApiJsonValue>).payload as Record<string, ApiJsonValue>).data as Record<string, ApiJsonValue>;
            event.stage = 'disposed';
            event.capture = {
                scopeId: { status: 'observed', value: 'scope-a' },
                scope: 'disposed',
                ordinaryRowsSuppressed: false,
                admissionLimited: false,
                payloadLimited: false
            };
            const rows = order === 'before' ? [root, disposed, initialized] : [root, initialized, disposed];
            recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('native-scope-disposed');
        });
    });

    describe('optional recipe attribution boundary', () => {
        it('treats explicitly undefined attribution as the supported direct path', async () => {
            const connection = { ...createCapturedNativeConnectionFixture(), recipeAttribution: undefined };
            recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.left).toBeUndefined();
            expect(acquired.right?.connection).toEqual(connection);
            expect(acquired.right?.initialized).toMatchObject({ stage: 'initialized', localSessionId: 'session-a' });
        });

        it.each([null, 'acknowledged', {}])('refuses provided malformed attribution %j even with a matching standalone Connect', async (attribution) => {
            const connection = createCapturedNativeConnectionFixture();
            Object.defineProperty(connection, 'recipeAttribution', { value: attribution });
            recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });
    });

    it('acquires a finite initialized Native scope bound to the actual admitted Connect from one recorder GET', async () => {
        const connection = createCapturedNativeConnectionFixture();
        recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await readFixtureAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(acquired.right).toEqual({
            connection,
            initialized: {
                kind: 'native-observation-status',
                localSessionId: 'session-a',
                atEpochMs: 120,
                stage: 'initialized',
                availability: { status: 'observed', value: 'enabled' },
                capture: {
                    scopeId: { status: 'observed', value: 'scope-a' },
                    scope: 'active',
                    ordinaryRowsSuppressed: false,
                    admissionLimited: false,
                    payloadLimited: false
                }
            },
            source: {
                endpoint: `fixture:recorder`,
                durableOrigin: 'unknown',
                bytesRead: Buffer.byteLength(recorderJsonl),
                decodedRecords: 2,
                malformedRows: 0,
                oversizedRows: 0,
                completeness: 'complete'
            }
        });
    });

    it('binds the requested run endpoint and admits actual partial Native capture for messages.rtc', async () => {
        const connection: RtcNativeCapturedConnection = {
            ...createCapturedNativeConnectionFixture(),
            runId: 'native/run + one',
            transport: 'messages.rtc',
            receipt: { ...createCapturedNativeConnectionFixture().receipt, nativeCoverage: 'partial' }
        };
        const rows = createNativeRecorderRowsFixture();
        rows[0].transport = 'messages.rtc';
        rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: toFixtureJson(connection.receipt) } };
        recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await readFixtureAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(acquired.right?.connection).toMatchObject({ transport: 'messages.rtc', receipt: { nativeCoverage: 'partial' } });
        expect(acquired.right?.source.endpoint).toBe('fixture:recorder');
    });

    it('refuses an admitted unavailable Native receipt even when an initialized row was received', async () => {
        const connection: RtcNativeCapturedConnection = {
            ...createCapturedNativeConnectionFixture(),
            receipt: {
                ...createCapturedNativeConnectionFixture().receipt,
                nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
                nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
                nativeCoverage: 'unavailable'
            }
        };
        const rows = createNativeRecorderRowsFixture();
        rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: toFixtureJson(connection.receipt) } };
        recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await readFixtureAcquisition(connection);
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'native-capture-unavailable', source: { durableOrigin: 'unknown', malformedRows: 0 } });
    });

    it.each(['agentId', 'commandId', 'action', 'status', 'transport', 'connection', 'sessionId', 'receipt'])(
        'refuses a Native proof without the exact successful Connect %s',
        async (field) => {
            const rows = createNativeRecorderRowsFixture();
            if (field === 'sessionId' || field === 'receipt') {
                rows[0].actual = field === 'sessionId'
                    ? {
                        sessionId: 'previous-session',
                        rtcCapture: { status: 'observed', value: toFixtureJson(createCapturedNativeConnectionFixture().receipt) }
                    }
                    : {
                        sessionId: 'session-a',
                        rtcCapture: {
                            status: 'observed',
                            value: {
                                ...toFixtureJson(createCapturedNativeConnectionFixture().receipt) as Record<string, ApiJsonValue>,
                                connectionId: { status: 'observed', value: 'previous-connection' }
                            }
                        }
                    };
            }
            else {
                rows[0][field] = field === 'action' ? 'Connect' : 'different';
            }
            recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
            expect(acquired.right).toBeUndefined();
            expect(acquired.left).toMatchObject({ reason: 'connect-result-unavailable', connection: { sessionId: 'session-a' } });
        }
    );

    it.each(['agent', 'session', 'scope', 'availability', 'malformed'])('refuses an initialized Native row with mismatched or invalid %s', async (field) => {
        const rows = createNativeRecorderRowsFixture();
        const row = rows[1];
        const value = row.value as Record<string, ApiJsonValue>;
        const payload = value.payload as Record<string, ApiJsonValue>;
        const event = payload.data as Record<string, ApiJsonValue>;
        if (field === 'agent') {
            row.agentId = 'agent-b';
        }
        if (field === 'session') {
            event.localSessionId = 'previous-session';
        }
        if (field === 'scope') {
            event.capture = {
                scopeId: { status: 'observed', value: 'previous-scope' },
                scope: 'active',
                ordinaryRowsSuppressed: false,
                admissionLimited: false,
                payloadLimited: false
            };
        }
        if (field === 'availability') {
            event.availability = { status: 'unavailable', reason: 'unsupported' };
        }
        if (field === 'malformed') {
            event.credential = 'private-native-sentinel';
        }
        recorderJsonl = rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
        const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: field === 'malformed' ? 'acquisition-failed' : 'initialized-status-unavailable' });
        expect(JSON.stringify(acquired.left)).not.toContain('private-native-sentinel');
        if (field === 'malformed') {
            expect(acquired.left?.source?.malformedRows).toBe(1);
        }
    });

    it('refuses an observed disposal of the same Native scope regardless of recorder order', async () => {
        const rows = createNativeRecorderRowsFixture();
        const disposed = structuredClone(rows[1]);
        const value = disposed.value as Record<string, ApiJsonValue>;
        const event = (value.payload as Record<string, ApiJsonValue>).data as Record<string, ApiJsonValue>;
        event.stage = 'disposed';
        event.capture = {
            scopeId: { status: 'observed', value: 'scope-a' },
            scope: 'disposed',
            ordinaryRowsSuppressed: false,
            admissionLimited: false,
            payloadLimited: false
        };
        recorderJsonl = [disposed, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { durableOrigin: 'unknown', completeness: 'complete' } });
    });

    it('refuses a finite disposed capture of the same Native scope carried by a limit observation', async () => {
        const rows = createNativeRecorderRowsFixture();
        rows.push({
            kind: 'rtc-diagnostic',
            agentId: 'agent-a',
            value: {
                topic: 'rallar.browser.rtc.signaling_diagnostics',
                payload: {
                    data: {
                        kind: 'native-observation-limit',
                        localSessionId: 'session-a',
                        atEpochMs: 121,
                        limit: 'ordinary-rows',
                        identity: {
                            peerConnectionId: { status: 'unavailable', reason: 'absent' },
                            channelId: { status: 'unavailable', reason: 'absent' }
                        },
                        capture: {
                            scopeId: { status: 'observed', value: 'scope-a' },
                            scope: 'disposed',
                            ordinaryRowsSuppressed: true,
                            admissionLimited: false,
                            payloadLimited: false
                        }
                    }
                }
            }
        });
        recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { malformedRows: 0 } });
    });

    describe.each(['same-scope', 'other-scope', 'other-session', 'active'] as const)('nested Native capture %s', (ownership) => {
        describe.each(['before', 'after'] as const)('disposal occurs %s initialized status', (order) => {
            it.each(['lifetime', 'state', 'first-error', 'candidate', 'service', 'service-native'] as const)(
                'checks every finite %s capture before acquiring a proof',
                async (carrier) => {
                    const capture: RtcSignalingDiagnostics.CaptureStatus = {
                        scopeId: { status: 'observed', value: ownership === 'other-scope' ? 'other-scope' : 'scope-a' },
                        scope: ownership === 'active' ? 'active' : 'disposed',
                        ordinaryRowsSuppressed: false,
                        admissionLimited: false,
                        payloadLimited: false
                    };
                    const activeCapture: RtcSignalingDiagnostics.CaptureStatus = { ...capture, scope: 'active' };
                    const native = createNativeAcquisitionSnapshotFixture(capture);
                    const unavailable: RtcSignalingDiagnostics.UnavailableReadout = { status: 'unavailable', reason: 'absent' };
                    const service: RtcSignalingDiagnostics.ServiceTerminationObservation = {
                        peerId: 'peer-a',
                        setupId: { status: 'observed', value: 'setup-a' },
                        setup: { peerId: 'peer-a', phase: 'established', startedAtEpochMs: 1, establishedAtEpochMs: 2 },
                        stage: 'terminating',
                        issuer: { status: 'observed', value: 'disconnect-peer' },
                        timeout: { status: 'unavailable', reason: 'not-applicable' },
                        native: carrier === 'service' ? { ...native, capture: activeCapture } : native,
                        capture: carrier === 'service' ? capture : activeCapture,
                        channels: [],
                        channelCount: 0,
                        channelsTruncated: false
                    };
                    const bodies = {
                        lifetime: { kind: 'native-lifetime', action: 'retiring', retirement: 'reset', native },
                        state: { kind: 'native-state', trigger: 'connection', native },
                        'first-error': {
                            kind: 'native-first-error',
                            first: 'both',
                            native,
                            error: {
                                source: 'channel-error',
                                nativeSequence: 1,
                                identity: native.identity,
                                errorDetail: unavailable,
                                sctpCauseCode: unavailable,
                                receivedAlert: unavailable,
                                sentAlert: unavailable,
                                iceErrorCode: unavailable,
                                exceptionName: unavailable
                            }
                        },
                        candidate: {
                            kind: 'native-candidate-application',
                            candidate: {
                                operationOrdinal: 1,
                                applicationOrdinal: 0,
                                source: 'direct',
                                stage: 'returned',
                                currentPeerConnection: false,
                                identity: native.identity,
                                fragmentPresence: 'absent',
                                dataIceFragmentComparison: 'unknown',
                                comparisonReadout: { status: 'observed', value: 'available' },
                                targetTransportAssociation: 'unknown',
                                iceGenerationAssociation: 'unknown',
                                error: { status: 'none-observed', coverage: { kind: 'native-operation', stage: 'settled' } },
                                capture
                            }
                        },
                        service: { kind: 'service-peer-observation', service },
                        'service-native': { kind: 'service-peer-observation', service }
                    };
                    const rows = createNativeRecorderRowsFixture();
                    const nestedRow = {
                        kind: 'rtc-diagnostic',
                        agentId: 'agent-a',
                        value: {
                            topic: 'rallar.browser.rtc.signaling_diagnostics',
                            payload: {
                                data: toFixtureJson({
                                    localSessionId: ownership === 'other-session' ? 'other-session' : 'session-a',
                                    atEpochMs: 121,
                                    ...bodies[carrier]
                                })
                            }
                        }
                    };
                    if (order === 'before') {
                        rows.unshift(nestedRow);
                    }
                    else {
                        rows.push(nestedRow);
                    }
                    recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

                    const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture()).catch((error: Error) => error);

                    expect(acquired).not.toBeInstanceOf(Error);
                    if (acquired instanceof Error) {
                        return;
                    }
                    if (ownership === 'same-scope') {
                        expect(acquired.right).toBeUndefined();
                        expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { malformedRows: 0, oversizedRows: 0 } });
                    }
                    else {
                        expect(acquired.left).toBeUndefined();
                        expect(acquired.right?.source).toMatchObject({ malformedRows: 0, oversizedRows: 0 });
                        expect(acquired.right?.initialized).toMatchObject({ stage: 'initialized', capture: { scopeId: { value: 'scope-a' } } });
                    }
                }
            );
        });
    });

    it('ignores another scope disposal and compares receipt keys without ordering dependence', async () => {
        const rows = createNativeRecorderRowsFixture();
        const connection = createCapturedNativeConnectionFixture();
        const reversedReceipt = Object.fromEntries(Object.entries(connection.receipt).reverse());
        rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: toFixtureJson(reversedReceipt) } };
        const disposed = structuredClone(rows[1]);
        const event = ((disposed.value as Record<string, ApiJsonValue>).payload as Record<string, ApiJsonValue>).data as Record<string, ApiJsonValue>;
        event.stage = 'disposed';
        event.capture = {
            scopeId: { status: 'observed', value: 'previous-scope' },
            scope: 'disposed',
            ordinaryRowsSuppressed: false,
            admissionLimited: false,
            payloadLimited: false
        };
        recorderJsonl = [disposed, ...rows].map((row) => JSON.stringify(row)).join('\n') +
            '\n';
        const acquired = await readFixtureAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(acquired.right?.source).toMatchObject({ malformedRows: 0, oversizedRows: 0, completeness: 'complete', durableOrigin: 'unknown' });
        expect(acquired.right?.initialized).toMatchObject({ stage: 'initialized', capture: { scopeId: { value: 'scope-a' } } });
    });

    it.each(['early-root', 'late-initialization', 'late-disposal'])('scans beyond aggregate diagnostic limits: %s', async (variant) => {
        const rows = createNativeRecorderRowsFixture();
        const filler = JSON.stringify({ padding: 'x'.repeat(3200) }) + '\n';
        const disposed = structuredClone(rows[1]);
        const event = ((disposed.value as Record<string, ApiJsonValue>).payload as Record<string, ApiJsonValue>).data as Record<string, ApiJsonValue>;
        event.stage = 'disposed';
        (event.capture as Record<string, ApiJsonValue>).scope = 'disposed';
        recorderJsonl = JSON.stringify(rows[0]) + '\n' + (variant === 'late-initialization' ? '' : JSON.stringify(rows[1]) + '\n') +
            filler.repeat(21_000) + JSON.stringify(variant === 'late-disposal' ? disposed : rows[1]);
        const acquired = await readFixtureAcquisition(createCapturedNativeConnectionFixture());
        if (variant === 'late-disposal') {
            expect(acquired.left?.reason).toBe('native-scope-disposed');
            expect(acquired.right).toBeUndefined();
        }
        else {
            expect(acquired.left).toBeUndefined();
            expect(acquired.right?.source).toMatchObject({ completeness: 'complete', durableOrigin: 'unknown' });
            expect(acquired.right?.source.bytesRead).toBeGreaterThan(67_108_864);
            expect(acquired.right?.source.decodedRecords).toBeGreaterThan(20_000);
        }
    });
});
