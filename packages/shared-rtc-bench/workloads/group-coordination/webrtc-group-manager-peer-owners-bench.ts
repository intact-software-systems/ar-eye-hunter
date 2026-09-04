import { dirname } from 'node:path';

import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toGroupMemberPolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

import { installRtcBenchmarkNativeRuntime } from '../native-rtc/rtc-benchmark-native-peer.ts';

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

export interface WebRtcGroupManagerPeerOwnersInput {
    readonly groups: number;
    readonly peersPerGroup: number;
    readonly lookups: number;
}

interface WebRtcGroupManagerPeerOwnersDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: WebRtcGroupManagerPeerOwnersInput;
    readonly runs: number;
    readonly out: string;
}

export interface WebRtcGroupManagerPeerOwnersResult {
    readonly durationMs: number;
    readonly groupCount: number;
    readonly peersPerGroup: number;
    readonly lookups: number;
    readonly ownedLookups: number;
    readonly totalOwnerGroups: number;
    readonly desiredPeerCount: number;
}

interface ValidationRule {
    readonly valid: boolean;
    readonly path: string;
    readonly code: string;
    readonly message: string;
}

const acceptedInput: WebRtcGroupManagerPeerOwnersInput = {
    groups: 1000,
    peersPerGroup: 10,
    lookups: 1000
};

export function parseWebRtcGroupManagerPeerOwnersArguments(
    arguments_: readonly string[]
): RtcBaselineResult<
    | WebRtcGroupManagerPeerOwnersDiagnosticArguments
    | RtcBaselineAcceptedWorker<WebRtcGroupManagerPeerOwnersInput>
> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    if (accepted) {
        return parseRtcBaselineAcceptedWorker({
            arguments_,
            identity: { workloadId: 'RTC-B04', caseId: 'group-manager-peer-owners' },
            toInputKey: () => 'fixed',
            capabilityOptionNames: ['rtc-groups', 'rtc-peers-per-group', 'rtc-lookups'],
            parseCapability: parseAcceptedCapability
        });
    }
    return { ok: true, value: parseDiagnosticArguments(arguments_) };
}

export async function runWebRtcGroupManagerPeerOwners(
    input: WebRtcGroupManagerPeerOwnersInput
): Promise<WebRtcGroupManagerPeerOwnersResult> {
    const connections = createSimulatedConnections('self');
    try {
        const manager = await seedPeerOwnerGroups(input, connections.service);
        return measureOwnerLookups(input, manager);
    }
    finally {
        connections.dispose();
    }
}

async function seedPeerOwnerGroups(
    input: WebRtcGroupManagerPeerOwnersInput,
    connectionService: WebRtcConnectionService
): Promise<WebRtcGroupManager> {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(
        connectionService,
        { groupCache, clientCache, acceptedOverlayCache }
    );

    for (let groupIndex = 0; groupIndex < input.groups; groupIndex += 1) {
        const peerIds = Array.from({ length: input.peersPerGroup }, (_unused, peerIndex) => {
            const peerId = `peer-${(groupIndex + peerIndex) % input.groups}`;
            return peerId;
        });
        const group = createGroupSnapshot(`group-${groupIndex}`, 1, ['self', ...peerIds]);
        acceptedOverlayCache.set(
            toScopedOverlayId(group.group),
            createAcceptedOverlay(group, peerIds)
        );

        await manager.getOrCreate(group.group).acceptGroupUpdate(group);
    }
    return manager;
}

function measureOwnerLookups(
    input: WebRtcGroupManagerPeerOwnersInput,
    manager: WebRtcGroupManager
): WebRtcGroupManagerPeerOwnersResult {
    const lookupPeerIds = Array.from(
        { length: input.lookups },
        (_unused, index) => `peer-${index % input.groups}`
    );
    let ownedLookups = 0;
    let totalOwnerGroups = 0;
    const start = performance.now();

    for (const peerId of lookupPeerIds) {
        const ownerGroups = manager.ownerGroupsOfPeer(peerId);
        totalOwnerGroups += ownerGroups.length;
        if (manager.isPeerDialAllowedByAnyGroup(peerId)) {
            ownedLookups += 1;
        }
    }

    return {
        durationMs: performance.now() - start,
        groupCount: input.groups,
        peersPerGroup: input.peersPerGroup,
        lookups: input.lookups,
        ownedLookups,
        totalOwnerGroups,
        desiredPeerCount: manager.state().desiredPeerIds.length
    };
}

function createAcceptedOverlay(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[]
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds,
        degreeLimit: Math.max(1, nextHopSessionIds.length),
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}

export interface WebRtcGroupManagerPeerOwnersAcceptedSamplesInput {
    readonly worker: RtcBaselineAcceptedWorker<WebRtcGroupManagerPeerOwnersInput>;
    readonly run: () => WebRtcGroupManagerPeerOwnersResult | Promise<WebRtcGroupManagerPeerOwnersResult>;
}

