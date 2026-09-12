import type { JSHandle, Page } from '@playwright/test';

import type { AlmConformanceCarrier } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { NativeIndexedDbTimingSnapshot } from './browser-native-indexeddb-timing-recorder.ts';

export type AlmNativeObservationRole = 'sender' | 'receiver';
export type AlmNativeObservationScope = 'smoke' | 'full';
export type AlmNativeObservationFailureStage =
    | 'start'
    | 'measurement-end'
    | 'stop'
    | 'snapshot'
    | 'methods-restored'
    | 'dispose';
export type AlmNativeObservationStepFailureStage = 'write' | 'control-observation';

export interface AlmNativeObservationParticipant {
    readonly role: AlmNativeObservationRole;
    readonly agentId: string;
    readonly page: Page;
}

export interface AlmNativeObservationFailure {
    readonly role: AlmNativeObservationRole;
    readonly stage: AlmNativeObservationFailureStage;
    readonly name: string;
}

export interface AlmNativeParticipantObservation {
    readonly role: AlmNativeObservationRole;
    readonly agentId: string;
    readonly pageTimeOriginEpochMs: number | null;
    readonly measurementStartedAtMs: number | null;
    readonly measurementEndedAtMs: number | null;
    readonly nativeTiming: NativeIndexedDbTimingSnapshot | null;
    readonly methodsRestored: boolean | null;
}

export interface AlmNativeObservationSourceLabels {
    readonly runtime: string;
    readonly instrumentation: string;
    readonly servedSourceIdentity: 'unverified';
}

export interface AlmNativeObservationSourceLabelInput {
    readonly runtime: string | undefined;
    readonly instrumentation: string | undefined;
}

export interface AlmNativeObservationEnvironment {
    readonly nodeVersion: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly apiMode: string;
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly configuredWorkerLimit: number;
}

export interface AlmNativeObservationStepFailure {
    readonly stage: AlmNativeObservationStepFailureStage;
    readonly name: string;
}

export interface AlmNativeObservationArtifact {
    readonly schema: 'rallar.alm-conformance-native-indexeddb-observation.v1';
    readonly runId: string;
    readonly carrier: AlmConformanceCarrier;
    readonly scope: AlmNativeObservationScope;
    readonly retry: number;
    readonly databaseName: string;
    readonly sourceLabels: AlmNativeObservationSourceLabels;
    readonly environment: AlmNativeObservationEnvironment;
    readonly participants: readonly AlmNativeParticipantObservation[];
    readonly failures: readonly AlmNativeObservationFailure[];
}

export interface AlmNativeObservationLifecycleInput {
    readonly runId: string;
    readonly carrier: AlmConformanceCarrier;
    readonly scope: AlmNativeObservationScope;
    readonly retry: number;
    readonly databaseName: string;
    readonly sampleCapacity: number;
    readonly recorderModuleUrl: string;
    readonly sourceLabels: AlmNativeObservationSourceLabelInput;
    readonly environment: AlmNativeObservationEnvironment;
    readonly participants: readonly [AlmNativeObservationParticipant, AlmNativeObservationParticipant];
    readonly runScenario: () => Promise<void>;
    readonly writeNativeObservation: (artifact: AlmNativeObservationArtifact) => Promise<void>;
    readonly recordControlObservation: (scenarioFailed: boolean) => Promise<void>;
    readonly reportObservationFailure: (failure: AlmNativeObservationStepFailure) => void;
    readonly closeRun: () => Promise<void>;
}

interface AlmNativePageCaptureState {
    readonly recorder: import('./browser-native-indexeddb-timing-recorder.ts').NativeIndexedDbTimingRecorder;
    readonly pageTimeOriginEpochMs: number;
    readonly measurementStartedAtMs: number;
}

interface ActiveAlmNativeObservation {
    readonly participant: AlmNativeObservationParticipant;
    readonly handle: JSHandle<AlmNativePageCaptureState>;
}

interface AlmNativeObservationSession {
    readonly active: ActiveAlmNativeObservation[];
    readonly observations: AlmNativeParticipantObservation[];
    readonly failures: AlmNativeObservationFailure[];
}

interface StartAlmNativePageObservationInput {
    readonly participant: AlmNativeObservationParticipant;
    readonly sampleCapacity: number;
    readonly databaseName: string;
    readonly recorderModuleUrl: string;
}

