import { expect } from '@playwright/test';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    resolveRequiredRtcCaptureFailure,
    toBrowserRtcCaptureIntent
} from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import { readLiveRtcAgentApiUrls } from './live-rtc-agent-environment.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    stringArrayValue,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';
import type { LiveRtcFormationOperations } from './live-rtc-formation-operations.ts';

type TransportUnderTest = 'realtime' | 'messages.rtc';
type AgentPrefix = 'A' | 'B' | 'C';
type ReadinessScope = 'owner' | 'all';
type FormationEntryLifecycleState = 'forming' | 'active';

interface CreateGroupFormationLifecycleDriverConfig {
    readonly apiBaseUrl: string | undefined;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly messagesRtcTypeId: string;
    readonly messagesRtcTopicId: string;
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
    readonly formation: Pick<LiveRtcFormationOperations, 'readiness'>;
}

interface RunGroupFormationLifecycleInput {
    readonly control: LiveRtcControlPort;
    readonly nativeAcquisition?: LiveRtcControlClient.NativeAcquisition;
    readonly runId: string;
    readonly agents: readonly [
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent
    ];
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
    readonly readinessScope: ReadinessScope;
}

interface GroupFormationLifecycleRun {
    readonly commandIds: readonly string[];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly readinessDurations: Readonly<Partial<Record<AgentPrefix, number>>>;
    readonly rtcConnectCaptures: readonly LiveRtcControlClient.CapturedConnection[];
    readonly nativeAcquisitions: readonly LiveRtcControlClient.NativeAcquisitionProof[];
}

interface ReconnectFormationAgentInput {
    readonly control: LiveRtcControlPort;
    readonly nativeAcquisition?: LiveRtcControlClient.NativeAcquisition;
    readonly runId: string;
    readonly reconnectingAgent: LiveRtcControlClient.FormationAgent;
    readonly survivingAgents: readonly [
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent
    ];
    readonly survivingSessionIds: readonly [string, string];
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

export interface GroupFormationLifecycleDriver {
    setupGroupMembership(
        input: SetupGroupMembershipInput
    ): Promise<readonly string[]>;
    run(
        input: RunGroupFormationLifecycleInput
    ): Promise<GroupFormationLifecycleRun>;
    reconnectAndWaitForPeerReadiness(
        input: ReconnectFormationAgentInput
    ): Promise<ReconnectedFormationAgent>;
}

export interface LiveRtcControlPort extends
    Pick<
        LiveRtcControlClient,
        | 'executeOk'
        | 'executeResult'
        | 'resultValue'
        | 'requireSessionId'
        | 'waitForPeerReadiness'
        | 'waitForPeerAbsence'
        | 'waitForMessage'
        | 'readyPeerIds'
    > {}

/**
 * The policy every live three-browser group is created with. The driver commands each boundary
 * itself, so the stage triggers would dial the layout before it does; the admission and activation
 * modes are part of the same literal and moving either changes what the matrix exercises.
 */
export const MANUAL_TRIGGER_POLICY = {
    preset: 'managed',
    admission: {
        mode: 'open'
    },
    activation: {
        mode: 'manual'
    },
    establishment: {
        planTrigger: { kind: 'manual' },
        connectTrigger: { kind: 'manual' }
    }
};

export interface SetupGroupMembershipInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly owner: LiveRtcControlClient.FormationAgent;
    readonly members: readonly LiveRtcControlClient.FormationAgent[];
    readonly groupId: string;
    readonly suffix: string;
    /** The policy the group is created with; the matrix's own literal when omitted. */
    readonly lifecyclePolicy?: typeof MANUAL_TRIGGER_POLICY;
}

interface ConnectFormationAgentInput {
    readonly control: LiveRtcControlPort;
    readonly nativeAcquisition?: LiveRtcControlClient.NativeAcquisition;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.FormationAgent;
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

interface FormationAgentConnection {
    readonly commandId: string;
    readonly sessionId: string;
    /** Absent when the operation did not explicitly request diagnostics. */
    readonly rtcCapture?: LiveRtcControlClient.CapturedConnection;
    /** Present only after this connection's specific acquisition completed. */
    readonly nativeAcquisition?: LiveRtcControlClient.NativeAcquisitionProof;
}

interface InitialFormationPair {
    readonly connections: readonly [FormationAgentConnection, FormationAgentConnection];
    readonly presenceCommandIds: readonly string[];
    readonly commandIds: readonly string[];
}

interface InitialPairPeerReadinessInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly connections: readonly [FormationAgentConnection, FormationAgentConnection];
    readonly suffix: string;
    readonly startedAtMs: number;
}

type FormationCaptureDecoding = Either<
    RallarRtcCaptureUnverifiedError.Reason,
    RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>
>;

interface ReconnectedFormationAgent extends FormationAgentConnection {
    readonly receiverReadinessDurationMs: number;
}

interface FormationConnections {
    readonly connectResults: readonly [
        FormationAgentConnection,
        FormationAgentConnection,
        FormationAgentConnection
    ];
    readonly presenceCommandIds: readonly string[];
    readonly initialPairCommandIds: readonly string[];
    readonly readinessStartedAtMs: number;
}