export function runWebRtcGroupManagerPeerOwnersAcceptedSamples(
    input: WebRtcGroupManagerPeerOwnersAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorker({
        worker: input.worker,
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        metrics: (result) => [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: toRawEvidence
    });
}

interface SimulatedConnections {
    readonly service: WebRtcConnectionService;
    dispose(): void;
}

/** Real dials over the benchmark's simulated native peers, so the manager's ownership reads run their true workload. */
function createSimulatedConnections(sessionId: string): SimulatedConnections {
    const nativeRuntime = installRtcBenchmarkNativeRuntime();
    const service = new WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId,
        token: 'benchmark-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'benchmark',
        rtcSignalingTopicId: 'rtc'
    });
    return {
        service,
        dispose: () => {
            for (const peerId of service.knownPeerIds()) {
                service.removePeerIfPresent(peerId);
            }
            nativeRuntime.restore();
        }
    };
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
        presenceVersion: membershipVersion,
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
        formationElectorate: [...memberSessionIds],
        acceptedLayoutIdentity: {
            groupRevision: membershipVersion,
            presenceRevision: membershipVersion,
            version: 1,
            state: 'active'
        },
        transportState: 'flowing',
        memberPolicy: toGroupMemberPolicy(createDefaultGroupLifecyclePolicy()),
        activationStatus: null
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
        role: sessionId === memberSessionIds[0] ? 'owner' : 'member',
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
        connectedAtEpochMs: membershipVersion,
        lastHeartbeatAtEpochMs: membershipVersion,
        expiresAtEpochMs: membershipVersion + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}

function parseDiagnosticArguments(
    arguments_: readonly string[]
): WebRtcGroupManagerPeerOwnersDiagnosticArguments {
    return {
        mode: 'diagnostic',
        input: {
            groups: Number(toDiagnosticArgument(arguments_, '--groups', '1000')),
            peersPerGroup: Number(toDiagnosticArgument(arguments_, '--peers-per-group', '10')),
            lookups: Number(toDiagnosticArgument(arguments_, '--lookups', '1000'))
        },
        runs: Number(toDiagnosticArgument(arguments_, '--runs', '5')),
        out: toDiagnosticArgument(
            arguments_,
            '--out',
            'tmp/perf/results/webrtc-group-manager-peer-owners.json'
        )
    };
}

function parseAcceptedCapability(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<WebRtcGroupManagerPeerOwnersInput> {
    const groups = parseRtcBaselineBoundedInteger(
        options['rtc-groups'] ?? '',
        'rtc-groups',
        1,
        Number.MAX_SAFE_INTEGER
    );
    const peersPerGroup = parseRtcBaselineBoundedInteger(
        options['rtc-peers-per-group'] ?? '',
        'rtc-peers-per-group',
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
        'rtc-groups': String(acceptedInput.groups),
        'rtc-peers-per-group': String(acceptedInput.peersPerGroup),
        'rtc-lookups': String(acceptedInput.lookups)
    };
    const issues = [
        ...collectParsingIssues([groups, peersPerGroup, lookups]),
        ...Object.entries(expected)
            .filter(([name, value]) => options[name] !== value)
            .map(([name, value]) => rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`))
    ];
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: acceptedInput };
}

function validateResult(
    input: WebRtcGroupManagerPeerOwnersInput,
    result: WebRtcGroupManagerPeerOwnersResult
): RtcBaselineIssueDto[] {
    const counts = [result.ownedLookups, result.totalOwnerGroups, result.desiredPeerCount];
    return validateRules([
        {
            valid: JSON.stringify([result.groupCount, result.peersPerGroup, result.lookups]) ===
                JSON.stringify([input.groups, input.peersPerGroup, input.lookups]),
            path: '$.rawEvidence.input',
            code: 'input-mismatch',
            message: 'Unexpected input.'
        },
        {
            valid: counts.every(Number.isSafeInteger) && counts.every((count) => count >= 0),
            path: '$.rawEvidence.counts',
            code: 'invalid-count',
            message: 'Expected bounded counts.'
        },
        {
            valid: JSON.stringify(counts) ===
                JSON.stringify([input.lookups, input.lookups * input.peersPerGroup, input.groups]),
            path: '$.rawEvidence.owners',
            code: 'ownership-result-mismatch',
            message: 'Unexpected ownership result.'
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

function toRawEvidence(result: WebRtcGroupManagerPeerOwnersResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        groupCount: result.groupCount,
        peersPerGroup: result.peersPerGroup,
        lookups: result.lookups,
        ownedLookups: result.ownedLookups,
        totalOwnerGroups: result.totalOwnerGroups,
        desiredPeerCount: result.desiredPeerCount
    };
}

async function main(): Promise<void> {
    const parsed = parseWebRtcGroupManagerPeerOwnersArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const dispatched = await runRtcBaselineAcceptedWorkerCli({
        parsed: parsed.value,
        runAccepted: (worker) =>
            runWebRtcGroupManagerPeerOwnersAcceptedSamples({
                worker,
                run: () => runWebRtcGroupManagerPeerOwners(worker.input)
            }),
        writeOutput: (output) => console.log(output)
    });
    if (dispatched.handled) {
        return;
    }
    const diagnostic = dispatched.diagnostic;
    const results = [];
    for (let run = 1; run <= diagnostic.runs; run += 1) {
        results.push({ run, ...(await runWebRtcGroupManagerPeerOwners(diagnostic.input)) });
    }
    const output = {
        createdAt: new Date().toISOString(),
        input: {
            groupCount: diagnostic.input.groups,
            peersPerGroup: diagnostic.input.peersPerGroup,
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
