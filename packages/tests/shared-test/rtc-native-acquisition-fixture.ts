import type { RtcNativeCapturedConnection, RtcNativeRecipeAttribution } from '@shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts';
import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export function toFixtureJson(value: object): Record<string, ApiJsonValue> {
    return JSON.parse(JSON.stringify(value));
}

export function createCapturedNativeConnectionFixture(): RtcNativeCapturedConnection {
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

export function createNativeRecorderRowsFixture(): Record<string, ApiJsonValue>[] {
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
            actual: { sessionId: 'session-a', rtcCapture: { status: 'observed', value: toFixtureJson(createCapturedNativeConnectionFixture().receipt) } }
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

export interface RecipeNativeConnectionFixture extends RtcNativeCapturedConnection {
    readonly recipeAttribution: { -readonly [Field in keyof RtcNativeRecipeAttribution]: RtcNativeRecipeAttribution[Field]; };
}

interface RecipeConnectResultFixture {
    readonly child: Record<string, ApiJsonValue>;
    readonly value: Record<string, ApiJsonValue>;
}

interface RecipeNativeRecorderFixture extends RecipeConnectResultFixture {
    readonly root: Record<string, ApiJsonValue>;
    readonly actual: Record<string, ApiJsonValue>;
    readonly invocation: Record<string, ApiJsonValue>;
    readonly initialized: Record<string, ApiJsonValue>;
}

export function createRecipeNativeConnectionFixture(): RecipeNativeConnectionFixture {
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
    const value: Record<string, ApiJsonValue> = {
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
        rtcCapture: { status: 'observed', value: toFixtureJson(connection.receipt) }
    };
    const child: Record<string, ApiJsonValue> = {
        commandId: 'connect-native-a',
        kind: 'rtc.connect',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 100,
        endedAtEpochMs: 110,
        durationMs: 10,
        value
    } satisfies RallarBlackBoxTestResult<Record<string, ApiJsonValue>>;
    return { child, value };
}

export function createRawRecipeNativeRecorderFixture(connection: RecipeNativeConnectionFixture): RecipeNativeRecorderFixture {
    const { child, value } = createRecipeConnectResultFixture(connection);
    const invocation: Record<string, ApiJsonValue> = {
        invocationId: 'acknowledged-native-invocation',
        recipeBodyId: 'acknowledged-native-body'
    };
    const actual: Record<string, ApiJsonValue> = {
        recipeId: 'declared-native-recipe',
        invocation,
        results: [child]
    };
    const root: Record<string, ApiJsonValue> = {
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

export function createCompactedRecipeNativeRecorderFixture(connection: RecipeNativeConnectionFixture): RecipeNativeRecorderFixture {
    const fixture = createRawRecipeNativeRecorderFixture(connection);
    const actual: Record<string, ApiJsonValue> = {
        ...fixture.actual,
        resultCount: 1,
        failureCount: 0,
        resultEvidence: { status: 'finite', payloadsOmitted: true }
    };
    return { ...fixture, actual, root: { ...fixture.root, actual } };
}

export function createNativeAcquisitionSnapshotFixture(capture: RtcSignalingDiagnostics.CaptureStatus): RtcSignalingDiagnostics.NativeSnapshot {
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
