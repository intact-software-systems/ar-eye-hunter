import { dirname } from 'node:path';

import type { ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

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

export interface WebRtcGroupManagerStateInput {
    readonly clients: number;
    readonly desired: number;
    readonly lookups: number;
}

interface WebRtcGroupManagerStateDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: WebRtcGroupManagerStateInput;
    readonly runs: number;
    readonly out: string;
}

export interface WebRtcGroupManagerStateResult {
    readonly durationMs: number;
    readonly clientCount: number;
    readonly desiredPeerCount: number;
    readonly lookups: number;
    readonly keysCalls: number;
    readonly readCalls: number;
    readonly onlineDesiredPeerCount: number;
    readonly onlinePeerCount: number;
}

interface ValidationRule {
    readonly valid: boolean;
    readonly path: string;
    readonly code: string;
    readonly message: string;
}

const acceptedInput: WebRtcGroupManagerStateInput = { clients: 5000, desired: 1000, lookups: 20 };

class CountingClientCache implements ReadableKeyedValues<string, ClientInfo> {
    keysCalls = 0;
    readCalls = 0;
    private readonly values = new Map<string, ClientInfo>();

    set(key: string, value: ClientInfo): void {
        this.values.set(key, value);
    }

    resetCounters(): void {
        this.keysCalls = 0;
        this.readCalls = 0;
    }

    read(key: string): ClientInfo | undefined {
        this.readCalls += 1;
        return this.values.get(key);
    }

    peek(key: string): ClientInfo | undefined {
        return this.values.get(key);
    }

    hasValue(key: string): boolean {
        return this.values.has(key);
    }

    expired(key: string): boolean {
        return !this.values.has(key);
    }

    refreshing(_key: string): boolean {
        return false;
    }

    has(key: string): boolean {
        return this.values.has(key);
    }

    delete(key: string): boolean {
        return this.values.delete(key);
    }

    clear(key: string): void {
        this.values.delete(key);
    }

    clearAll(): void {
        this.values.clear();
    }

    deleteExpired(): number {
        return 0;
    }

    size(): number {
        return this.values.size;
    }

    keys(): IterableIterator<string> {
        this.keysCalls += 1;
        return this.values.keys();
    }

    readAllValues(): ClientInfo[] {
        return Array.from(this.values.values());
    }
}

export function parseWebRtcGroupManagerStateArguments(
    arguments_: readonly string[]
): RtcBaselineResult<
    | WebRtcGroupManagerStateDiagnosticArguments
    | RtcBaselineAcceptedWorker<WebRtcGroupManagerStateInput>
> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    if (accepted) {
        return parseRtcBaselineAcceptedWorker({
            arguments_,
            identity: { workloadId: 'RTC-B04', caseId: 'group-manager-state' },
            toInputKey: () => 'fixed',
            capabilityOptionNames: ['rtc-clients', 'rtc-desired', 'rtc-lookups'],
            parseCapability: parseAcceptedCapability
        });
    }
    return { ok: true, value: parseDiagnosticArguments(arguments_) };
}

export async function runWebRtcGroupManagerState(
    input: WebRtcGroupManagerStateInput
): Promise<WebRtcGroupManagerStateResult> {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new CountingClientCache();
    const connectionService = createSimulatedConnectionService('self');
    const manager = new WebRtcGroupManager(
        connectionService,
        { groupCache, clientCache }
    );

    for (let index = 0; index < input.clients; index += 1) {
        const peerId = `peer-${index}`;
        clientCache.set(peerId, {
            clientId: peerId,
            sessionId: peerId,
            isOnline: true
        });
    }

    await manager.acceptGroupUpdate(
        createGroupSnapshot('room-1', 1, [
            'self',
            ...Array.from({ length: input.desired }, (_, index) => `peer-${index}`)
        ])
    );

    clientCache.resetCounters();
    let onlineDesiredPeerCount = 0;
    let onlinePeerCount = 0;
    const start = performance.now();

    for (let lookup = 0; lookup < input.lookups; lookup += 1) {
        const state = manager.state();
        onlineDesiredPeerCount = state.onlineDesiredPeerIds.length;
        onlinePeerCount = state.onlinePeerIds.length;
    }

    return {
        durationMs: performance.now() - start,
        clientCount: input.clients,
        desiredPeerCount: input.desired,
        lookups: input.lookups,
        keysCalls: clientCache.keysCalls,
        readCalls: clientCache.readCalls,
        onlineDesiredPeerCount,
        onlinePeerCount
    };
}