interface ConnectedGroupLifecycle {
    readonly commandIds: readonly string[];
    readonly readinessDurations: Readonly<Partial<Record<AgentPrefix, number>>>;
}

interface ConnectGroupLifecycleInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly lifecycleSuffix: string;
}

interface LifecycleStageReceipt {
    readonly commandIds: readonly string[];
    readonly formationEpoch: number;
    readonly groupRevision: number;
}

interface PublishedGroupLayout {
    readonly commandIds: readonly string[];
    readonly identity: GroupLayoutIdentity;
}

interface ActivePublishedLayout {
    readonly sessionIds: readonly string[];
    readonly identity: GroupLayoutIdentity;
}

interface GroupLifecycleCommandInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly owner: LiveRtcControlClient.FormationAgent;
    readonly groupId: string;
    readonly suffix: string;
}

interface ActivateGroupInput extends GroupLifecycleCommandInput {
    readonly transport: TransportUnderTest;
}

interface WaitForPlannedLayoutInput extends GroupLifecycleCommandInput {
    readonly expectedSessionIds: readonly string[];
    readonly expectedFormationEpoch: number;
    readonly minimumGroupRevision: number;
}

interface WaitForActiveSessionsInput extends GroupLifecycleCommandInput {
    readonly expectedSessionIds: readonly string[];
}

interface WaitForFormationReadinessInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly suffix: string;
    readonly startedAtMs: number;
}

interface WaitForCanonicalFormationReadinessInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.FormationAgent;
    readonly roomRef: GroupRef;
    readonly expectedPeerIds: readonly string[];
    readonly suffix: string;
    readonly startedAtMs: number;
}

export namespace LiveRtcFormationFailure {
    export interface Input {
        readonly cause: Error;
        readonly rtcConnectCaptures: readonly LiveRtcControlClient.CapturedConnection[];
        readonly nativeAcquisitions: readonly LiveRtcControlClient.NativeAcquisitionProof[];
        readonly nativeAcquisitionFailure: LiveRtcControlClient.NativeAcquisitionFailure | null;
    }
}

/** Completed diagnostic facts survive a later formation or delivery failure. */
export class LiveRtcFormationFailure extends Error {
    readonly rtcConnectCaptures: readonly LiveRtcControlClient.CapturedConnection[];
    readonly nativeAcquisitions: readonly LiveRtcControlClient.NativeAcquisitionProof[];
    readonly nativeAcquisitionFailure: LiveRtcControlClient.NativeAcquisitionFailure | null;

    constructor(input: LiveRtcFormationFailure.Input) {
        super(input.cause.message, { cause: input.cause });
        this.name = 'LiveRtcFormationFailure';
        this.rtcConnectCaptures = input.rtcConnectCaptures;
        this.nativeAcquisitions = input.nativeAcquisitions;
        this.nativeAcquisitionFailure = input.nativeAcquisitionFailure;
    }
}

export function retainLiveRtcFormationFailure(input: LiveRtcFormationFailure.Input): Error {
    const previous = input.cause instanceof LiveRtcFormationFailure ? input.cause : undefined;
    const rtcConnectCaptures = [...input.rtcConnectCaptures, ...(previous?.rtcConnectCaptures ?? [])];
    if (rtcConnectCaptures.length === 0 && previous === undefined) {
        return input.cause;
    }
    return new LiveRtcFormationFailure({
        cause: previous === undefined ? input.cause : toError(previous.cause),
        rtcConnectCaptures,
        nativeAcquisitions: [...input.nativeAcquisitions, ...(previous?.nativeAcquisitions ?? [])],
        nativeAcquisitionFailure: previous?.nativeAcquisitionFailure ?? input.nativeAcquisitionFailure
    });
}

function retainConnectionFailure(failure: Error, connections: readonly FormationAgentConnection[]): Error {
    return retainLiveRtcFormationFailure({
        cause: failure,
        rtcConnectCaptures: connections.flatMap((connection) => connection.rtcCapture ? [connection.rtcCapture] : []),
        nativeAcquisitions: connections.flatMap((connection) =>
            connection.nativeAcquisition ? [connection.nativeAcquisition] : []
        ),
        nativeAcquisitionFailure: null
    });
}

export function createGroupFormationLifecycleDriver(
    config: CreateGroupFormationLifecycleDriverConfig
): GroupFormationLifecycleDriver {
    return {
        setupGroupMembership: (input) => setupGroupMembership(config, input),
        run: async (input) => await runGroupFormationLifecycle(config, input),
        reconnectAndWaitForPeerReadiness: async (input) => await reconnectFormationAgent(config, input)
    };
}