interface ReadAlmNativeHandleValueInput<T> {
    readonly role: AlmNativeObservationRole;
    readonly stage: AlmNativeObservationFailureStage;
    readonly failures: AlmNativeObservationFailure[];
    readonly read: () => Promise<T>;
}

export async function runAlmNativeObservationLifecycle(
    input: AlmNativeObservationLifecycleInput
): Promise<void> {
    const session = await startAlmNativeObservation(input);
    let scenarioFailed = false;
    let scenarioError: Error | undefined;
    let closeFailed = false;
    let closeError: Error | undefined;
    try {
        await input.runScenario();
    }
    catch (error) {
        scenarioFailed = true;
        scenarioError = error instanceof Error ? error : new Error(String(error));
    }
    finally {
        const artifact = await stopAlmNativeObservation(input, session);
        await runNonAuthoritativeObservationStep(
            'write',
            () => input.writeNativeObservation(artifact),
            input.reportObservationFailure
        );
        await runNonAuthoritativeObservationStep(
            'control-observation',
            () => input.recordControlObservation(scenarioFailed),
            input.reportObservationFailure
        );
        try {
            await input.closeRun();
        }
        catch (error) {
            closeFailed = true;
            closeError = error instanceof Error ? error : new Error(String(error));
        }
    }
    if (scenarioFailed) {
        throw scenarioError;
    }
    if (closeFailed) {
        throw closeError;
    }
}

async function startAlmNativeObservation(
    input: AlmNativeObservationLifecycleInput
): Promise<AlmNativeObservationSession> {
    const session: AlmNativeObservationSession = { active: [], observations: [], failures: [] };
    for (const participant of input.participants) {
        try {
            session.active.push(
                await startAlmNativePageObservation({
                    participant,
                    sampleCapacity: input.sampleCapacity,
                    databaseName: input.databaseName,
                    recorderModuleUrl: input.recorderModuleUrl
                })
            );
        }
        catch (error) {
            const startError = error instanceof Error ? error : new Error(String(error));
            session.failures.push(toAlmNativeObservationFailure(participant.role, 'start', startError));
        }
    }
    if (session.failures.some((failure) => failure.stage === 'start')) {
        await stopActiveAlmNativeObservations(session);
    }
    return session;
}

async function startAlmNativePageObservation(
    input: StartAlmNativePageObservationInput
): Promise<ActiveAlmNativeObservation> {
    const handle = await input.participant.page.evaluateHandle<AlmNativePageCaptureState, {
        readonly sampleCapacity: number;
        readonly databaseName: string;
        readonly recorderModuleUrl: string;
    }>(async (capture) => {
        const timing: typeof import('./browser-native-indexeddb-timing-recorder.ts') = await import(
            capture.recorderModuleUrl
        );
        const recorder = new timing.NativeIndexedDbTimingRecorder(
            capture.sampleCapacity,
            capture.databaseName
        );
        recorder.start();
        return {
            recorder,
            pageTimeOriginEpochMs: performance.timeOrigin,
            measurementStartedAtMs: performance.now()
        };
    }, {
        sampleCapacity: input.sampleCapacity,
        databaseName: input.databaseName,
        recorderModuleUrl: input.recorderModuleUrl
    });
    return { participant: input.participant, handle };
}

async function stopAlmNativeObservation(
    input: AlmNativeObservationLifecycleInput,
    session: AlmNativeObservationSession
): Promise<AlmNativeObservationArtifact> {
    await stopActiveAlmNativeObservations(session);
    const participants = input.participants.map((participant) =>
        session.observations.find((observation) => observation.role === participant.role) ??
            toEmptyParticipantObservation(participant)
    );
    return {
        schema: 'rallar.alm-conformance-native-indexeddb-observation.v1',
        runId: input.runId,
        carrier: input.carrier,
        scope: input.scope,
        retry: input.retry,
        databaseName: input.databaseName,
        sourceLabels: toAlmNativeObservationSourceLabels(input.sourceLabels),
        environment: input.environment,
        participants,
        failures: [...session.failures]
    };
}

async function stopActiveAlmNativeObservations(session: AlmNativeObservationSession): Promise<void> {
    const active = session.active.splice(0);
    for (const observation of active) {
        session.observations.push(await stopAlmNativePageObservation(observation, session.failures));
    }
}

