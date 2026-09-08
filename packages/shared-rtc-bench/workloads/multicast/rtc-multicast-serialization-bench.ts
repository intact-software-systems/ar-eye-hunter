import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import type { OverlayMulticasterContext } from '@shared/multicast/overlay-multicast-contracts.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';

import { installRtcBenchmarkNativeRuntime } from '../native-rtc/rtc-benchmark-native-peer.ts';
import { createDeterministicRtcTopologyGroupSnapshot } from '../topology/create-deterministic-rtc-topology-group-snapshot.ts';

import {
    parseRtcBaselineAcceptedWorker,
    runRtcBaselineAcceptedWorker,
    runRtcBaselineAcceptedWorkerCli,
    type RtcBaselineAcceptedWorker
} from '../../baseline/acceptance/rtc-baseline-worker-protocol.ts';
import { parseRtcBaselineBoundedInteger } from '../../baseline/command/rtc-baseline-cli-options.ts';
import {
    rtcBaselineIssue,
    type RtcBaselineIssueDto,
    type RtcBaselineJson,
    type RtcBaselineResult,
    type RtcBaselineSampleDto
} from '../../baseline/contracts/rtc-baseline-contracts.ts';

export interface RtcMulticastSerializationInput {
    readonly peers: number;
    readonly payloadBytes: number;
}

interface RtcMulticastSerializationDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly peerCounts: readonly number[];
    readonly payloadBytes: readonly number[];
    readonly runs: number;
    readonly out: string;
}

export interface RtcMulticastSerializationResult {
    readonly peerCount: number;
    readonly payloadBytes: number;
    readonly planDurationMs: number;
    readonly serializeDurationMs: number;
    readonly originalSerializeDurationMs: number;
    readonly transportMessages: number;
    readonly uniqueSerializedMessages: number;
    readonly totalSerializedBytes: number;
    readonly originalSerializedBytes: number;
    readonly allTransportMessagesIdentical: boolean;
}

interface RtcMulticastValidationRule {
    readonly valid: boolean;
    readonly path: string;
    readonly code: string;
    readonly message: string;
}

interface RtcMulticastPayload {
    readonly text: string;
    readonly createdAtEpochMs: number;
}

const frozenPeerCounts = new Set<number>([10, 100, 1000]);
const frozenPayloadBytes = new Set<number>([4096, 65536]);

export function parseRtcMulticastSerializationArguments(
    arguments_: readonly string[]
): RtcBaselineResult<
    | RtcMulticastSerializationDiagnosticArguments
    | RtcBaselineAcceptedWorker<RtcMulticastSerializationInput>
> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    if (accepted) {
        return parseRtcBaselineAcceptedWorker({
            arguments_,
            identity: {
                workloadId: 'RTC-B04',
                caseId: 'multicast-serialization'
            },
            toInputKey: (input) => `peers-${input.peers}-payload-${input.payloadBytes}`,
            capabilityOptionNames: ['rtc-peers', 'rtc-payload-bytes'],
            parseCapability: parseAcceptedCapability
        });
    }
    return { ok: true, value: parseDiagnosticArguments(arguments_) };
}