export interface WebRtcGroupManagerStateAcceptedSamplesInput {
    readonly worker: RtcBaselineAcceptedWorker<WebRtcGroupManagerStateInput>;
    readonly run: () => WebRtcGroupManagerStateResult | Promise<WebRtcGroupManagerStateResult>;
}

export function runWebRtcGroupManagerStateAcceptedSamples(
    input: WebRtcGroupManagerStateAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorker({
        worker: input.worker,
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        metrics: (result) => [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: toRawEvidence
    });
}

function createSimulatedConnectionService(sessionId: string): WebRtcConnectionService {
    const connectedPeerIds = new Set<string>();
    const service = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId,
        token: 'benchmark-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'benchmark',
        rtcSignalingTopicId: 'rtc'
    });
    service.onRtcPeerLifecycleDo('simulated-native-transport', {
        onCreated: (peer) => {
            peer.connection.connect = () => {
                connectedPeerIds.add(peer.peerId);
            };
            for (const channel of peer.channels.values()) {
                channel.connect = () => undefined;
            }
        },
        onDeleted: (peer) => {
            connectedPeerIds.delete(peer.peerId);
        }
    });
    // Preserve the simulated native readiness query's workload without creating browser sockets.
    service.peerIdsWithNoReconnectableLanes = () => Array.from(connectedPeerIds);
    return service;
}