async function reconnectFormationAgent(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ReconnectFormationAgentInput
): Promise<ReconnectedFormationAgent> {
    const startedAtMs = performance.now();
    const connection = await connectFormationAgent(config, {
        control: input.control,
        nativeAcquisition: input.nativeAcquisition,
        runId: input.runId,
        agent: input.reconnectingAgent,
        transport: input.transport,
        groupId: input.groupId,
        suffix: input.suffix
    });
    try {
        const [firstReceiverDurationMs, secondReceiverDurationMs] = await Promise.all(
            [
                waitForCanonicalFormationReadiness(config, {
                    control: input.control,
                    runId: input.runId,
                    agent: input.survivingAgents[0],
                    roomRef: toGroupRef(config, input.groupId),
                    expectedPeerIds: [input.survivingSessionIds[1], connection.sessionId],
                    suffix: input.suffix,
                    startedAtMs
                }),
                waitForCanonicalFormationReadiness(config, {
                    control: input.control,
                    runId: input.runId,
                    agent: input.survivingAgents[1],
                    roomRef: toGroupRef(config, input.groupId),
                    expectedPeerIds: [input.survivingSessionIds[0], connection.sessionId],
                    suffix: input.suffix,
                    startedAtMs
                }),
                waitForCanonicalFormationReadiness(config, {
                    control: input.control,
                    runId: input.runId,
                    agent: input.reconnectingAgent,
                    roomRef: toGroupRef(config, input.groupId),
                    expectedPeerIds: input.survivingSessionIds,
                    suffix: `${input.suffix}-settled`,
                    startedAtMs
                })
            ]
        );
        return {
            ...connection,
            receiverReadinessDurationMs: Math.max(
                firstReceiverDurationMs,
                secondReceiverDurationMs
            )
        };
    }
    catch (failure) {
        throw retainConnectionFailure(toError(failure), [connection]);
    }
}

async function runGroupFormationLifecycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput
): Promise<GroupFormationLifecycleRun> {
    const formationConnections = await connectFormationAgents(config, input);
    try {
        const sessions: Readonly<Record<AgentPrefix, string>> = {
            A: formationConnections.connectResults[0].sessionId,
            B: formationConnections.connectResults[1].sessionId,
            C: formationConnections.connectResults[2].sessionId
        };
        expect(new Set(Object.values(sessions)).size).toBe(3);

        const lifecycleSuffix = `${input.transport.replace('.', '-')}-${input.suffix}${
            input.readinessScope === 'all' ? '-all' : ''
        }`;
        const lifecycle = await connectGroupLifecycle(config, {
            run: input,
            sessions,
            lifecycleSuffix,
            readinessStartedAtMs: formationConnections.readinessStartedAtMs
        });
        return {
            commandIds: [
                ...formationConnections.connectResults.map((result) => result.commandId),
                ...formationConnections.presenceCommandIds,
                ...formationConnections.initialPairCommandIds,
                ...lifecycle.commandIds
            ],
            sessions,
            readinessDurations: lifecycle.readinessDurations,
            rtcConnectCaptures: formationConnections.connectResults.flatMap((connection) =>
                connection.rtcCapture ? [connection.rtcCapture] : []
            ),
            nativeAcquisitions: formationConnections.connectResults.flatMap((connection) =>
                connection.nativeAcquisition ? [connection.nativeAcquisition] : []
            )
        };
    }
    catch (failure) {
        throw retainConnectionFailure(toError(failure), formationConnections.connectResults);
    }
}

async function connectGroupLifecycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input:
        & ConnectGroupLifecycleInput
        & Readonly<{ readinessStartedAtMs: number; }>
): Promise<ConnectedGroupLifecycle> {
    const owner = input.run.agents[0];
    const topologyCommandId = await configureMeshTopology(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const stageReceipt = await enterGroupConnectionCycle(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const plannedLayout = await waitForPlannedLayout(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix,
        expectedSessionIds: Object.values(input.sessions),
        expectedFormationEpoch: stageReceipt.formationEpoch,
        minimumGroupRevision: stageReceipt.groupRevision
    });
    const connectCommandId = await connectPublishedLayout(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix,
        expectedFormationEpoch: stageReceipt.formationEpoch,
        expectedLayout: plannedLayout.identity
    });
    const activateCommandId = await activateGroup(config, {
        ...input.run,
        owner
    });
    const readinessDurations = await waitForFormationReadiness(config, {
        run: input.run,
        sessions: input.sessions,
        suffix: `${input.lifecycleSuffix}-activated`,
        startedAtMs: input.readinessStartedAtMs
    });

    return {
        commandIds: [
            topologyCommandId,
            ...stageReceipt.commandIds,
            ...plannedLayout.commandIds,
            connectCommandId,
            activateCommandId
        ],
        readinessDurations
    };
}

async function connectFormationAgents(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput
): Promise<FormationConnections> {
    const connectA = await connectFormationAgent(config, { ...input, agent: input.agents[0] });
    let pair: InitialFormationPair;
    try {
        pair = await connectFormationPair(config, input, connectA);
    }
    catch (failure) {
        throw retainConnectionFailure(toError(failure), [connectA]);
    }
    try {
        return await connectThirdFormationAgent(config, input, pair);
    }
    catch (failure) {
        throw retainConnectionFailure(toError(failure), pair.connections);
    }
}

async function connectFormationPair(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput,
    connectA: FormationAgentConnection
): Promise<InitialFormationPair> {
    const owner = input.agents[0];
    const presenceA = await waitForActiveSessions(config, {
        ...input,
        owner,
        expectedSessionIds: [connectA.sessionId]
    });
    const connectB = await connectFormationAgent(config, { ...input, agent: input.agents[1] });
    try {
        const presenceB = await waitForActiveSessions(config, {
            ...input,
            owner,
            expectedSessionIds: [connectA.sessionId, connectB.sessionId]
        });
        const commandIds = await connectInitialPair(config, input, [connectA, connectB]);
        return { connections: [connectA, connectB], presenceCommandIds: [...presenceA, ...presenceB], commandIds };
    }
    catch (failure) {
        throw retainConnectionFailure(toError(failure), [connectB]);
    }
}

