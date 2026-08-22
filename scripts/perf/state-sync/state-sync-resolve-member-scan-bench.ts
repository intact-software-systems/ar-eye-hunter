import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync-routing.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

const CLIENTS = Number(
    Deno.args.find((arg) => arg.startsWith('--clients='))?.slice('--clients='.length) ??
        '10000'
);
const SESSIONS_PER_CLIENT = Number(
    Deno.args.find((arg) => arg.startsWith('--sessions-per-client='))
        ?.slice('--sessions-per-client='.length) ??
        '5'
);
const MEMBERS = Number(
    Deno.args.find((arg) => arg.startsWith('--members='))?.slice('--members='.length) ??
        '100'
);
const RUNS = Number(
    Deno.args.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
        '5'
);
const OUT = Deno.args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'tmp/perf/results/state-sync-resolve-member-scan.json';

const now = 1_700_000_000_000;
const liveUntil = now + 60_000;

const inspectionCounter = { clientSessionLiveChecks: 0 };
const clientSnapshots = Array.from({ length: CLIENTS }, (_, index) => createClientSnapshot(index, inspectionCounter));
const memberPrincipalIds = Array.from(
    { length: Math.min(MEMBERS, CLIENTS) },
    (_, index) => `principal-${index}`
);
const groupSnapshot = createGroupSnapshot(memberPrincipalIds);
const message: ALMessage = {
    id: {
        msgId: 'message-1',
        senderId: 'server-1'
    },
    route: {
        path: 'event',
        contextId: groupSnapshot.group.groupId,
        targetId: groupSnapshot.group.groupId
    },
    payload: {
        typeId: AppTopics.groupStateSnapshot,
        resource: JSON.stringify(groupSnapshot)
    }
};
const server = {
    connections: new Map(
        memberPrincipalIds.flatMap((principalId) =>
            Array.from({ length: SESSIONS_PER_CLIENT }, (_, sessionIndex) => {
                const connectionId = toSessionId(principalId, sessionIndex);
                return [connectionId, { id: connectionId, isOpen: true }] as const;
            })
        )
    )
};

const results = [];
for (let run = 1; run <= RUNS; run += 1) {
    inspectionCounter.clientSessionLiveChecks = 0;
    const start = performance.now();
    const recipients = resolveStateSyncRecipients(
        server as never,
        message,
        {
            readClientSnapshots: () => clientSnapshots,
            now: () => now
        }
    );
    const durationMs = performance.now() - start;
    results.push({
        run,
        durationMs,
        recipients: recipients?.length ?? 0,
        clientSessionLiveChecks: inspectionCounter.clientSessionLiveChecks
    });
}

await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
await Deno.writeTextFile(
    OUT,
    `${
        JSON.stringify(
            {
                benchmark: 'state-sync-resolve-member-scan',
                clients: CLIENTS,
                sessionsPerClient: SESSIONS_PER_CLIENT,
                members: MEMBERS,
                runs: RUNS,
                results
            },
            null,
            2
        )
    }\n`
);

function createClientSnapshot(
    index: number,
    counter: { clientSessionLiveChecks: number; }
): ClientSnapshot {
    const principalId = `principal-${index}`;
    return {
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' }
        },
        instances: [],
        activeSessions: Array.from({ length: SESSIONS_PER_CLIENT }, (_, sessionIndex) => {
            const session = {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId,
                clientInstanceId: `browser-${sessionIndex}`,
                sessionId: toSessionId(principalId, sessionIndex),
                status: 'active',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: now,
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now
            };
            Object.defineProperty(session, 'expiresAtEpochMs', {
                enumerable: true,
                get() {
                    counter.clientSessionLiveChecks += 1;
                    return liveUntil;
                }
            });
            return session;
        }) as ClientSnapshot['activeSessions'],
        isOnline: true,
        activeSessionCount: SESSIONS_PER_CLIENT
    };
}

function createGroupSnapshot(memberPrincipalIds: readonly string[]): GroupSnapshot {
    return {
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            displayName: 'group-1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' }
        },
        members: memberPrincipalIds.map((principalId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId,
            role: 'member',
            status: 'active',
            joined: { atEpochMs: 1, byServiceId: 'perf' },
            updated: { atEpochMs: 1, byServiceId: 'perf' }
        })),
        activeSessions: memberPrincipalIds.map((principalId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId,
            sessionId: toSessionId(principalId, 0),
            connectedAtEpochMs: now,
            lastHeartbeatAtEpochMs: now,
            expiresAtEpochMs: liveUntil
        })),
        memberCount: memberPrincipalIds.length,
        onlineMemberCount: memberPrincipalIds.length
    };
}

function toSessionId(principalId: string, sessionIndex: number): string {
    return `${principalId}:session-${sessionIndex}`;
}
