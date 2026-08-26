import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { type AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupTopologyConfigMutationReceipt, GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

import type { PersistedAppInboxAttempt } from '../../../integration/postgres/test-support/postgres-app-inbox-attempt-observation.ts';
import { toPSqlSql } from '../../../integration/postgres/test-support/postgres-sql-adapter.ts';

export type PostgresSql = PSqlSql & Readonly<{ end(): Promise<void>; }>;

export interface TopologyWorkerBarrier {
    readonly readyDirectoryPath: string;
    readonly releaseFilePath: string;
}

export interface TopologyAppInboxWorkerInput {
    readonly command: 'put-config' | 'put-override';
    readonly barrierPhase: 'topology-read' | 'transaction';
    readonly groupRef: GroupRef;
    readonly atEpochMs: number;
    readonly traceFilePath: string;
    readonly barrier: TopologyWorkerBarrier;
    readonly request: Readonly<{
        requestId: string;
        updatedByPrincipalId: string;
        config: GroupTopologyConfigPatch;
        expiresAtEpochMs?: number;
    }>;
}

export interface TopologyAppInboxWorkerOutput {
    readonly requestId: string;
    readonly status: 'applied' | 'rejected';
    readonly attemptCount: number;
    readonly acceptedVersion: number | null;
    readonly outboxIds: readonly string[];
    readonly receipt: GroupTopologyConfigMutationReceipt | null;
    readonly failure: AppInboxFailure | null;
}

export interface TopologyAppOutboxWorkerInput {
    readonly groupSnapshot: GroupSnapshot;
    readonly targetKey: Readonly<{
        topicId: string;
        resourceId: string;
        contextId: string;
    }>;
    readonly atEpochMs: number;
    readonly traceFilePath: string;
    readonly barrier: TopologyWorkerBarrier;
}

export interface TopologyAppOutboxWorkerOutput {
    readonly resourceId: string;
    readonly status: string;
    readonly attemptCount: number;
}

export interface TopologyWorkerTrace {
    readonly backendPid: number;
    readonly barrierWaitCount: number;
    readonly topologyReadBarrierPrimitive?: 'readRuntimeStateBatch' | null;
    readonly attempts?: readonly PersistedAppInboxAttempt[];
}

const ROOT_DENO_CONFIG_PATH = fileURLToPath(
    new URL('../../../../../../deno.json', import.meta.url)
);
const APP_INBOX_WORKER_PATH = fileURLToPath(
    new URL('./postgres-topology-app-inbox-worker.ts', import.meta.url)
);
const APP_OUTBOX_WORKER_PATH = fileURLToPath(
    new URL('../../../integration/postgres/test-support/postgres-topology-app-outbox-worker.ts', import.meta.url)
);

export async function createPostgresSql(databaseUrl: string): Promise<PostgresSql> {
    const postgres = await import('postgres');
    const rawSql = postgres.default(databaseUrl, { max: 2, idle_timeout: 1 });
    return Object.assign(toPSqlSql(rawSql), {
        end: async (): Promise<void> => await rawSql.end()
    });
}

export async function seedTopologyGroup(sql: PSqlSql, snapshot: GroupSnapshot): Promise<void> {
    const repository = createTestGroupStateRepository(
        new PSqlRuntimeStateRepository(sql),
        new PSqlGroupStateEventRepository(sql)
    );
    const inserted = await repository.insertGroup(snapshot.group);
    if (inserted.status !== 'applied') {
        throw new Error('Topology group seed was not inserted');
    }
    for (const member of snapshot.members) {
        await repository.putMember(member);
    }
}

export function spawnTopologyAppInboxWorker(
    databaseUrl: string,
    input: TopologyAppInboxWorkerInput
): Promise<TopologyAppInboxWorkerOutput> {
    return spawnWorker<TopologyAppInboxWorkerOutput>(databaseUrl, APP_INBOX_WORKER_PATH, input);
}

export function spawnTopologyAppOutboxWorker(
    databaseUrl: string,
    input: TopologyAppOutboxWorkerInput
): Promise<TopologyAppOutboxWorkerOutput> {
    return spawnWorker<TopologyAppOutboxWorkerOutput>(databaseUrl, APP_OUTBOX_WORKER_PATH, input);
}

export async function readTopologyWorkerTrace(traceFilePath: string): Promise<TopologyWorkerTrace> {
    return JSON.parse(await readFile(traceFilePath, 'utf8')) as TopologyWorkerTrace;
}

export async function waitForTopologyWorkerParticipants<T>(
    readyDirectoryPath: string,
    participantCount: number,
    workers: readonly Promise<T>[]
): Promise<void> {
    const waitForMarkers = async (): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            try {
                if ((await readdir(readyDirectoryPath)).length >= participantCount) {
                    return;
                }
            }
            catch (error) {
                if (!isMissingFileError(error)) {
                    throw error;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for topology workers: ${readyDirectoryPath}`);
    };
    await Promise.race([
        waitForMarkers(),
        Promise.race(workers).then(() => {
            throw new Error(`Topology worker exited before barrier: ${readyDirectoryPath}`);
        })
    ]);
}

export async function cleanupTopologyApplicationRows(
    sql: PSqlSql,
    applicationId: string
): Promise<void> {
    const pattern = `%${applicationId}%`;
    await sql`delete from resource_inbox_results where ris_resource like ${pattern}`;
    await sql`delete from resource_inbox where ri_resource like ${pattern}`;
    await sql`delete from runtime_state_store where store_value like ${pattern}`;
}

export function topologyGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'principal' as const, principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null
    };
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            ...groupRef,
            displayName: 'Topology concurrency room',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            created: audit,
            updated: audit
        }),
        members: [
            {
                ...groupRef,
                principalId: 'owner',
                role: 'owner',
                status: 'active',
                invitedByPrincipalId: null,
                invitationExpiresAtEpochMs: null,
                left: null,
                removed: null,
                banned: null,
                joined: audit,
                updated: audit
            }
        ],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
}

function spawnWorker<Output>(
    databaseUrl: string,
    workerPath: string,
    input: object
): Promise<Output> {
    const child = spawn(
        process.env.DENO_BIN ?? 'deno',
        [
            'run',
            '-A',
            '--unstable-temporal',
            '--node-modules-dir=none',
            '--no-lock',
            '--config',
            ROOT_DENO_CONFIG_PATH,
            workerPath
        ],
        {
            cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)),
            env: {
                ...process.env,
                DATABASE_URL: databaseUrl,
                RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT: JSON.stringify(input)
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    return new Promise<Output>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
            const lastLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
            if (code !== 0 || !lastLine) {
                reject(new Error(`Topology worker failed (${code})\n${stdout}\n${stderr}`));
                return;
            }
            try {
                resolve(JSON.parse(lastLine) as Output);
            }
            catch (error) {
                reject(new Error(`Topology worker produced invalid JSON: ${lastLine}`, { cause: error }));
            }
        });
    });
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