async function connectThirdFormationAgent(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput,
    pair: InitialFormationPair
): Promise<FormationConnections> {
    const readinessStartedAtMs = performance.now();
    const connectC = await connectFormationAgent(config, { ...input, agent: input.agents[2] });
    try {
        const presenceC = await waitForActiveSessions(config, {
            ...input,
            owner: input.agents[0],
            expectedSessionIds: [...pair.connections.map((connection) => connection.sessionId), connectC.sessionId]
        });
        return {
            connectResults: [...pair.connections, connectC],
            presenceCommandIds: [...pair.presenceCommandIds, ...presenceC],
            initialPairCommandIds: pair.commandIds,
            readinessStartedAtMs
        };
    }
    catch (failure) {
        throw retainConnectionFailure(toError(failure), [connectC]);
    }
}

async function connectInitialPair(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput,
    connections: readonly [FormationAgentConnection, FormationAgentConnection]
): Promise<readonly string[]> {
    const owner = input.agents[0];
    const agents = [owner, input.agents[1]] as const;
    const suffix = `${input.transport.replace('.', '-')}-${input.suffix}-initial-pair`;
    const lifecycle = { ...input, owner, suffix };
    const topologyCommandId = await configureMeshTopology(config, lifecycle);
    const stageReceipt = await enterGroupConnectionCycle(config, lifecycle);
    const plannedLayout = await waitForPlannedLayout(config, {
        ...lifecycle,
        expectedSessionIds: connections.map(({ sessionId }) => sessionId),
        expectedFormationEpoch: stageReceipt.formationEpoch,
        minimumGroupRevision: stageReceipt.groupRevision
    });
    const connectCommandId = await connectPublishedLayout(config, {
        ...lifecycle,
        expectedFormationEpoch: stageReceipt.formationEpoch,
        expectedLayout: plannedLayout.identity
    });
    const startedAtMs = performance.now();
    await waitForInitialPairPeerReadiness({ run: input, connections, suffix, startedAtMs });
    const activateCommandId = await activateGroup(config, {
        ...lifecycle,
        transport: input.transport
    });
    await Promise.all(
        agents.map(
            async (agent, index) =>
                await waitForCanonicalFormationReadiness(config, {
                    control: input.control,
                    runId: input.runId,
                    agent,
                    roomRef: toGroupRef(config, input.groupId),
                    expectedPeerIds: [connections[index === 0 ? 1 : 0].sessionId],
                    suffix: `${suffix}-activated`,
                    startedAtMs
                })
        )
    );
    return [
        topologyCommandId,
        ...stageReceipt.commandIds,
        ...plannedLayout.commandIds,
        connectCommandId,
        activateCommandId
    ];
}

async function waitForInitialPairPeerReadiness(input: InitialPairPeerReadinessInput): Promise<void> {
    await Promise.all(
        input.run.agents.slice(0, 2).map(async (agent, index) =>
            await input.run.control.waitForPeerReadiness({
                runId: input.run.runId,
                agent,
                expectedPeerIds: [input.connections[index === 0 ? 1 : 0].sessionId],
                suffix: input.suffix,
                startedAtMs: input.startedAtMs
            })
        )
    );
}

async function connectFormationAgent(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ConnectFormationAgentInput
): Promise<FormationAgentConnection> {
    const transport = input.transport.replace('.', '-');
    const commandId = `connect-${input.agent.prefix.toLowerCase()}-${transport}-${input.suffix}`;
    const captureIntent = toBrowserRtcCaptureIntent({ rtcCaptureMode: config.rtcCaptureMode });
    const acquisition = input.nativeAcquisition;
    if (
        acquisition !== undefined &&
        (captureIntent.connectionIntent !== 'explicit' || captureIntent.requestedConfiguration.mode !== 'native')
    ) {
        throw new Error('Native acquisition requires an explicit Native capture request.');
    }
    const command = toFormationConnectCommand(config, input, captureIntent.options);
    const execution = {
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId,
        command,
        timeoutMs: 60_000
    };
    const result = await input.control.executeOk(execution);
    if (captureIntent.connectionIntent !== 'explicit') {
        return { commandId, sessionId: input.control.requireSessionId(result, commandId) };
    }
    const receipt = requireFormationCaptureReceipt(
        captureIntent.requestedConfiguration,
        input.control.resultValue(result).rtcCapture
    );
    const sessionId = input.control.requireSessionId(result, commandId);
    const rtcCapture: LiveRtcControlClient.CapturedConnection = {
        runId: execution.runId,
        agentId: execution.agentId,
        commandId,
        connection: command.connection,
        transport: command.transport,
        sessionId,
        requestedConfiguration: captureIntent.requestedConfiguration,
        receipt
    };
    const nativeAcquisition = acquisition === undefined
        ? undefined
        : await acquireFormationNativeCapture(acquisition, rtcCapture);
    return { commandId, sessionId, rtcCapture, ...(nativeAcquisition === undefined ? {} : { nativeAcquisition }) };
}

function toFormationConnectCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ConnectFormationAgentInput,
    captureOptions: ReturnType<typeof toBrowserRtcCaptureIntent>['options']
): RallarBlackBoxTestRtcConnectCommand & { readonly connection: string; readonly transport: TransportUnderTest; } {
    return {
        kind: 'rtc.connect',
        connection: `${input.agent.connection}-${input.transport.replace('.', '-')}`,
        actor: input.agent.actor,
        roomId: input.groupId,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        roomRef: toGroupRef(config, input.groupId),
        transport: input.transport,
        rallar: {
            ...captureOptions,
            apiBaseUrl: readLiveRtcAgentApiUrls(config.apiBaseUrl)[input.agent.prefix],
            restoreSession: true,
            logoutOnClose: false,
            leaveRoomOnClose: false,
            ...(input.transport === 'messages.rtc'
                ? { typeId: config.messagesRtcTypeId, topicId: config.messagesRtcTopicId }
                : {})
        },
        timeoutMs: 45_000
    };
}

function requireFormationCaptureReceipt(
    requested: RtcSignalingDiagnostics.CaptureConfiguration,
    value: RtcBaselineJson | undefined
): RtcSignalingDiagnostics.CaptureReceipt {
    const decoded = toFormationCaptureReadout(value);
    const rtcCapture = decoded.right ?? { status: 'unavailable' as const, reason: 'unrecognized' as const };
    const reason = decoded.left ?? resolveRequiredRtcCaptureFailure(requested, rtcCapture);
    if (reason !== undefined || rtcCapture.status !== 'observed') {
        throw new RallarRtcCaptureUnverifiedError({
            requestedConfiguration: requested,
            rtcCapture,
            reason: reason ?? 'receipt-unavailable'
        });
    }
    return rtcCapture.value;
}

async function acquireFormationNativeCapture(
    acquisition: LiveRtcControlClient.NativeAcquisition,
    connection: LiveRtcControlClient.CapturedConnection
): Promise<LiveRtcControlClient.NativeAcquisitionProof> {
    const receipt = connection.receipt;
    if (
        receipt.nativeScopeId.status !== 'observed' || receipt.nativeScopeId.value.length === 0 ||
        receipt.nativeAvailability.status !== 'observed' ||
        (receipt.nativeCoverage !== 'attached' && receipt.nativeCoverage !== 'partial')
    ) {
        throw nativeFormationAcquisitionFailure({
            reason: 'native-capture-unavailable',
            connection,
            source: null,
            cause: new Error('The admitted connection has no available Native capture scope.')
        }, connection);
    }
    let result: Either<LiveRtcControlClient.NativeAcquisitionFailure, LiveRtcControlClient.NativeAcquisitionProof>;
    try {
        result = await acquisition.readRtcNativeAcquisition(connection);
    }
    catch (cause) {
        throw nativeFormationAcquisitionFailure(
            { reason: 'acquisition-failed', connection, source: null, cause: toError(cause) },
            connection
        );
    }
    return result.fold(
        (failure) => {
            throw nativeFormationAcquisitionFailure(failure, connection);
        },
        (proof) => proof
    );
}

function nativeFormationAcquisitionFailure(
    failure: LiveRtcControlClient.NativeAcquisitionFailure,
    connection: LiveRtcControlClient.CapturedConnection
): LiveRtcFormationFailure {
    return new LiveRtcFormationFailure({
        cause: failure.cause,
        rtcConnectCaptures: [connection],
        nativeAcquisitions: [],
        nativeAcquisitionFailure: failure
    });
}

function toFormationCaptureReadout(value: RtcBaselineJson | undefined): FormationCaptureDecoding {
    if (value === undefined) {
        return Either.ofRight({ status: 'unavailable', reason: 'absent' });
    }
    const readout = jsonRecord(value);
    if (readout?.status === 'unavailable') {
        return Either.ofRight(
            toFormationCaptureUnavailable(readout) ?? { status: 'unavailable', reason: 'unrecognized' }
        );
    }
    const receipt = readout?.status === 'observed' ? jsonRecord(readout.value) : null;
    if (receipt === null) {
        return Either.ofRight({ status: 'unavailable', reason: 'unrecognized' });
    }
    const configurationVersion = receipt.configurationVersion;
    if (configurationVersion !== 1) {
        return Either.ofLeft('configuration-version-unverified');
    }
    const decoded = toFormationCaptureReceipt(receipt, configurationVersion);
    return Either.ofRight(
        decoded === undefined
            ? { status: 'unavailable', reason: 'unrecognized' }
            : { status: 'observed', value: decoded }
    );
}

function toFormationCaptureReceipt(
    receipt: LiveRtcJsonRecord,
    configurationVersion: 1
): RtcSignalingDiagnostics.CaptureReceipt | undefined {
    const configuration = toFormationCaptureConfiguration(receipt.configuration);
    const application = toFormationCaptureApplication(receipt.application);
    const connectionId = toFormationCaptureStringReadout(receipt.connectionId);
    const nativeScopeId = toFormationCaptureStringReadout(receipt.nativeScopeId);
    const nativeAvailability = toFormationCaptureAvailability(receipt.nativeAvailability);
    const nativeCoverage = receipt.nativeCoverage;
    if (
        configuration === undefined || application === undefined || connectionId === undefined ||
        nativeScopeId === undefined ||
        nativeAvailability === undefined ||
        (nativeCoverage !== 'attached' && nativeCoverage !== 'partial' && nativeCoverage !== 'unavailable' &&
            nativeCoverage !== 'not-applicable')
    ) {
        return undefined;
    }
    return {
        configuration,
        application,
        connectionId,
        nativeScopeId,
        configurationVersion,
        nativeAvailability,
        nativeCoverage
    };
}