export function runRtcMulticastSerialization(
    input: RtcMulticastSerializationInput,
    run = 1
): RtcMulticastSerializationResult {
    const peerIds = createPeerIds(input.peers);
    const connections = createConnectionService(peerIds);
    const service = new WebRtcOverlayMulticastService('group-1', connections.service);
    try {
        const multicastMessage = newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: `msg-${input.peers}-${input.payloadBytes}-${run}`,
                contextId: 'group-1'
            },
            { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
            'chat.message.v1',
            createPayload(input.payloadBytes),
            { qos: { durability: { algo: 'volatile' } } }
        );
        const overlayContext = createOverlayContext(peerIds);

        const planStartedAt = performance.now();
        const plan = service.createOriginatingPlan(multicastMessage, overlayContext);
        const planDurationMs = performance.now() - planStartedAt;

        const originalSerializationStartedAt = performance.now();
        const originalSerialized = JSON.stringify(multicastMessage);
        const originalSerializeDurationMs = performance.now() - originalSerializationStartedAt;

        const transportSerializationStartedAt = performance.now();
        const serializedTransportMessages = plan.transportMessages.map((message) => JSON.stringify(message));
        const serializeDurationMs = performance.now() - transportSerializationStartedAt;
        const uniqueSerializedMessages = new Set(serializedTransportMessages).size;

        return {
            peerCount: input.peers,
            payloadBytes: input.payloadBytes,
            planDurationMs,
            serializeDurationMs,
            originalSerializeDurationMs,
            transportMessages: plan.transportMessages.length,
            uniqueSerializedMessages,
            totalSerializedBytes: serializedTransportMessages.reduce(
                (total, serializedTransportMessage) => total + serializedTransportMessage.length,
                0
            ),
            originalSerializedBytes: originalSerialized.length,
            allTransportMessagesIdentical: uniqueSerializedMessages <= 1
        };
    }
    finally {
        connections.dispose();
    }
}

export interface RtcMulticastSerializationAcceptedSamplesInput {
    readonly worker: RtcBaselineAcceptedWorker<RtcMulticastSerializationInput>;
    readonly run: (
        innerOrdinal: number
    ) => RtcMulticastSerializationResult | Promise<RtcMulticastSerializationResult>;
}

export function runRtcMulticastSerializationAcceptedSamples(
    input: RtcMulticastSerializationAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    let innerOrdinal = 0;
    return runRtcBaselineAcceptedWorker({
        worker: input.worker,
        run: () => input.run(innerOrdinal += 1),
        validate: (result) => validateResult(input.worker.input, result),
        metrics: createMetrics,
        rawEvidence: toRawEvidence
    });
}

function parseDiagnosticArguments(
    arguments_: readonly string[]
): RtcMulticastSerializationDiagnosticArguments {
    const readValue = (name: string, fallback: string) => {
        const prefix = `--${name}=`;
        return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ??
            fallback;
    };
    const readNumbers = (name: string, fallback: string) =>
        readValue(name, fallback)
            .split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isFinite(value) && value > 0);
    return {
        mode: 'diagnostic',
        peerCounts: readNumbers('peer-counts', '10,100,1000'),
        payloadBytes: readNumbers('payload-bytes', '4096,65536'),
        runs: Number(readValue('runs', '3')),
        out: readValue('out', 'tmp/perf/results/rtc-multicast-serialization.json')
    };
}

