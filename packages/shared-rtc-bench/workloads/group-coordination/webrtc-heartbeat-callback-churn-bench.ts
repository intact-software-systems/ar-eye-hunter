import { dirname } from 'node:path';

import { WebRtcHeartbeatService } from '@shared/services/web-rtc-heartbeat-service.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

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

export interface WebRtcHeartbeatCallbackChurnInput {
    readonly channels: number;
}

interface WebRtcHeartbeatCallbackChurnDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: WebRtcHeartbeatCallbackChurnInput;
    readonly runs: number;
    readonly out: string;
}

export interface WebRtcHeartbeatCallbackChurnResult {
    readonly durationMs: number;
    readonly channelCount: number;
    readonly retainedCallbacks: number;
    readonly maxCallbacksPerChannel: number;
}

const acceptedChannels = 10000;

export function parseWebRtcHeartbeatCallbackChurnArguments(
    arguments_: readonly string[]
): RtcBaselineResult<
    | WebRtcHeartbeatCallbackChurnDiagnosticArguments
    | RtcBaselineAcceptedWorker<WebRtcHeartbeatCallbackChurnInput>
> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    if (accepted) {
        return parseRtcBaselineAcceptedWorker({
            arguments_,
            identity: { workloadId: 'RTC-B04', caseId: 'heartbeat-callback-churn' },
            toInputKey: () => 'fixed',
            capabilityOptionNames: ['rtc-channels'],
            parseCapability: parseAcceptedCapability
        });
    }
    return { ok: true, value: parseDiagnosticArguments(arguments_) };
}

export function runWebRtcHeartbeatCallbackChurn(
    input: WebRtcHeartbeatCallbackChurnInput
): WebRtcHeartbeatCallbackChurnResult {
    const channels = Array.from({ length: input.channels }, (_value, index) => {
        const peerSessionId = `peer-${index}`;
        const peer = new QRtcPeerConnection({ send: async () => {} }, {
            sessionId: `self-${index}`,
            token: 'benchmark-token',
            peerSessionId,
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
            isPolite: true
        });
        return new QRtcDataChannel(peer, { peerId: peerSessionId, dataChannelName: 'realtime' });
    });
    const startedAt = performance.now();

    for (let index = 0; index < channels.length; index += 1) {
        const service = new WebRtcHeartbeatService({
            sessionId: `self-${index}`,
            peerSessionId: `peer-${index}`,
            channel: channels[index],
            maxMissedPings: 3,
            pingFrequencyMsecs: 60_000
        });
        service.start({
            onHeartbeat: async () => {},
            onMissedHeartbeat: async () => {}
        });
        service.stop();
    }

    return {
        durationMs: performance.now() - startedAt,
        channelCount: input.channels,
        retainedCallbacks: channels.reduce((sum, channel) => sum + channel.readHealth().messageCallbackCount, 0),
        maxCallbacksPerChannel: Math.max(...channels.map((channel) => channel.readHealth().messageCallbackCount))
    };
}

export interface WebRtcHeartbeatCallbackChurnAcceptedSamplesInput {
    readonly worker: RtcBaselineAcceptedWorker<WebRtcHeartbeatCallbackChurnInput>;
    readonly run: () =>
        | WebRtcHeartbeatCallbackChurnResult
        | Promise<WebRtcHeartbeatCallbackChurnResult>;
}

export function runWebRtcHeartbeatCallbackChurnAcceptedSamples(
    input: WebRtcHeartbeatCallbackChurnAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorker({
        worker: input.worker,
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        metrics: (result) => [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: toRawEvidence
    });
}

function parseDiagnosticArguments(
    arguments_: readonly string[]
): WebRtcHeartbeatCallbackChurnDiagnosticArguments {
    return {
        mode: 'diagnostic',
        input: {
            channels: Number(readDiagnosticArgument(arguments_, '--channels', '10000'))
        },
        runs: Number(readDiagnosticArgument(arguments_, '--runs', '5')),
        out: readDiagnosticArgument(
            arguments_,
            '--out',
            'tmp/perf/results/webrtc-heartbeat-callback-churn.json'
        )
    };
}

function readDiagnosticArgument(
    arguments_: readonly string[],
    name: string,
    fallback: string
): string {
    return arguments_.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) ??
        fallback;
}

function parseAcceptedCapability(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<WebRtcHeartbeatCallbackChurnInput> {
    const channels = parseRtcBaselineBoundedInteger(
        options['rtc-channels'] ?? '',
        'rtc-channels',
        1,
        Number.MAX_SAFE_INTEGER
    );
    const issues = [
        ...(!channels.ok ? channels.issues : []),
        ...(options['rtc-channels'] === String(acceptedChannels)
            ? []
            : [rtcBaselineIssue('$.rtc-channels', 'unexpected-worker-input', 'Expected 10000.')])
    ];
    return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: { channels: acceptedChannels } };
}

function validateResult(
    input: WebRtcHeartbeatCallbackChurnInput,
    result: WebRtcHeartbeatCallbackChurnResult
): RtcBaselineIssueDto[] {
    const issues: RtcBaselineIssueDto[] = [];
    if (result.channelCount !== input.channels || !Number.isSafeInteger(result.channelCount)) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.channelCount', 'input-mismatch', 'Unexpected input.')
        );
    }
    if (
        !Number.isSafeInteger(result.retainedCallbacks) ||
        !Number.isSafeInteger(result.maxCallbacksPerChannel) ||
        result.retainedCallbacks !== 0 ||
        result.maxCallbacksPerChannel !== 0
    ) {
        issues.push(
            rtcBaselineIssue(
                '$.rawEvidence.callbacks',
                'callback-retention',
                'Heartbeat callbacks must be removed.'
            )
        );
    }
    if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.durationMs', 'invalid-timing', 'Expected nonnegative.')
        );
    }
    return issues;
}

function toRawEvidence(result: WebRtcHeartbeatCallbackChurnResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        channelCount: result.channelCount,
        retainedCallbacks: result.retainedCallbacks,
        maxCallbacksPerChannel: result.maxCallbacksPerChannel
    };
}

async function main(): Promise<void> {
    const parsed = parseWebRtcHeartbeatCallbackChurnArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const dispatched = await runRtcBaselineAcceptedWorkerCli({
        parsed: parsed.value,
        runAccepted: (worker) =>
            runWebRtcHeartbeatCallbackChurnAcceptedSamples({
                worker,
                run: () => runWebRtcHeartbeatCallbackChurn(worker.input)
            }),
        writeOutput: (output) => console.log(output)
    });
    if (dispatched.handled) {
        return;
    }
    const diagnostic = dispatched.diagnostic;
    const results = [];
    for (let run = 1; run <= diagnostic.runs; run += 1) {
        results.push({ run, ...runWebRtcHeartbeatCallbackChurn(diagnostic.input) });
    }
    const output = {
        createdAt: new Date().toISOString(),
        input: { channelCount: diagnostic.input.channels, runs: diagnostic.runs },
        results
    };
    await Deno.mkdir(dirname(diagnostic.out), { recursive: true });
    await Deno.writeTextFile(diagnostic.out, JSON.stringify(output, null, 2));
    console.log(`Wrote ${diagnostic.out}`);
}

if (import.meta.main) {
    await main();
}
