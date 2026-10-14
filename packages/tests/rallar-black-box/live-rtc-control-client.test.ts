import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';

function createCapturedNativeConnectionFixture(): LiveRtcControlClient.CapturedConnection {
    return {
        runId: 'native-run',
        agentId: 'agent-a',
        commandId: 'connect-native-a',
        connection: 'manual-a',
        transport: 'realtime',
        sessionId: 'session-a',
        requestedConfiguration: { mode: 'native', origin: 'step' },
        receipt: {
            configuration: { mode: 'native', origin: 'step' },
            application: { status: 'applied', mode: 'native' },
            connectionId: { status: 'observed', value: 'connection-a' },
            nativeScopeId: { status: 'observed', value: 'scope-a' },
            configurationVersion: 1,
            nativeAvailability: { status: 'observed', value: 'enabled' },
            nativeCoverage: 'attached'
        }
    };
}

function createNativeRecorderRowsFixture(): LiveRtcJsonRecord[] {
    return [
        {
            kind: 'step-result',
            name: 'connect-native-a',
            status: 'SUCCESS',
            action: 'rtc.connect',
            agentId: 'agent-a',
            commandId: 'connect-native-a',
            transport: 'realtime',
            connection: 'manual-a',
            actual: { sessionId: 'session-a', rtcCapture: { status: 'observed', value: normalizeJson(createCapturedNativeConnectionFixture().receipt) } }
        },
        {
            kind: 'rtc-diagnostic',
            agentId: 'agent-a',
            value: {
                topic: 'rallar.browser.rtc.signaling_diagnostics',
                payload: {
                    data: {
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
                    }
                }
            }
        }
    ];
}

interface RecipeNativeConnectionFixture extends LiveRtcControlClient.CapturedConnection {
    readonly recipeAttribution: { -readonly [Field in keyof LiveRtcControlClient.RecipeAttribution]: LiveRtcControlClient.RecipeAttribution[Field]; };
}

interface RecipeConnectResultFixture {
    readonly child: LiveRtcJsonRecord;
    readonly value: LiveRtcJsonRecord;
}

interface RecipeNativeRecorderFixture extends RecipeConnectResultFixture {
    readonly root: LiveRtcJsonRecord;
    readonly actual: LiveRtcJsonRecord;
    readonly invocation: LiveRtcJsonRecord;
    readonly initialized: LiveRtcJsonRecord;
}

function createRecipeNativeConnectionFixture(): RecipeNativeConnectionFixture {
    const connection = createCapturedNativeConnectionFixture();
    return {
        ...connection,
        requestedConfiguration: { mode: 'native', origin: 'host' } satisfies RtcSignalingDiagnostics.CaptureConfiguration,
        receipt: {
            ...connection.receipt,
            configuration: { mode: 'native', origin: 'host' },
            nativeCoverage: 'partial'
        } satisfies RtcSignalingDiagnostics.CaptureReceipt,
        recipeAttribution: {
            rootCommandId: 'recipe-connect-native-a',
            recipeId: 'declared-native-recipe',
            invocationId: 'acknowledged-native-invocation',
            recipeBodyId: 'acknowledged-native-body',
            childIndex: 0
        }
    };
}

function createRecipeConnectResultFixture(connection: RecipeNativeConnectionFixture): RecipeConnectResultFixture {
    const value: LiveRtcJsonRecord = {
        status: 'connected',
        connection: 'manual-a',
        actor: 'agent-a',
        transport: 'realtime',
        roomId: 'room-a',
        applicationId: 'app-a',
        workspaceId: 'space-a',
        clientId: 'client-a',
        sessionId: 'session-a',
        username: 'user-a',
        laneId: 'realtime',
        document: { origin: 'http://local.test', timeOrigin: 100 },
        scope: { applicationId: 'app-a', workspaceId: 'space-a' },
        roomRef: { applicationId: 'app-a', workspaceId: 'space-a', groupId: 'room-a' },
        rtcCapture: { status: 'observed', value: normalizeJson(connection.receipt) }
    };
    const child: LiveRtcJsonRecord = {
        commandId: 'connect-native-a',
        kind: 'rtc.connect',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 100,
        endedAtEpochMs: 110,
        durationMs: 10,
        value
    } satisfies RallarBlackBoxTestResult<LiveRtcJsonRecord>;
    return { child, value };
}