function parseAcceptedCapability(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<RtcMulticastSerializationInput> {
    const peers = parseRtcBaselineBoundedInteger(options['rtc-peers'] ?? '', 'rtc-peers', 10, 1000);
    const payloadBytes = parseRtcBaselineBoundedInteger(
        options['rtc-payload-bytes'] ?? '',
        'rtc-payload-bytes',
        4096,
        65536
    );
    const issues = [
        ...(!peers.ok ? peers.issues : []),
        ...(!payloadBytes.ok ? payloadBytes.issues : [])
    ];
    if (peers.ok && !frozenPeerCounts.has(peers.value)) {
        issues.push(
            rtcBaselineIssue('$.rtc-peers', 'unexpected-worker-input', 'Expected 10, 100, or 1000.')
        );
    }
    if (payloadBytes.ok && !frozenPayloadBytes.has(payloadBytes.value)) {
        issues.push(
            rtcBaselineIssue('$.rtc-payload-bytes', 'unexpected-worker-input', 'Expected 4096 or 65536.')
        );
    }
    if (peers.ok && options['rtc-peers'] !== String(peers.value)) {
        issues.push(
            rtcBaselineIssue(
                '$.rtc-peers',
                'unexpected-worker-input',
                'Expected canonical integer syntax.'
            )
        );
    }
    if (payloadBytes.ok && options['rtc-payload-bytes'] !== String(payloadBytes.value)) {
        issues.push(
            rtcBaselineIssue(
                '$.rtc-payload-bytes',
                'unexpected-worker-input',
                'Expected canonical integer syntax.'
            )
        );
    }
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    return {
        ok: true,
        value: {
            peers: peers.ok ? peers.value : 10,
            payloadBytes: payloadBytes.ok ? payloadBytes.value : 4096
        }
    };
}

function validateResult(
    input: RtcMulticastSerializationInput,
    result: RtcMulticastSerializationResult
): RtcBaselineIssueDto[] {
    const timingIssues = Object.entries({
        planDurationMs: result.planDurationMs,
        originalSerializeDurationMs: result.originalSerializeDurationMs,
        serializeDurationMs: result.serializeDurationMs
    })
        .flatMap(([metric, value]) =>
            createIssueWhen(
                {
                    valid: Number.isFinite(value) && value >= 0,
                    path: `$.rawEvidence.${metric}`,
                    code: 'invalid-timing',
                    message: 'Expected nonnegative.'
                }
            )
        );
    return [
        ...createIssueWhen(
            {
                valid: JSON.stringify([result.peerCount, result.payloadBytes]) ===
                    JSON.stringify([input.peers, input.payloadBytes]),
                path: '$.rawEvidence.input',
                code: 'input-mismatch',
                message: 'Unexpected multicast input.'
            }
        ),
        ...createIssueWhen({
            valid: result.transportMessages === input.peers,
            path: '$.rawEvidence.transportMessages',
            code: 'transport-count-mismatch',
            message: 'Unexpected count.'
        }),
        ...createIssueWhen({
            valid: JSON.stringify([result.uniqueSerializedMessages, result.allTransportMessagesIdentical]) ===
                JSON.stringify([input.peers, false]),
            path: '$.rawEvidence.uniqueSerializedMessages',
            code: 'serialization-identity-mismatch',
            message: 'Expected distinct serialized transport messages.'
        }),
        ...createIssueWhen({
            valid: areExactByteCounts(result),
            path: '$.rawEvidence.bytes',
            code: 'byte-evidence-mismatch',
            message: 'Unexpected bytes.'
        }),
        ...timingIssues
    ];
}

function areExactByteCounts(result: RtcMulticastSerializationResult): boolean {
    return [result.originalSerializedBytes, result.totalSerializedBytes].every(
        Number.isSafeInteger
    ) &&
        result.originalSerializedBytes > 0 &&
        result.totalSerializedBytes >= result.originalSerializedBytes * result.transportMessages;
}

function createIssueWhen(input: RtcMulticastValidationRule): RtcBaselineIssueDto[] {
    return input.valid ? [] : [rtcBaselineIssue(input.path, input.code, input.message)];
}

function toRawEvidence(result: RtcMulticastSerializationResult): RtcBaselineJson {
    return {
        peerCount: result.peerCount,
        payloadBytes: result.payloadBytes,
        planDurationMs: result.planDurationMs,
        serializeDurationMs: result.serializeDurationMs,
        originalSerializeDurationMs: result.originalSerializeDurationMs,
        transportMessages: result.transportMessages,
        uniqueSerializedMessages: result.uniqueSerializedMessages,
        totalSerializedBytes: result.totalSerializedBytes,
        originalSerializedBytes: result.originalSerializedBytes,
        allTransportMessagesIdentical: result.allTransportMessagesIdentical
    };
}

function createMetrics(result: RtcMulticastSerializationResult): RtcBaselineSampleDto['metrics'] {
    const timedMeasurements: readonly [string, number][] = [
        ['planDurationMs', result.planDurationMs],
        ['originalSerializeDurationMs', result.originalSerializeDurationMs],
        ['serializeDurationMs', result.serializeDurationMs]
    ];
    return timedMeasurements.map(([metric, value]) => ({ metric, unit: 'ms', value }));
}

interface RtcMulticastConnectionRuntime {
    readonly service: WebRtcConnectionService;
    dispose(): void;
}

function createConnectionService(peerIds: readonly string[]): RtcMulticastConnectionRuntime {
    const nativeRuntime = installRtcBenchmarkNativeRuntime();
    const service = new WebRtcConnectionService({ send: async () => {}, connect: async () => {} }, {
        sessionId: 'self',
        token: 'benchmark-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        dataChannelName: 'realtime',
        rtcSignalingTopicId: 'rtc',
        maxPeerConnections: peerIds.length,
        peerEstablishmentTimeout: { enabled: false, timeoutMs: 5_000 }
    });
    const dispose = (): void => {
        for (const peerId of service.knownPeerIds()) {
            service.removePeerIfPresent(peerId);
        }
    };
    try {
        for (const peerId of peerIds) {
            const connection = service.ensurePeerConnectionStarted(peerId, true);
            if (!connection.right) {
                throw new Error(`Could not construct native peer ${peerId}`);
            }
            const native = nativeRuntime.peers.at(-1);
            if (!native) {
                throw new Error(`Missing native peer ${peerId}`);
            }
            native.setConnected();
            for (const channel of native.channels) {
                channel.readyState = 'open';
            }
        }
        return { service, dispose };
    }
    catch (caught) {
        dispose();
        throw toError(caught);
    }
    finally {
        nativeRuntime.restore();
    }
}

function createOverlayContext(peerIds: readonly string[]): OverlayMulticasterContext {
    const groupId = 'group-1';
    const snapshot = createDeterministicRtcTopologyGroupSnapshot(groupId, ['self', ...peerIds]);
    const room = {
        ...snapshot,
        group: { ...snapshot.group, displayName: 'Group 1', metadataVersion: 1, presenceVersion: 1 }
    };
    return {
        nowMs: 1_000,
        overlayId: groupId,
        room,
        overlay: {
            overlayId: groupId,
            groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId },
            topology: 'star',
            provenance: 'server',
            state: 'active',
            sourceGroupStateCausalRevision: room.causalRevision,
            degreeLimit: peerIds.length,
            name: 'Group 1',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: peerIds,
            overlayVersion: 1,
            updatedAtEpochMs: 1
        }
    };
}