function createGroupSnapshot(
    groupId: string,
    membershipVersion: number,
    memberSessionIds: readonly string[]
): GroupSnapshot {
    return {
        causalRevision: {
            groupRevision: membershipVersion,
            presenceRevision: membershipVersion
        },
        group: createGroupSnapshotGroup(groupId, membershipVersion, memberSessionIds),
        members: createGroupSnapshotMembers(groupId, membershipVersion, memberSessionIds),
        activeSessions: createGroupSnapshotSessions(groupId, membershipVersion, memberSessionIds),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

function createGroupSnapshotGroup(
    groupId: string,
    membershipVersion: number,
    memberSessionIds: readonly string[]
): GroupSnapshot['group'] {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        slug: groupId,
        displayName: groupId,
        description: null,
        kind: 'room',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'open',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: memberSessionIds.length,
        ownerPrincipalId: memberSessionIds[0] ?? 'creator',
        snapshotVersion: membershipVersion,
        metadataVersion: 0,
        rosterVersion: membershipVersion,
        presenceVersion: 0,
        created: {
            atEpochMs: 1,
            actor: { kind: 'principal', principalId: 'creator' },
            reason: null,
            traceId: null,
            requestId: null
        },
        updated: {
            atEpochMs: membershipVersion,
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

function createGroupSnapshotMembers(
    groupId: string,
    membershipVersion: number,
    memberSessionIds: readonly string[]
): GroupSnapshot['members'] {
    return memberSessionIds.map((sessionId) => ({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        principalId: sessionId,
        role: 'member',
        status: 'active',
        joined: {
            atEpochMs: 1,
            actor: { kind: 'principal', principalId: 'creator' },
            reason: null,
            traceId: null,
            requestId: null
        },
        updated: {
            atEpochMs: membershipVersion,
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
    groupId: string,
    membershipVersion: number,
    memberSessionIds: readonly string[]
): GroupSnapshot['activeSessions'] {
    return memberSessionIds.map((sessionId) => ({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: membershipVersion,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: membershipVersion,
        expiresAtEpochMs: membershipVersion + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}

function parseDiagnosticArguments(
    arguments_: readonly string[]
): WebRtcGroupManagerStateDiagnosticArguments {
    return {
        mode: 'diagnostic',
        input: {
            clients: Number(toDiagnosticArgument(arguments_, '--clients', '5000')),
            desired: Number(toDiagnosticArgument(arguments_, '--desired', '1000')),
            lookups: Number(toDiagnosticArgument(arguments_, '--lookups', '20'))
        },
        runs: Number(toDiagnosticArgument(arguments_, '--runs', '5')),
        out: toDiagnosticArgument(
            arguments_,
            '--out',
            'tmp/perf/results/webrtc-group-manager-state.json'
        )
    };
}

function parseAcceptedCapability(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<WebRtcGroupManagerStateInput> {
    const clients = parseRtcBaselineBoundedInteger(
        options['rtc-clients'] ?? '',
        'rtc-clients',
        1,
        Number.MAX_SAFE_INTEGER
    );
    const desired = parseRtcBaselineBoundedInteger(
        options['rtc-desired'] ?? '',
        'rtc-desired',
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
        'rtc-clients': String(acceptedInput.clients),
        'rtc-desired': String(acceptedInput.desired),
        'rtc-lookups': String(acceptedInput.lookups)
    };
    const issues = [
        ...collectParsingIssues([clients, desired, lookups]),
        ...Object.entries(expected)
            .filter(([name, value]) => options[name] !== value)
            .map(([name, value]) => rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`))
    ];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: acceptedInput };
}

function validateResult(
    input: WebRtcGroupManagerStateInput,
    result: WebRtcGroupManagerStateResult
): RtcBaselineIssueDto[] {
    return validateRules([
        {
            valid: JSON.stringify([result.clientCount, result.desiredPeerCount, result.lookups]) ===
                JSON.stringify([input.clients, input.desired, input.lookups]),
            path: '$.rawEvidence.input',
            code: 'input-mismatch',
            message: 'Unexpected input.'
        },
        {
            valid: JSON.stringify([result.keysCalls, result.readCalls]) ===
                    JSON.stringify([input.lookups, input.clients * input.lookups]) &&
                [result.keysCalls, result.readCalls].every(Number.isSafeInteger),
            path: '$.rawEvidence.calls',
            code: 'call-count-mismatch',
            message: 'Unexpected calls.'
        },
        {
            valid: JSON.stringify([result.onlineDesiredPeerCount, result.onlinePeerCount]) ===
                JSON.stringify([input.desired, input.clients]),
            path: '$.rawEvidence.state',
            code: 'state-result-mismatch',
            message: 'Unexpected state result.'
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

function toDiagnosticArgument(
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

function toRawEvidence(result: WebRtcGroupManagerStateResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        clientCount: result.clientCount,
        desiredPeerCount: result.desiredPeerCount,
        lookups: result.lookups,
        keysCalls: result.keysCalls,
        readCalls: result.readCalls,
        onlineDesiredPeerCount: result.onlineDesiredPeerCount,
        onlinePeerCount: result.onlinePeerCount
    };
}

async function main(): Promise<void> {
    const parsed = parseWebRtcGroupManagerStateArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const dispatched = await runRtcBaselineAcceptedWorkerCli({
        parsed: parsed.value,
        runAccepted: (worker) =>
            runWebRtcGroupManagerStateAcceptedSamples({
                worker,
                run: () => runWebRtcGroupManagerState(worker.input)
            }),
        writeOutput: (output) => console.log(output)
    });
    if (dispatched.handled) {
        return;
    }
    const diagnostic = dispatched.diagnostic;
    const results = [];
    for (let run = 1; run <= diagnostic.runs; run += 1) {
        results.push({ run, ...(await runWebRtcGroupManagerState(diagnostic.input)) });
    }
    const output = {
        createdAt: new Date().toISOString(),
        input: {
            clientCount: diagnostic.input.clients,
            desiredPeerCount: diagnostic.input.desired,
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