function toFormationCaptureConfiguration(
    value: RtcBaselineJson | undefined
): RtcSignalingDiagnostics.CaptureConfiguration | undefined {
    const configuration = jsonRecord(value);
    if (configuration === null) {
        return undefined;
    }
    const mode = parseRtcCaptureMode(configuration.mode).right?.mode;
    const origin = configuration.origin;
    return mode !== undefined &&
            (origin === 'run' || origin === 'step' || origin === 'recipe' || origin === 'host' ||
                origin === 'product-default')
        ? { mode, origin }
        : undefined;
}

function toFormationCaptureApplication(
    value: RtcBaselineJson | undefined
): RtcSignalingDiagnostics.CaptureApplication | undefined {
    const application = jsonRecord(value);
    if (application?.status === 'applied') {
        const mode = parseRtcCaptureMode(application.mode).right?.mode;
        return mode === undefined ? undefined : { status: 'applied', mode };
    }
    const reason = application?.reason;
    return application?.status === 'unavailable' &&
            (reason === 'sink-unavailable' || reason === 'unsupported' || reason === 'initialization-failed')
        ? { status: 'unavailable', reason }
        : undefined;
}

function toFormationCaptureStringReadout(
    value: RtcBaselineJson | undefined
): RtcSignalingDiagnostics.Readout<string> | undefined {
    const readout = jsonRecord(value);
    return readout?.status === 'observed' && typeof readout.value === 'string'
        ? { status: 'observed', value: readout.value }
        : toFormationCaptureUnavailable(value);
}

function toFormationCaptureAvailability(
    value: RtcBaselineJson | undefined
): RtcSignalingDiagnostics.Readout<'enabled'> | undefined {
    const readout = jsonRecord(value);
    return readout?.status === 'observed' && readout.value === 'enabled'
        ? { status: 'observed', value: 'enabled' }
        : toFormationCaptureUnavailable(value);
}

function toFormationCaptureUnavailable(
    value: RtcBaselineJson | undefined
): RtcSignalingDiagnostics.UnavailableReadout | undefined {
    const readout = jsonRecord(value);
    if (readout?.status !== 'unavailable') {
        return undefined;
    }
    const reason = readout.reason;
    switch (reason) {
        case 'disabled':
        case 'no-native-object':
        case 'absent':
        case 'unsupported':
        case 'unrecognized':
        case 'read-failed':
        case 'identity-source-absent':
        case 'identity-source-failed':
        case 'identity-invalid':
        case 'initialization-failed':
        case 'admission-limit':
        case 'scope-disposed':
        case 'payload-bytes':
        case 'not-applicable':
            return { status: 'unavailable', reason };
        default:
            return undefined;
    }
}

async function configureMeshTopology(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<string> {
    const commandId = `topology-mesh-${input.suffix}`;
    await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `topology/config/requests/${toPathSegment(`topology-mesh-${input.suffix}`)}`
                ),
                method: 'PUT',
                body: {
                    config: {
                        topologyKind: 'mesh',
                        degreeLimit: 2
                    }
                }
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            },
            timeoutMs: 10_000
        }
    });
    return commandId;
}

async function enterGroupConnectionCycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<LifecycleStageReceipt> {
    const readCommandId = `group-lifecycle-read-${input.suffix}`;
    const current = await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId: readCommandId,
        command: groupReadCommand(config, input.groupId),
        timeoutMs: 15_000
    });
    const lifecycleState = toFormationEntryLifecycleState(
        input.control.resultValue(current)
    );
    const operation = lifecycleState === 'forming' ? 'plan' : 'reconfigure';
    const commandId = `group-${operation}-${input.suffix}`;
    const result = await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/${operation}/requests/${toPathSegment(`${operation}-${input.suffix}`)}`
                ),
                method: 'POST',
                body: operation === 'reconfigure' ? { landing: 'hold' } : {}
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        }
    });
    return {
        commandIds: [readCommandId, commandId],
        ...toLifecycleStageReceipt(input.control.resultValue(result), commandId)
    };
}

async function connectPublishedLayout(
    config: CreateGroupFormationLifecycleDriverConfig,
    input:
        & GroupLifecycleCommandInput
        & Readonly<{
            expectedFormationEpoch: number;
            expectedLayout: GroupLayoutIdentity;
        }>
): Promise<string> {
    const commandId = `group-connect-${input.suffix}`;
    await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/connect/requests/${toPathSegment(`connect-${input.suffix}`)}`
                ),
                method: 'POST',
                body: {
                    expectedFormationEpoch: input.expectedFormationEpoch,
                    expectedLayout: input.expectedLayout
                }
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        }
    });
    return commandId;
}