function createPayload(payloadBytes: number): RtcMulticastPayload {
    return { text: 'x'.repeat(payloadBytes), createdAtEpochMs: 1 };
}

function createPeerIds(peerCount: number): readonly string[] {
    return Array.from(
        { length: peerCount },
        (_value, index) => `peer-${String(index + 1).padStart(5, '0')}`
    );
}

async function main(arguments_: readonly string[]): Promise<void> {
    const writeLine = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    const parsed = parseRtcMulticastSerializationArguments(arguments_);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const dispatched = await runRtcBaselineAcceptedWorkerCli({
        parsed: parsed.value,
        runAccepted: (worker) =>
            runRtcMulticastSerializationAcceptedSamples({
                worker,
                run: (innerOrdinal) => runRtcMulticastSerialization(worker.input, innerOrdinal)
            }),
        writeOutput: (output) => writeLine(output)
    });
    if (dispatched.handled) {
        return;
    }
    const diagnostic = dispatched.diagnostic;
    const results = [];
    const diagnosticInputs = diagnostic.peerCounts.flatMap((peerCount) =>
        diagnostic.payloadBytes.map((payloadBytes) => ({ peerCount, payloadBytes }))
    );
    for (const diagnosticInput of diagnosticInputs) {
        for (let run = 1; run <= diagnostic.runs; run += 1) {
            results.push({
                run,
                ...runRtcMulticastSerialization(
                    {
                        peers: diagnosticInput.peerCount,
                        payloadBytes: diagnosticInput.payloadBytes
                    },
                    run
                )
            });
        }
    }
    const output = {
        command: process.argv.join(' '),
        peerCounts: diagnostic.peerCounts,
        payloadBytes: diagnostic.payloadBytes,
        runs: diagnostic.runs,
        results
    };
    mkdirSync(dirname(diagnostic.out), { recursive: true });
    writeFileSync(diagnostic.out, `${JSON.stringify(output, null, 2)}\n`);
    writeLine(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
    await main(typeof Deno === 'undefined' ? process.argv.slice(2) : Deno.args);
}
