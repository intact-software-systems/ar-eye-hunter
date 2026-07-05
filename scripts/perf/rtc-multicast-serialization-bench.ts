import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { newALMulticastMessage } from '../../../packages/shared/al-contracts/al-contract.ts';
import { WebRtcOverlayMulticastService } from '../../../packages/shared/multicast/WebRtcOverlayMulticastService.ts';

type Args = Readonly<{
    peerCounts: readonly number[];
    payloadBytes: readonly number[];
    runs: number;
    out: string;
}>;

type CaseResult = Readonly<{
    peerCount: number;
    payloadBytes: number;
    run: number;
    planDurationMs: number;
    serializeDurationMs: number;
    originalSerializeDurationMs: number;
    transportMessages: number;
    uniqueSerializedMessages: number;
    totalSerializedBytes: number;
    originalSerializedBytes: number;
    allTransportMessagesIdentical: boolean;
}>;

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const readValue = (name: string, fallback: string) => {
        const prefix = `--${name}=`;
        return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
    };
    const readNumbers = (name: string, fallback: string) =>
        readValue(name, fallback)
            .split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isFinite(value) && value > 0);

    return {
        peerCounts: readNumbers('peer-counts', '10,100,1000'),
        payloadBytes: readNumbers('payload-bytes', '4096,65536'),
        runs: Number(readValue('runs', '3')),
        out: readValue(
            'out',
            'tmp/perf/results/rtc-multicast-serialization.json',
        ),
    };
}

function createConnectionService(peerIds: readonly string[]) {
    return {
        input: {
            sessionId: 'self',
        },
        readyPeerIdsForLane: () => [...peerIds],
    };
}

function createOverlayContext(peerIds: readonly string[]) {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const groupId = 'group-1';
    const memberSessionIds = ['self', ...peerIds];

    return {
        overlayId: groupId,
        room: {
            group: {
                applicationId,
                workspaceId,
                groupId,
                displayName: 'Group 1',
                kind: 'room',
                status: 'active',
                joinMode: 'open',
                metadata: {},
                snapshotVersion: 1,
                metadataVersion: 0,
                rosterVersion: 1,
                presenceVersion: 0,
                created: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
                updated: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
            },
            members: memberSessionIds.map((sessionId) => ({
                applicationId,
                workspaceId,
                groupId,
                principalId: sessionId,
                role: 'member',
                status: 'active',
                joined: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
                updated: {
                    atEpochMs: 1,
                    byPrincipalId: 'owner',
                },
            })),
            activeSessions: memberSessionIds.map((sessionId) => ({
                applicationId,
                workspaceId,
                groupId,
                sessionId,
                principalId: sessionId,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: 60_001,
            })),
            memberCount: memberSessionIds.length,
            onlineMemberCount: memberSessionIds.length,
        },
        overlay: {
            overlayId: groupId,
            name: 'Group 1',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: peerIds,
            overlayVersion: 1,
            updatedAtEpochMs: 1,
        },
    };
}

function createPayload(payloadBytes: number) {
    return {
        text: 'x'.repeat(payloadBytes),
        createdAtEpochMs: 1,
    };
}

function createPeerIds(peerCount: number): readonly string[] {
    return Array.from({ length: peerCount }, (_, index) =>
        `peer-${String(index + 1).padStart(5, '0')}`
    );
}

function runCase(
    peerCount: number,
    payloadBytes: number,
    run: number,
): CaseResult {
    const peerIds = createPeerIds(peerCount);
    const service = new WebRtcOverlayMulticastService(
        'group-1',
        createConnectionService(peerIds) as never,
    );
    const msg = newALMulticastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId: `msg-${peerCount}-${payloadBytes}-${run}`,
            contextId: 'group-1',
        },
        {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
        },
        'chat.message.v1',
        createPayload(payloadBytes),
        {
            qos: {
                durability: {
                    algo: 'volatile',
                },
            },
        },
    );
    const context = createOverlayContext(peerIds);

    const planStart = performance.now();
    const plan = service.createOriginatingPlan(msg, context as never);
    const planDurationMs = performance.now() - planStart;

    const originalStart = performance.now();
    const originalSerialized = JSON.stringify(msg);
    const originalSerializeDurationMs = performance.now() - originalStart;

    const serializeStart = performance.now();
    const serialized = plan.transportMessages.map((message) =>
        JSON.stringify(message)
    );
    const serializeDurationMs = performance.now() - serializeStart;
    const uniqueSerializedMessages = new Set(serialized).size;

    return {
        peerCount,
        payloadBytes,
        run,
        planDurationMs,
        serializeDurationMs,
        originalSerializeDurationMs,
        transportMessages: plan.transportMessages.length,
        uniqueSerializedMessages,
        totalSerializedBytes: serialized.reduce(
            (total, value) => total + value.length,
            0,
        ),
        originalSerializedBytes: originalSerialized.length,
        allTransportMessagesIdentical: uniqueSerializedMessages <= 1,
    };
}

const args = parseArgs();
const results: CaseResult[] = [];

for (const peerCount of args.peerCounts) {
    for (const payloadBytes of args.payloadBytes) {
        for (let run = 1; run <= args.runs; run += 1) {
            results.push(runCase(peerCount, payloadBytes, run));
        }
    }
}

const output = {
    command: process.argv.join(' '),
    peerCounts: args.peerCounts,
    payloadBytes: args.payloadBytes,
    runs: args.runs,
    results,
};

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