async function stopAlmNativePageObservation(
    active: ActiveAlmNativeObservation,
    failures: AlmNativeObservationFailure[]
): Promise<AlmNativeParticipantObservation> {
    const { participant, handle } = active;
    const pageTimeOriginEpochMs = await readAlmNativeHandleValue({
        role: participant.role,
        stage: 'measurement-end',
        failures,
        read: async () => await handle.evaluate((capture) => capture.pageTimeOriginEpochMs)
    });
    const measurementStartedAtMs = await readAlmNativeHandleValue({
        role: participant.role,
        stage: 'measurement-end',
        failures,
        read: async () => await handle.evaluate((capture) => capture.measurementStartedAtMs)
    });
    const measurementEndedAtMs = await readAlmNativeHandleValue({
        role: participant.role,
        stage: 'measurement-end',
        failures,
        read: async () => await handle.evaluate(() => performance.now())
    });
    await readAlmNativeHandleValue({
        role: participant.role,
        stage: 'stop',
        failures,
        read: async () =>
            await handle.evaluate((capture) => {
                capture.recorder.stop();
                return true;
            })
    });
    const nativeTiming = await readAlmNativeHandleValue({
        role: participant.role,
        stage: 'snapshot',
        failures,
        read: async () => await handle.evaluate((capture) => capture.recorder.snapshot())
    });
    const methodsRestored = await readAlmNativeHandleValue({
        role: participant.role,
        stage: 'methods-restored',
        failures,
        read: async () => await handle.evaluate((capture) => capture.recorder.methodsRestored)
    });
    await disposeAlmNativePageObservationHandle(active, failures);
    return {
        role: participant.role,
        agentId: participant.agentId,
        pageTimeOriginEpochMs,
        measurementStartedAtMs,
        measurementEndedAtMs,
        nativeTiming,
        methodsRestored
    };
}

async function disposeAlmNativePageObservationHandle(
    active: ActiveAlmNativeObservation,
    failures: AlmNativeObservationFailure[]
): Promise<void> {
    try {
        await active.handle.dispose();
    }
    catch (error) {
        const disposeError = error instanceof Error ? error : new Error(String(error));
        failures.push(toAlmNativeObservationFailure(active.participant.role, 'dispose', disposeError));
    }
}

async function readAlmNativeHandleValue<T>(input: ReadAlmNativeHandleValueInput<T>): Promise<T | null> {
    try {
        return await input.read();
    }
    catch (error) {
        const readError = error instanceof Error ? error : new Error(String(error));
        input.failures.push(toAlmNativeObservationFailure(input.role, input.stage, readError));
        return null;
    }
}

function toEmptyParticipantObservation(
    participant: AlmNativeObservationParticipant
): AlmNativeParticipantObservation {
    return {
        role: participant.role,
        agentId: participant.agentId,
        pageTimeOriginEpochMs: null,
        measurementStartedAtMs: null,
        measurementEndedAtMs: null,
        nativeTiming: null,
        methodsRestored: null
    };
}

function toAlmNativeObservationFailure(
    role: AlmNativeObservationRole,
    stage: AlmNativeObservationFailureStage,
    error: Error
): AlmNativeObservationFailure {
    return {
        role,
        stage,
        name: error.name.length > 0 ? error.name.slice(0, 80) : 'Error'
    };
}

function toAlmNativeObservationSourceLabels(
    sourceLabels: AlmNativeObservationSourceLabelInput
): AlmNativeObservationSourceLabels {
    return {
        runtime: sourceLabels.runtime?.trim() || 'working-tree',
        instrumentation: sourceLabels.instrumentation?.trim() || 'working-tree',
        servedSourceIdentity: 'unverified'
    };
}

async function runNonAuthoritativeObservationStep(
    stage: AlmNativeObservationStepFailureStage,
    operation: () => Promise<void>,
    reportFailure: (failure: AlmNativeObservationStepFailure) => void
): Promise<void> {
    try {
        await operation();
    }
    catch (error) {
        const observationError = error instanceof Error ? error : new Error(String(error));
        reportFailure({
            stage,
            name: observationError.name.length > 0 ? observationError.name.slice(0, 80) : 'Error'
        });
    }
}
