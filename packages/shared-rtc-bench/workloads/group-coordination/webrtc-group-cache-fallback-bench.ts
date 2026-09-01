import { dirname } from 'node:path';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupService } from '@shared/services/web-rtc-group-service.ts';

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

export interface WebRtcGroupCacheFallbackInput {
    readonly snapshots: number;
    readonly matchingVersions: number;
    readonly lookups: number;
}

interface WebRtcGroupCacheFallbackDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: WebRtcGroupCacheFallbackInput;
    readonly runs: number;
    readonly out: string;
}

export interface WebRtcGroupCacheFallbackResult {
    readonly durationMs: number;
    readonly snapshotCount: number;
    readonly matchingVersions: number;
    readonly lookups: number;
    readonly readCalls: number;
    readonly peekCalls: number;
    readonly readAllValuesCalls: number;
    readonly latestVersion: number | undefined;
    readonly targetPeerCount: number;
}

interface CreateGroupSnapshotInput {
    readonly groupId: string;
    readonly version: number;
    readonly memberSessionIds: readonly string[];
    readonly scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>;
}

interface ValidationRule {
    readonly valid: boolean;
    readonly path: string;
    readonly code: string;
    readonly message: string;
}

const acceptedInput: WebRtcGroupCacheFallbackInput = {
    snapshots: 20000,
    matchingVersions: 5000,
    lookups: 500
};

class FallbackOnlyGroupCache implements ReadableKeyedValues<string, GroupSnapshot> {
    private readonly snapshots: readonly GroupSnapshot[];
    readCalls = 0;
    peekCalls = 0;
    readAllValuesCalls = 0;

    constructor(snapshots: readonly GroupSnapshot[]) {
        this.snapshots = snapshots;
    }

    read(_key: string): GroupSnapshot | undefined {
        this.readCalls += 1;
        return undefined;
    }

    peek(_key: string): GroupSnapshot | undefined {
        this.peekCalls += 1;
        return undefined;
    }

    hasValue(_key: string): boolean {
        return false;
    }

    expired(_key: string): boolean {
        return true;
    }

    refreshing(_key: string): boolean {
        return false;
    }

    has(_key: string): boolean {
        return false;
    }

    delete(_key: string): boolean {
        return false;
    }

    clear(_key: string): void {}

    clearAll(): void {}

    deleteExpired(): number {
        return 0;
    }

    size(): number {
        return this.snapshots.length;
    }

    keys(): IterableIterator<string> {
        return [][Symbol.iterator]();
    }

    readAllValues(): GroupSnapshot[] {
        this.readAllValuesCalls += 1;
        return [...this.snapshots];
    }
}

const targetGroupId = 'target-room';
const targetScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export function parseWebRtcGroupCacheFallbackArguments(
    arguments_: readonly string[]
): RtcBaselineResult<
    | WebRtcGroupCacheFallbackDiagnosticArguments
    | RtcBaselineAcceptedWorker<WebRtcGroupCacheFallbackInput>
> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    if (accepted) {
        return parseRtcBaselineAcceptedWorker({
            arguments_,
            identity: { workloadId: 'RTC-B04', caseId: 'group-cache-fallback' },
            toInputKey: () => 'fixed',
            capabilityOptionNames: ['rtc-snapshots', 'rtc-matching-versions', 'rtc-lookups'],
            parseCapability: parseAcceptedCapability
        });
    }
    return { ok: true, value: parseDiagnosticArguments(arguments_) };
}

export function runWebRtcGroupCacheFallback(
    input: WebRtcGroupCacheFallbackInput
): WebRtcGroupCacheFallbackResult {
    const snapshots = createSnapshots(input.snapshots, input.matchingVersions);
    const cache = new FallbackOnlyGroupCache(snapshots);
    const service = new WebRtcGroupService(
        new WebRtcConnectionService({ send: async () => {}, connect: async () => {} }, {
            sessionId: 'self',
            token: 'benchmark-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
            dataChannelName: 'realtime',
            rtcSignalingTopicId: 'rtc'
        }),
        {
            ...targetScope,
            groupId: targetGroupId
        },
        cache
    );
    let latestVersion: number | undefined;
    let targetPeerCount = 0;
    const start = performance.now();

    for (let index = 0; index < input.lookups; index += 1) {
        const snapshot = service.readGroup();
        latestVersion = snapshot?.group.rosterVersion;
        targetPeerCount = service.targetPeerIds().length;
    }

    return {
        durationMs: performance.now() - start,
        snapshotCount: input.snapshots,
        matchingVersions: input.matchingVersions,
        lookups: input.lookups,
        readCalls: cache.readCalls,
        peekCalls: cache.peekCalls,
        readAllValuesCalls: cache.readAllValuesCalls,
        latestVersion,
        targetPeerCount
    };
}

export interface WebRtcGroupCacheFallbackAcceptedSamplesInput {
    readonly worker: RtcBaselineAcceptedWorker<WebRtcGroupCacheFallbackInput>;
    readonly run: () => WebRtcGroupCacheFallbackResult | Promise<WebRtcGroupCacheFallbackResult>;
}