function createRawRecipeNativeRecorderFixture(connection: RecipeNativeConnectionFixture): RecipeNativeRecorderFixture {
    const { child, value } = createRecipeConnectResultFixture(connection);
    const invocation: LiveRtcJsonRecord = {
        invocationId: 'acknowledged-native-invocation',
        recipeBodyId: 'acknowledged-native-body'
    };
    const actual: LiveRtcJsonRecord = {
        recipeId: 'declared-native-recipe',
        invocation,
        results: [child]
    };
    const root: LiveRtcJsonRecord = {
        kind: 'step-result',
        name: 'recipe-connect-native-a',
        status: 'SUCCESS',
        transport: 'control',
        action: 'recipe.run',
        connection: 'agent-a',
        agentId: 'agent-a',
        commandId: 'recipe-connect-native-a',
        actual
    };
    // Explicit unit-test initialization control; no actual worker archive is rewritten.
    const initialized = createNativeRecorderRowsFixture()[1];
    return { root, actual, invocation, child, value, initialized };
}

function createCompactedRecipeNativeRecorderFixture(connection: RecipeNativeConnectionFixture): RecipeNativeRecorderFixture {
    const fixture = createRawRecipeNativeRecorderFixture(connection);
    const actual: LiveRtcJsonRecord = {
        ...fixture.actual,
        resultCount: 1,
        failureCount: 0,
        resultEvidence: { status: 'finite', payloadsOmitted: true }
    };
    return { ...fixture, actual, root: { ...fixture.root, actual } };
}

function createNativeAcquisitionSnapshotFixture(capture: RtcSignalingDiagnostics.CaptureStatus): RtcSignalingDiagnostics.NativeSnapshot {
    const unavailable: RtcSignalingDiagnostics.UnavailableReadout = { status: 'unavailable', reason: 'absent' };
    const coverage: RtcSignalingDiagnostics.ListenerErrorCoverage = {
        kind: 'listener-window',
        window: 'ended-at-retirement',
        attachment: 'partial',
        attachmentGap: true
    };
    return {
        identity: { peerConnectionId: { status: 'observed', value: 'scope-pc-1' }, channelId: { status: 'observed', value: 'scope-channel-2' } },
        nativeSequence: 1,
        capture,
        state: {
            connectionState: unavailable,
            iceConnectionState: unavailable,
            iceGatheringState: unavailable,
            signalingState: unavailable,
            iceTransportState: unavailable,
            dtlsState: unavailable,
            sctpState: unavailable,
            channelState: { status: 'observed', value: 'closed' },
            transportObjectOrdinal: unavailable,
            transportBinding: 'unavailable',
            listenerCoverage: 'partial',
            attachmentGap: true
        },
        firstError: { status: 'none-observed', coverage },
        firstTypedError: { status: 'unavailable', reason: 'unsupported', coverage }
    };
}