async function activateGroup(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ActivateGroupInput
): Promise<string> {
    const transport = input.transport.replace('.', '-');
    const commandId = `group-activate-${transport}-${input.suffix}`;
    await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/activate/requests/${toPathSegment(`activate-${transport}-${input.suffix}`)}`
                ),
                method: 'POST',
                body: {}
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        }
    });
    return commandId;
}

async function waitForPlannedLayout(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForPlannedLayoutInput
): Promise<PublishedGroupLayout> {
    let attempt = 0;
    const commandIds: string[] = [];
    let plannedLayout: GroupLayoutIdentity | undefined;
    await expect
        .poll(
            async () => {
                const commandId = `topology-planned-${input.suffix}-${attempt++}`;
                commandIds.push(commandId);
                const result = await input.control
                    .executeResult({
                        ...input,
                        agentId: input.owner.agentId,
                        commandId,
                        command: topologyReadCommand(config, input.groupId),
                        timeoutMs: 15_000
                    })
                    .catch(() => undefined);
                if (!result?.ok) {
                    return false;
                }
                const candidate = toActivePublishedLayout(
                    input.control.resultValue(result)
                );
                if (
                    candidate === undefined ||
                    candidate.identity.groupRevision < input.minimumGroupRevision ||
                    !input.expectedSessionIds.every((sessionId) => candidate.sessionIds.includes(sessionId))
                ) {
                    return false;
                }
                plannedLayout = candidate.identity;
                return true;
            },
            {
                message:
                    `Expected an epoch ${input.expectedFormationEpoch} planned topology at or after group revision ${input.minimumGroupRevision} with ${
                        input.expectedSessionIds.join(
                            ', '
                        )
                    }`,
                timeout: 30_000
            }
        )
        .toBe(true);
    if (!plannedLayout) {
        throw new Error(
            `Planned layout did not resolve for formation epoch ${input.expectedFormationEpoch}.`
        );
    }
    return { commandIds, identity: plannedLayout };
}

async function waitForActiveSessions(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForActiveSessionsInput
): Promise<readonly string[]> {
    let attempt = 0;
    const commandIds: string[] = [];
    const expectedSessionIds = [...input.expectedSessionIds].sort((left, right) => left.localeCompare(right));
    await expect
        .poll(
            async () => {
                const commandId = `group-presence-${input.suffix}-${expectedSessionIds.length}-${attempt++}`;
                commandIds.push(commandId);
                const result = await input.control
                    .executeResult({
                        ...input,
                        agentId: input.owner.agentId,
                        commandId,
                        command: groupReadCommand(config, input.groupId),
                        timeoutMs: 15_000
                    })
                    .catch(() => undefined);
                if (!result?.ok) {
                    return [];
                }
                return toActiveSessionIds(input.control.resultValue(result));
            },
            {
                message: `Expected exactly the active sessions ${expectedSessionIds.join(', ')} for ${input.groupId}`,
                timeout: 30_000
            }
        )
        .toEqual(expectedSessionIds);
    return commandIds;
}

async function waitForFormationReadiness(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForFormationReadinessInput
): Promise<Readonly<Partial<Record<AgentPrefix, number>>>> {
    const durations = await Promise.all(
        input.run.agents.map(async (agent) => ({
            prefix: agent.prefix,
            durationMs: await waitForCanonicalFormationReadiness(config, {
                control: input.run.control,
                runId: input.run.runId,
                agent,
                roomRef: toGroupRef(config, input.run.groupId),
                expectedPeerIds: input.run.agents
                    .filter((candidate) => candidate.agentId !== agent.agentId)
                    .map((candidate) => input.sessions[candidate.prefix]),
                suffix: input.suffix,
                startedAtMs: input.startedAtMs
            })
        }))
    );
    const measuredDurations = input.run.readinessScope === 'owner' ? durations.slice(0, 1) : durations;
    return Object.fromEntries(
        measuredDurations.map(({ prefix, durationMs }) => [prefix, durationMs])
    );
}

async function waitForCanonicalFormationReadiness(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForCanonicalFormationReadinessInput
): Promise<number> {
    const readiness = await config.formation.readiness({
        control: input.control,
        runId: input.runId,
        agent: input.agent,
        roomRef: input.roomRef,
        suffix: input.suffix
    });
    const room = readiness.formation.room;
    const expectedPeerIds = [...new Set(input.expectedPeerIds)].sort();

    expect(
        room.state,
        `Expected ${input.agent.agentId} to hold an open room transport for ${input.suffix}`
    ).toBe('open');
    expect(
        room.acceptedLayoutIdentity,
        `Expected ${input.agent.agentId} to hold an accepted layout for ${input.suffix}`
    ).toBeDefined();
    expect(
        [...new Set(room.desiredPeerIds)].sort(),
        `Expected ${input.agent.agentId} to target the exact peers for ${input.suffix}`
    ).toEqual(expectedPeerIds);
    expect(
        [...new Set(room.readyPeerIds)].sort(),
        `Expected ${input.agent.agentId} to have the exact ready peers for ${input.suffix}`
    ).toEqual(expectedPeerIds);

    return performance.now() - input.startedAtMs;
}

function topologyReadCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: groupRequestPath(config, groupId, 'topology'),
            method: 'GET'
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200]
        }
    };
}

function groupReadCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: groupRequestPath(config, groupId),
            method: 'GET'
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200]
        }
    };
}

function groupRequestPath(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string,
    suffix?: string
): string {
    const groupPath = `/api/state/apps/${toPathSegment(config.applicationId)}/workspaces/${
        toPathSegment(
            config.workspaceId
        )
    }/groups/${toPathSegment(groupId)}`;
    return suffix ? `${groupPath}/${suffix}` : groupPath;
}

function toGroupRef(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string
): GroupRef {
    return {
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        groupId
    };
}

function toActivePublishedLayout(
    value: Readonly<Record<string, RtcBaselineJson>>
): ActivePublishedLayout | undefined {
    const body = jsonRecord(value.body);
    const snapshot = jsonRecord(body?.snapshot);
    const sourceRevision = jsonRecord(snapshot?.sourceGroupStateCausalRevision);
    const groupRevision = toNonnegativeInteger(sourceRevision?.groupRevision);
    const presenceRevision = toNonnegativeInteger(sourceRevision?.presenceRevision);
    const version = toNonnegativeInteger(snapshot?.version);
    const state = snapshot?.state;
    if (
        groupRevision === undefined ||
        presenceRevision === undefined ||
        version === undefined ||
        state !== 'active'
    ) {
        return undefined;
    }
    return {
        sessionIds: stringArrayValue(snapshot?.activeSessionIds),
        identity: { groupRevision, presenceRevision, version, state }
    };
}

function toLifecycleStageReceipt(
    value: Readonly<Record<string, RtcBaselineJson>>,
    commandId: string
): Omit<LifecycleStageReceipt, 'commandIds'> {
    const body = jsonRecord(value.body);
    const group = jsonRecord(body?.group);
    const causalRevision = jsonRecord(body?.causalRevision);
    const formationEpoch = toNonnegativeInteger(group?.formationEpoch);
    const groupRevision = toNonnegativeInteger(causalRevision?.groupRevision);
    if (formationEpoch === undefined || groupRevision === undefined) {
        throw new Error(
            `Lifecycle command ${commandId} did not return its formation epoch and group revision.`
        );
    }
    return { formationEpoch, groupRevision };
}

function toActiveSessionIds(
    value: Readonly<Record<string, RtcBaselineJson>>
): readonly string[] {
    const body = jsonRecord(value.body);
    const activeSessions = body?.activeSessions;
    if (!Array.isArray(activeSessions)) {
        return [];
    }
    return activeSessions
        .flatMap((session) => {
            const sessionId = jsonRecord(session)?.sessionId;
            return typeof sessionId === 'string' ? [sessionId] : [];
        })
        .sort((left, right) => left.localeCompare(right));
}

function toFormationEntryLifecycleState(
    value: Readonly<Record<string, RtcBaselineJson>>
): FormationEntryLifecycleState {
    const body = jsonRecord(value.body);
    const lifecycleState = jsonRecord(body?.group)?.lifecycleState;
    if (lifecycleState === 'forming' || lifecycleState === 'active') {
        return lifecycleState;
    }
    throw new Error(
        `Expected forming or active group lifecycle state; received ${String(lifecycleState)}`
    );
}

function toNonnegativeInteger(value: RtcBaselineJson | undefined): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function toPathSegment(value: string): string {
    return encodeURIComponent(value);
}

async function setupGroupMembership(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: SetupGroupMembershipInput
): Promise<readonly string[]> {
    const groupSegment = encodeURIComponent(input.groupId);
    const createCommandId = `group-create-${input.suffix}`;
    const joinCommandIds: string[] = [];

    await input.control.executeOk({
        runId: input.runId,
        agentId: input.owner.agentId,
        commandId: createCommandId,
        command: toGroupCreationCommand(config, input)
    });

    for (const member of input.members) {
        if (member.agentId === input.owner.agentId) {
            continue;
        }
        const commandId = `group-join-${member.agentId}-${input.suffix}`;
        const requestId = `rtc-b06-member-${member.prefix.toLowerCase()}-${input.suffix}`;
        joinCommandIds.push(commandId);
        await input.control.executeOk({
            runId: input.runId,
            agentId: member.agentId,
            commandId,
            command: {
                kind: 'http.request',
                request: {
                    path: `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                        encodeURIComponent(
                            config.workspaceId
                        )
                    }/groups/${groupSegment}/members/{auth.clientId}/requests/${encodeURIComponent(requestId)}`,
                    method: 'PUT',
                    body: {
                        status: 'active'
                    }
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200]
                },
                timeoutMs: 10_000
            }
        });
    }

    return [createCommandId, ...joinCommandIds];
}

function toGroupCreationCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: SetupGroupMembershipInput
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                encodeURIComponent(
                    config.workspaceId
                )
            }/groups/requests/${encodeURIComponent(`rtc-b06-create-${input.suffix}`)}`,
            method: 'POST',
            body: {
                groupId: input.groupId,
                displayName: input.groupId,
                description: 'Created by rallar-black-box live three-browser matrix',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: '{auth.clientId}',
                metadata: {
                    source: 'rallar-black-box',
                    matrix: 'live-three-browser',
                    suffix: input.suffix
                },
                lifecyclePolicy: input.lifecyclePolicy ?? MANUAL_TRIGGER_POLICY
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [201]
        },
        timeoutMs: 10_000
    };
}