export function runWebRtcGroupCacheFallbackAcceptedSamples(
    input: WebRtcGroupCacheFallbackAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorker({
        worker: input.worker,
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        metrics: (result) => [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: toRawEvidence
    });
}

function createSnapshots(
    snapshotCount: number,
    matchingVersions: number
): readonly GroupSnapshot[] {
    const snapshots: GroupSnapshot[] = [];
    for (let version = 1; version <= matchingVersions; version++) {
        snapshots.push(
            createGroupSnapshot({
                groupId: targetGroupId,
                version,
                memberSessionIds: ['self', `target-peer-${version}`],
                scope: targetScope
            })
        );
    }

    for (let index = matchingVersions; index < snapshotCount; index++) {
        snapshots.push(
            createGroupSnapshot({
                groupId: `other-room-${index}`,
                version: index + 1,
                memberSessionIds: ['self', `other-peer-${index}`],
                scope: {
                    applicationId: 'app-1',
                    workspaceId: `workspace-${index % 20}`
                }
            })
        );
    }

    return shuffleDeterministically(snapshots);
}

function shuffleDeterministically<T>(values: readonly T[]): readonly T[] {
    const shuffled = [...values];
    for (let index = 0; index < shuffled.length; index++) {
        const swapIndex = (index * 48271 + 17) % shuffled.length;
        const current = shuffled[index];
        shuffled[index] = shuffled[swapIndex];
        shuffled[swapIndex] = current;
    }
    return shuffled;
}

function createGroupSnapshot(input: CreateGroupSnapshotInput): GroupSnapshot {
    const { memberSessionIds, version } = input;
    return {
        causalRevision: {
            groupRevision: version,
            presenceRevision: version
        },
        group: createGroupSnapshotGroup(input),
        members: createGroupSnapshotMembers(input),
        activeSessions: createGroupSnapshotSessions(input),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

function createGroupSnapshotGroup(input: CreateGroupSnapshotInput): GroupSnapshot['group'] {
    return {
        applicationId: input.scope.applicationId,
        workspaceId: input.scope.workspaceId,
        groupId: input.groupId,
        slug: input.groupId,
        displayName: input.groupId,
        description: null,
        kind: 'room',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'open',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: input.memberSessionIds.length,
        ownerPrincipalId: input.memberSessionIds[0] ?? 'creator',
        snapshotVersion: input.version,
        metadataVersion: 1,
        rosterVersion: input.version,
        presenceVersion: input.version,
        created: {
            atEpochMs: 1,
            actor: { kind: 'principal', principalId: 'creator' },
            reason: null,
            traceId: null,
            requestId: null
        },
        updated: {
            atEpochMs: input.version,
            actor: { kind: 'principal', principalId: 'creator' },
            reason: null,
            traceId: null,
            requestId: null
        },
        expiresAtEpochMs: null,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null,
        lifecycleState: 'active',
        formationEpoch: 0,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        formationElectorate: [],
        acceptedLayoutIdentity: null,
        transportState: 'flowing'
    };
}

function createGroupSnapshotMembers(input: CreateGroupSnapshotInput): GroupSnapshot['members'] {
    return input.memberSessionIds.map((sessionId) => ({
        applicationId: input.scope.applicationId,
        workspaceId: input.scope.workspaceId,
        groupId: input.groupId,
        principalId: sessionId,
        role: sessionId === input.memberSessionIds[0] ? 'owner' : 'member',
        status: 'active',
        joined: {
            atEpochMs: 1,
            actor: { kind: 'principal', principalId: 'creator' },
            reason: null,
            traceId: null,
            requestId: null
        },
        updated: {
            atEpochMs: input.version,
            actor: { kind: 'principal', principalId: 'creator' },
            reason: null,
            traceId: null,
            requestId: null
        },
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null
    }));
}

function createGroupSnapshotSessions(
    input: CreateGroupSnapshotInput
): GroupSnapshot['activeSessions'] {
    return input.memberSessionIds.map((sessionId) => ({
        applicationId: input.scope.applicationId,
        workspaceId: input.scope.workspaceId,
        groupId: input.groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: input.version,
        status: 'active',
        connectedAtEpochMs: input.version,
        lastHeartbeatAtEpochMs: input.version,
        expiresAtEpochMs: input.version + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}

function parseDiagnosticArguments(
    arguments_: readonly string[]
): WebRtcGroupCacheFallbackDiagnosticArguments {
    return {
        mode: 'diagnostic',
        input: {
            snapshots: Number(readDiagnosticArgument(arguments_, '--snapshots', '20000')),
            matchingVersions: Number(readDiagnosticArgument(arguments_, '--matching-versions', '5000')),
            lookups: Number(readDiagnosticArgument(arguments_, '--lookups', '500'))
        },
        runs: Number(readDiagnosticArgument(arguments_, '--runs', '5')),
        out: readDiagnosticArgument(
            arguments_,
            '--out',
            'tmp/perf/results/webrtc-group-cache-fallback.json'
        )
    };
}

function parseAcceptedCapability(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<WebRtcGroupCacheFallbackInput> {
    const snapshots = parseRtcBaselineBoundedInteger(
        options['rtc-snapshots'] ?? '',
        'rtc-snapshots',
        1,
        Number.MAX_SAFE_INTEGER
    );
    const matchingVersions = parseRtcBaselineBoundedInteger(
        options['rtc-matching-versions'] ?? '',
        'rtc-matching-versions',
        1,
        Number.MAX_SAFE_INTEGER
    );
    const lookups = parseRtcBaselineBoundedInteger(
        options['rtc-lookups'] ?? '',
        'rtc-lookups',
        1,
        Number.MAX_SAFE_INTEGER
    );
    const expected = {
        'rtc-snapshots': String(acceptedInput.snapshots),
        'rtc-matching-versions': String(acceptedInput.matchingVersions),
        'rtc-lookups': String(acceptedInput.lookups)
    };
    const issues = [
        ...collectParsingIssues([snapshots, matchingVersions, lookups]),
        ...Object.entries(expected)
            .filter(([name, value]) => options[name] !== value)
            .map(([name, value]) => rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`))
    ];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: acceptedInput };
}

function validateResult(
    input: WebRtcGroupCacheFallbackInput,
    result: WebRtcGroupCacheFallbackResult
): RtcBaselineIssueDto[] {
    const counters = [result.readCalls, result.peekCalls, result.readAllValuesCalls];
    return validateRules([
        {
            valid: JSON.stringify([result.snapshotCount, result.matchingVersions, result.lookups]) ===
                JSON.stringify([input.snapshots, input.matchingVersions, input.lookups]),
            path: '$.rawEvidence.input',
            code: 'input-mismatch',
            message: 'Unexpected input.'
        },
        {
            valid: counters.every(Number.isSafeInteger) &&
                JSON.stringify(counters) === JSON.stringify([input.lookups * 2, 0, input.lookups * 2]),
            path: '$.rawEvidence.calls',
            code: 'call-count-mismatch',
            message: 'Unexpected calls.'
        },
        {
            valid: JSON.stringify([result.latestVersion, result.targetPeerCount]) ===
                JSON.stringify([input.matchingVersions, 1]),
            path: '$.rawEvidence.result',
            code: 'fallback-result-mismatch',
            message: 'Unexpected fallback result.'
        },
        {
            valid: Number.isFinite(result.durationMs) && result.durationMs >= 0,
            path: '$.rawEvidence.durationMs',
            code: 'invalid-timing',
            message: 'Expected nonnegative.'
        }
    ]);
}

function collectParsingIssues(
    results: readonly RtcBaselineResult<number>[]
): RtcBaselineIssueDto[] {
    return results.flatMap((result) => (result.ok ? [] : result.issues));
}

function readDiagnosticArgument(
    arguments_: readonly string[],
    name: string,
    fallback: string
): string {
    return (
        arguments_.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) ??
            fallback
    );
}

function validateRules(rules: readonly ValidationRule[]): RtcBaselineIssueDto[] {
    return rules
        .filter((rule) => !rule.valid)
        .map((rule) => rtcBaselineIssue(rule.path, rule.code, rule.message));
}

function toRawEvidence(result: WebRtcGroupCacheFallbackResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        snapshotCount: result.snapshotCount,
        matchingVersions: result.matchingVersions,
        lookups: result.lookups,
        readCalls: result.readCalls,
        peekCalls: result.peekCalls,
        readAllValuesCalls: result.readAllValuesCalls,
        latestVersion: result.latestVersion ?? null,
        targetPeerCount: result.targetPeerCount
    };
}

async function main(): Promise<void> {
    const parsed = parseWebRtcGroupCacheFallbackArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const dispatched = await runRtcBaselineAcceptedWorkerCli({
        parsed: parsed.value,
        runAccepted: (worker) =>
            runWebRtcGroupCacheFallbackAcceptedSamples({
                worker,
                run: () => runWebRtcGroupCacheFallback(worker.input)
            }),
        writeOutput: (output) => console.log(output)
    });
    if (dispatched.handled) {
        return;
    }
    const diagnostic = dispatched.diagnostic;
    const results = [];
    for (let run = 1; run <= diagnostic.runs; run += 1) {
        results.push({ run, ...runWebRtcGroupCacheFallback(diagnostic.input) });
    }
    const output = {
        createdAt: new Date().toISOString(),
        input: {
            snapshotCount: diagnostic.input.snapshots,
            matchingVersions: diagnostic.input.matchingVersions,
            lookups: diagnostic.input.lookups,
            runs: diagnostic.runs
        },
        results
    };
    await Deno.mkdir(dirname(diagnostic.out), { recursive: true });
    await Deno.writeTextFile(diagnostic.out, JSON.stringify(output, null, 2));
    console.log(`Wrote ${diagnostic.out}`);
}

if (import.meta.main) {
    await main();
}