describe('live RTC control client', () => {
    let httpFixture: LiveRtcControlHttpFixture;
    beforeEach(async () => {
        httpFixture = await createDefaultLiveRtcControlHttpFixture();
    });
    afterEach(async () => {
        await httpFixture.close();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
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
            httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';

            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);

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
            expect(acquired.right?.source).toMatchObject({ durableOrigin: 'unknown', malformedRows: 0, oversizedRows: 0, scanLimited: false });
            expect(httpFixture.state.recorderUrls).toEqual(['/runs/native-run/events.jsonl']);
            expect(httpFixture.state.recorderReads).toBe(1);
            expect(httpFixture.state.captureEffects).toEqual(['history']);
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
                httpFixture.state.recorderJsonl = [fixture.root, fixture.initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
                expect(httpFixture.state.recorderReads).toBe(1);
            });
        });

        it.each(['null', 'empty', 'opaque', 'limited', 'invalid', 'no-status', 'no-omission-fact'])('refuses %s recipe evidence', async (variant) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, actual, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            const evidence: Record<string, LiveRtcJsonRecord['resultEvidence']> = {
                null: null,
                empty: {},
                opaque: 'finite',
                limited: { status: 'limited', payloadsOmitted: true },
                invalid: { status: 'invalid', payloadsOmitted: true },
                'no-status': { payloadsOmitted: true },
                'no-omission-fact': { status: 'finite' }
            };
            actual.resultEvidence = evidence[variant];
            httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
            expect(httpFixture.state.recorderReads).toBe(1);
        });

        describe.each(['empty', 'wrong'])('%s acknowledged identity', (variant) => {
            it.each(['rootCommandId', 'recipeId', 'invocationId', 'recipeBodyId'] as const)('refuses acknowledged %s', async (field) => {
                const connection = createRecipeNativeConnectionFixture();
                connection.recipeAttribution[field] = variant === 'empty' ? '' : 'unrelated';
                const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            });
        });

        it.each([-1, 1, 0.5, NaN, Infinity])('refuses unavailable or invalid acknowledged child position %s', async (childIndex) => {
            const connection = createRecipeNativeConnectionFixture();
            connection.recipeAttribution.childIndex = childIndex;
            const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
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
            httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it('never substitutes a standalone Connect when recipe attribution is present', async () => {
            const connection = createRecipeNativeConnectionFixture();
            const rows = createNativeRecorderRowsFixture();
            rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: normalizeJson(connection.receipt) } };
            httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
            expect(httpFixture.state.recorderReads).toBe(1);
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
            httpFixture.state.recorderJsonl = [fixture.root, fixture.initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
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
                httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            }
        );

        it.each(['transport', 'connection', 'sessionId'] as const)('refuses the wrong child %s', async (field) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, value, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
            value[field] = 'previous';
            httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
        });

        it.each(['configuration', 'application', 'connectionId', 'nativeScopeId', 'configurationVersion', 'nativeAvailability', 'nativeCoverage', 'readout'])(
            'refuses changed complete child capture %s',
            async (field) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, value, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                const receipt = normalizeJson(connection.receipt) as LiveRtcJsonRecord;
                if (field === 'readout') {
                    value.rtcCapture = { status: 'unavailable', reason: 'absent' };
                }
                else {
                    const changedFacts: LiveRtcJsonRecord = {
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
                httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
            }
        );

        it.each(['absent', 'agent', 'session', 'scope', 'availability', 'inactive', 'malformed'])(
            'refuses %s recipe initialization without changing the Connect failure boundary',
            async (variant) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                const value = initialized.value as LiveRtcJsonRecord;
                const event = (value.payload as LiveRtcJsonRecord).data as LiveRtcJsonRecord;
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
                        ...(event.capture as LiveRtcJsonRecord),
                        ...(variant === 'scope' ? { scopeId: { status: 'observed', value: 'previous-scope' } } : { scope: 'disposed' })
                    };
                }
                httpFixture.state.recorderJsonl = (variant === 'absent' ? [root] : [root, initialized]).map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe(variant === 'inactive' ? 'native-scope-disposed' : 'initialized-status-unavailable');
                expect(JSON.stringify(acquired.left)).not.toContain('private-native-sentinel');
                expect(httpFixture.state.recorderReads).toBe(1);
            }
        );

        describe.each(['before', 'after'])('recipe disposal %s initialization', (order) => {
            it.each(['status', 'limit', 'lifetime', 'state'])('refuses the matching scope carried by %s', async (carrier) => {
                const connection = createRecipeNativeConnectionFixture();
                const { root, initialized } = createCompactedRecipeNativeRecorderFixture(connection);
                const disposed = structuredClone(initialized);
                const value = disposed.value as LiveRtcJsonRecord;
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
                value.payload = { data: normalizeJson({ localSessionId: 'session-a', atEpochMs: 121, ...bodies[carrier as keyof typeof bodies] }) };
                httpFixture.state.recorderJsonl = (order === 'before' ? [disposed, root, initialized] : [root, initialized, disposed]).map((row) =>
                    JSON.stringify(row)
                ).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { malformedRows: 0, oversizedRows: 0 } });
                expect(httpFixture.state.recorderReads).toBe(1);
            });
        });
    });

    describe('complete raw recipe Native acquisition', () => {
        it.each([0, 1])('acquires the complete raw immediate child at acknowledged position %s', async (childIndex) => {
            const connection = createRecipeNativeConnectionFixture();
            connection.recipeAttribution.childIndex = childIndex;
            const { root, actual, child, initialized } = createRawRecipeNativeRecorderFixture(connection);
            if (childIndex === 1) {
                actual.results = [{ ...child, commandId: 'preceding-health', kind: 'health' }, child];
            }
            httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';

            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);

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
                    endpoint: `${httpFixture.baseUrl}/runs/native-run/events.jsonl`,
                    durableOrigin: 'unknown',
                    bytesRead: Buffer.byteLength(httpFixture.state.recorderJsonl),
                    retainedBytes: Buffer.byteLength(httpFixture.state.recorderJsonl),
                    retainedPrefixDropped: false,
                    transportTruncated: false,
                    malformedRows: 0,
                    oversizedRows: 0,
                    scanLimited: false
                }
            });
            expect(httpFixture.state.recorderReads).toBe(1);
            expect(httpFixture.state.captureEffects).toEqual(['history']);
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
                httpFixture.state.recorderJsonl = [root, initialized].map((row) => JSON.stringify(row)).join('\n') + '\n';
                const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
                expect(acquired.right).toBeUndefined();
                expect(acquired.left?.reason).toBe('connect-result-unavailable');
                expect(httpFixture.state.recorderReads).toBe(1);
            }
        );

        it('refuses a complete raw Connect when its current initialization is absent', async () => {
            const connection = createRecipeNativeConnectionFixture();
            const { root } = createRawRecipeNativeRecorderFixture(connection);
            httpFixture.state.recorderJsonl = JSON.stringify(root) + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('initialized-status-unavailable');
            expect(httpFixture.state.recorderReads).toBe(1);
        });

        it.each(['before', 'after'])('refuses current raw scope disposal %s initialization', async (order) => {
            const connection = createRecipeNativeConnectionFixture();
            const { root, initialized } = createRawRecipeNativeRecorderFixture(connection);
            const disposed = structuredClone(initialized);
            const event = ((disposed.value as LiveRtcJsonRecord).payload as LiveRtcJsonRecord).data as LiveRtcJsonRecord;
            event.stage = 'disposed';
            event.capture = {
                scopeId: { status: 'observed', value: 'scope-a' },
                scope: 'disposed',
                ordinaryRowsSuppressed: false,
                admissionLimited: false,
                payloadLimited: false
            };
            const rows = order === 'before' ? [root, disposed, initialized] : [root, initialized, disposed];
            httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('native-scope-disposed');
            expect(httpFixture.state.recorderReads).toBe(1);
        });
    });

    describe('optional recipe attribution boundary', () => {
        it('treats explicitly undefined attribution as the supported direct path', async () => {
            const connection = { ...createCapturedNativeConnectionFixture(), recipeAttribution: undefined };
            httpFixture.state.recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.left).toBeUndefined();
            expect(acquired.right?.connection).toEqual(connection);
            expect(acquired.right?.initialized).toMatchObject({ stage: 'initialized', localSessionId: 'session-a' });
            expect(httpFixture.state.recorderReads).toBe(1);
        });

        it.each([null, 'acknowledged', {}])('refuses provided malformed attribution %j even with a matching standalone Connect', async (attribution) => {
            const connection = createCapturedNativeConnectionFixture();
            Object.defineProperty(connection, 'recipeAttribution', { value: attribution });
            httpFixture.state.recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
            expect(acquired.right).toBeUndefined();
            expect(acquired.left?.reason).toBe('connect-result-unavailable');
            expect(httpFixture.state.recorderReads).toBe(1);
        });
    });

    it('acquires a finite initialized Native scope bound to the actual admitted Connect from one recorder GET', async () => {
        const connection = createCapturedNativeConnectionFixture();
        httpFixture.state.recorderJsonl = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(httpFixture.state.recorderUrls).toEqual(['/runs/native-run/events.jsonl']);
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
                endpoint: `${httpFixture.baseUrl}/runs/native-run/events.jsonl`,
                durableOrigin: 'unknown',
                bytesRead: Buffer.byteLength(httpFixture.state.recorderJsonl),
                retainedBytes: Buffer.byteLength(httpFixture.state.recorderJsonl),
                retainedPrefixDropped: false,
                transportTruncated: false,
                malformedRows: 0,
                oversizedRows: 0,
                scanLimited: false
            }
        });
        expect(httpFixture.state.recorderReads).toBe(1);
        expect(httpFixture.state.captureEffects).toEqual(['history']);
    });

    it('binds the requested run endpoint and admits actual partial Native capture for messages.rtc', async () => {
        const connection: LiveRtcControlClient.CapturedConnection = {
            ...createCapturedNativeConnectionFixture(),
            runId: 'native/run + one',
            transport: 'messages.rtc',
            receipt: { ...createCapturedNativeConnectionFixture().receipt, nativeCoverage: 'partial' }
        };
        const rows = createNativeRecorderRowsFixture();
        rows[0].transport = 'messages.rtc';
        rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: normalizeJson(connection.receipt) } };
        httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(acquired.right?.connection).toMatchObject({ transport: 'messages.rtc', receipt: { nativeCoverage: 'partial' } });
        expect(acquired.right?.source.endpoint).toBe(`${httpFixture.baseUrl}/runs/native%2Frun%20%2B%20one/events.jsonl`);
        expect(httpFixture.state.recorderUrls).toEqual(['/runs/native%2Frun%20%2B%20one/events.jsonl']);
        expect(httpFixture.state.captureEffects).toEqual(['history']);
    });

    it('refuses an admitted unavailable Native receipt even when an initialized row was received', async () => {
        const connection: LiveRtcControlClient.CapturedConnection = {
            ...createCapturedNativeConnectionFixture(),
            receipt: {
                ...createCapturedNativeConnectionFixture().receipt,
                nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
                nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
                nativeCoverage: 'unavailable'
            }
        };
        const rows = createNativeRecorderRowsFixture();
        rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: normalizeJson(connection.receipt) } };
        httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'native-capture-unavailable', source: { durableOrigin: 'unknown', malformedRows: 0 } });
        expect(httpFixture.state.recorderReads).toBe(1);
    });

    it.each(['agentId', 'commandId', 'action', 'status', 'transport', 'connection', 'sessionId', 'receipt'])(
        'refuses a Native proof without the exact successful Connect %s',
        async (field) => {
            const rows = createNativeRecorderRowsFixture();
            if (field === 'sessionId' || field === 'receipt') {
                rows[0].actual = field === 'sessionId'
                    ? {
                        sessionId: 'previous-session',
                        rtcCapture: { status: 'observed', value: normalizeJson(createCapturedNativeConnectionFixture().receipt) }
                    }
                    : {
                        sessionId: 'session-a',
                        rtcCapture: {
                            status: 'observed',
                            value: {
                                ...normalizeJson(createCapturedNativeConnectionFixture().receipt) as LiveRtcJsonRecord,
                                connectionId: { status: 'observed', value: 'previous-connection' }
                            }
                        }
                    };
            }
            else {
                rows[0][field] = field === 'action' ? 'Connect' : 'different';
            }
            httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
            expect(acquired.right).toBeUndefined();
            expect(acquired.left).toMatchObject({ reason: 'connect-result-unavailable', connection: { sessionId: 'session-a' } });
            expect(httpFixture.state.recorderReads).toBe(1);
            expect(httpFixture.state.captureEffects).toEqual(['history']);
        }
    );

    it.each(['agent', 'session', 'scope', 'availability', 'malformed'])('refuses an initialized Native row with mismatched or invalid %s', async (field) => {
        const rows = createNativeRecorderRowsFixture();
        const row = rows[1];
        const value = row.value as LiveRtcJsonRecord;
        const payload = value.payload as LiveRtcJsonRecord;
        const event = payload.data as LiveRtcJsonRecord;
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
        httpFixture.state.recorderJsonl = rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'initialized-status-unavailable' });
        expect(JSON.stringify(acquired.left)).not.toContain('private-native-sentinel');
        if (field === 'malformed') {
            expect(acquired.left?.source?.malformedRows).toBe(1);
        }
        expect(httpFixture.state.recorderReads).toBe(1);
    });

    it('refuses an observed disposal of the same Native scope regardless of recorder order', async () => {
        const rows = createNativeRecorderRowsFixture();
        const disposed = structuredClone(rows[1]);
        const value = disposed.value as LiveRtcJsonRecord;
        const event = (value.payload as LiveRtcJsonRecord).data as LiveRtcJsonRecord;
        event.stage = 'disposed';
        event.capture = {
            scopeId: { status: 'observed', value: 'scope-a' },
            scope: 'disposed',
            ordinaryRowsSuppressed: false,
            admissionLimited: false,
            payloadLimited: false
        };
        httpFixture.state.recorderJsonl = [disposed, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { durableOrigin: 'unknown', scanLimited: false } });
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
        httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({ reason: 'native-scope-disposed', source: { malformedRows: 0 } });
        expect(httpFixture.state.recorderReads).toBe(1);
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
                                data: normalizeJson({
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
                    httpFixture.state.recorderJsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

                    const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture()).catch((error: Error) => error);

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
                    expect(httpFixture.state.recorderReads).toBe(1);
                    expect(httpFixture.state.captureEffects).toEqual(['history']);
                }
            );
        });
    });

    it('preserves bounded parse facts while ignoring another scope disposal and reordered receipt keys', async () => {
        const rows = createNativeRecorderRowsFixture();
        const connection = createCapturedNativeConnectionFixture();
        const reversedReceipt = Object.fromEntries(Object.entries(connection.receipt).reverse());
        rows[0].actual = { sessionId: 'session-a', rtcCapture: { status: 'observed', value: normalizeJson(reversedReceipt) } };
        const disposed = structuredClone(rows[1]);
        const event = ((disposed.value as LiveRtcJsonRecord).payload as LiveRtcJsonRecord).data as LiveRtcJsonRecord;
        event.stage = 'disposed';
        event.capture = {
            scopeId: { status: 'observed', value: 'previous-scope' },
            scope: 'disposed',
            ordinaryRowsSuppressed: false,
            admissionLimited: false,
            payloadLimited: false
        };
        httpFixture.state.recorderJsonl =
            ['{broken', JSON.stringify({ padding: 'x'.repeat(16_384) }), ...[disposed, ...rows].map((row) => JSON.stringify(row))].join('\n') +
            '\n';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(connection);
        expect(acquired.left).toBeUndefined();
        expect(acquired.right?.source).toMatchObject({ malformedRows: 1, oversizedRows: 1, scanLimited: false, durableOrigin: 'unknown' });
        expect(acquired.right?.initialized).toMatchObject({ stage: 'initialized', capture: { scopeId: { value: 'scope-a' } } });
    });

    it.each(['retained-prefix', 'scan-limit', 'transport-limit'])('retains honest %s recorder bounds with an acquired scope', async (bound) => {
        const serialized = createNativeRecorderRowsFixture().map((row) => JSON.stringify(row)).join('\n') + '\n';
        const padding = JSON.stringify({ padding: 'x'.repeat(4096) }) + '\n';
        httpFixture.state.recorderJsonl = bound === 'scan-limit'
            ? '{}\n'.repeat(20_001) + serialized
            : bound === 'retained-prefix'
            ? padding.repeat(2200) + serialized
            : padding.repeat(15000) + serialized + padding.repeat(2000);
        const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.left).toBeUndefined();
        expect(acquired.right?.source).toMatchObject({
            durableOrigin: 'unknown',
            malformedRows: 0,
            oversizedRows: 0,
            retainedPrefixDropped: bound !== 'scan-limit',
            transportTruncated: bound === 'transport-limit',
            scanLimited: bound === 'scan-limit'
        });
        expect(acquired.right?.source.retainedBytes).toBeLessThanOrEqual(8_388_608);
        expect(acquired.right?.source.bytesRead).toBeLessThanOrEqual(67_108_864);
        expect(httpFixture.state.recorderReads).toBe(1);
    });

    it('returns a finite recorder failure after one HTTP request without acquiring a proof', async () => {
        httpFixture.state.recorderStatus = 503;
        httpFixture.state.recorderJsonl = 'private-recorder-sentinel';
        const acquired = await httpFixture.control.readRtcNativeAcquisition(createCapturedNativeConnectionFixture());
        expect(acquired.right).toBeUndefined();
        expect(acquired.left).toMatchObject({
            reason: 'acquisition-failed',
            connection: { commandId: 'connect-native-a' },
            source: null,
            cause: expect.any(Error)
        });
        expect(acquired.left?.cause.message).toBe('RTC Native recorder unavailable.');
        expect(JSON.stringify(acquired.left)).not.toContain('private-recorder-sentinel');
        expect(httpFixture.state.recorderReads).toBe(1);
        expect(httpFixture.state.captureEffects).toEqual(['history']);
    });
});
