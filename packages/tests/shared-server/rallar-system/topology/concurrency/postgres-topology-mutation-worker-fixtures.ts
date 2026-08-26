import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

interface TopologyMutationWorkerRequest {
    readonly requestId?: string;
    readonly updatedByPrincipalId: string;
}

type TopologyMutationWorkerInput =
    & Readonly<{
        groupRef: GroupRef;
        atEpochMs: number;
        traceFilePath: string;
        barrier: Readonly<{ readyDirectoryPath: string; releaseFilePath: string; }>;
    }>
    & (
        | Readonly<{
            command: 'topology-config-put';
            request: TopologyMutationWorkerRequest & Readonly<{ config: GroupTopologyConfigPatch; }>;
        }>
        | Readonly<{
            command: 'topology-config-delete';
            request: TopologyMutationWorkerRequest;
        }>
    );

export type { TopologyMutationWorkerInput };

export interface TopologyMutationWorkerOutput {
    readonly operation: TopologyMutationWorkerInput['command'];
    readonly requestId: string;
    readonly commandHash: string;
    readonly attemptCount: number;
    readonly acceptedStorageRevision: number | null;
    readonly acceptedCausalRevision: JsonWireObject | null;
    readonly acceptedVersion: number | null;
    readonly outboxIds: readonly string[];
    readonly domainStatus: 'applied' | 'no-op' | 'rejected';
}

export interface TopologyMutationWorkerTrace {
    readonly backendPid: number;
    readonly barrierWaitCount: number;
    readonly attempts: readonly Readonly<{
        resourceId: string;
        attempt: number;
        classification: 'accepted' | 'retryable' | 'non-retryable';
        status: string;
        retryDelayMs: number;
    }>[];
}

export interface TopologyMutationWorkerHandle {
    readonly done: Promise<TopologyMutationWorkerOutput>;
}

const ROOT_DENO_CONFIG_PATH = fileURLToPath(
    new URL('../../../../../../deno.json', import.meta.url)
);
const STATE_MUTATION_WORKER_PATH = fileURLToPath(
    new URL('../../../integration/postgres/test-support/postgres-expiry-worker.ts', import.meta.url)
);

export function spawnTopologyMutationWorker(
    databaseUrl: string,
    input: TopologyMutationWorkerInput
): TopologyMutationWorkerHandle {
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
            STATE_MUTATION_WORKER_PATH
        ],
        {
            cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)),
            env: {
                ...process.env,
                DATABASE_URL: databaseUrl,
                RALLAR_EXPIRY_WORKER_INPUT: JSON.stringify(input)
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
    return {
        done: new Promise<TopologyMutationWorkerOutput>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Topology worker failed (${code})\n${stdout}\n${stderr}`));
                    return;
                }
                const lastLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
                if (!lastLine) {
                    reject(new Error(`Topology worker produced no JSON\n${stderr}`));
                    return;
                }
                try {
                    resolve(JSON.parse(lastLine) as TopologyMutationWorkerOutput);
                }
                catch (error) {
                    reject(
                        new Error(`Topology worker produced invalid JSON: ${lastLine}`, {
                            cause: error
                        })
                    );
                }
            });
        })
    };
}

export async function readTopologyMutationWorkerTrace(
    traceFilePath: string
): Promise<TopologyMutationWorkerTrace> {
    return JSON.parse(await readFile(traceFilePath, 'utf8')) as TopologyMutationWorkerTrace;
}
