import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { readOwnedAppInboxResourceIds } from '../../../rallar-system/app-inbox/postgres/read-owned-app-inbox-resource-ids.ts';
import { readDirectResourceOutboxEntries } from '../../../rallar-system/app-outbox/direct-resource-outbox-lifecycle.ts';
import { assertWorkerOutboxLifecycle, type WorkerOutboxEffect } from '../../../rallar-system/app-outbox/postgres/worker-outbox-lifecycle-assertions.ts';
import { findSingleRetriedAppInboxAttemptSequence } from '../test-support/postgres-app-inbox-attempt-observation.ts';
import { waitForPostgresAppInboxWorkerParticipants } from '../test-support/postgres-worker-barrier.ts';
export interface WorkerBarrier {
    readonly readyDirectoryPath: string;
    readonly releaseFilePath: string;
}

export interface WorkerInput {
    readonly command:
        | 'client-heartbeat'
        | 'client-disconnect'
        | 'client-reconnect'
        | 'group-join'
        | 'group-ban'
        | 'group-presence-connect'
        | 'group-presence-heartbeat'
        | 'group-presence-disconnect';
    readonly scope: StateScope;
    readonly atEpochMs: number;
    readonly traceFilePath: string;
    readonly barrier: WorkerBarrier;
    readonly principalId?: string;
    readonly clientInstanceId?: string;
    readonly groupId?: string;
    readonly targetPrincipalId?: string;
    readonly sessionId?: string;
    readonly request: JsonWireObject;
}

interface WorkerOutput {
    readonly operation: WorkerInput['command'];
    readonly requestId: string;
    readonly commandHash: string;
    readonly attemptCount: number;
    readonly acceptedStorageRevision: number | null;
    readonly acceptedCausalRevision: JsonWireObject | null;
    readonly acceptedVersion: number | null;
    readonly outboxIds: readonly string[];
    readonly domainStatus: 'applied' | 'no-op' | 'rejected';
}

interface WorkerTraceAttempt {
    readonly resourceId: string;
    readonly attempt: number;
    readonly classification: 'accepted' | 'retryable' | 'non-retryable';
    readonly status: string;
    readonly retryDelayMs: number;
}

interface WorkerTrace {
    readonly backendPid: number;
    readonly barrierWaitCount: number;
    readonly attempts: readonly WorkerTraceAttempt[];
}

export interface WorkerHandle {
    readonly done: Promise<WorkerOutput>;
}
interface AssertOneWorkerRebasedInput {
    readonly sql: PSqlSql;
    readonly scope: StateScope;
    readonly outputs: readonly WorkerOutput[];
    readonly traces: readonly WorkerTrace[];
}

const ROOT_DENO_CONFIG_PATH = fileURLToPath(
    new URL('../../../../../../deno.json', import.meta.url)
);
const STATE_MUTATION_WORKER_PATH = fileURLToPath(
    new URL('../test-support/postgres-expiry-worker.ts', import.meta.url)
);
export function spawnWorker(databaseUrl: string, input: WorkerInput): WorkerHandle {
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
        done: new Promise<WorkerOutput>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`State mutation worker failed (${code})\n${stdout}\n${stderr}`));
                    return;
                }
                const lastLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
                if (!lastLine) {
                    reject(new Error(`State mutation worker produced no JSON\n${stderr}`));
                    return;
                }
                try {
                    const parsed: JsonWireValue = JSON.parse(lastLine);
                    resolve(decodeWorkerOutput(parsed));
                }
                catch (error) {
                    reject(
                        new Error(`State mutation worker produced invalid JSON: ${lastLine}`, {
                            cause: error
                        })
                    );
                }
            });
        })
    };
}

export function workerBarrier(tmpDirPath: string, name: string): WorkerInput['barrier'] {
    return {
        readyDirectoryPath: path.join(tmpDirPath, `${name}-ready`),
        releaseFilePath: path.join(tmpDirPath, `${name}-release`)
    };
}

export async function runBarrierWorkerPair(
    databaseUrl: string,
    inputs: readonly WorkerInput[]
): Promise<
    Readonly<{
        outputs: readonly WorkerOutput[];
        traces: readonly WorkerTrace[];
    }>
> {
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs.map((input) => input.barrier.readyDirectoryPath)).size).toBe(1);
    expect(new Set(inputs.map((input) => input.barrier.releaseFilePath)).size).toBe(1);
    const [firstInput] = inputs;
    if (!firstInput) {
        throw new TypeError('Barrier worker pair requires two inputs');
    }
    const handles = inputs.map((input) => spawnWorker(databaseUrl, input));
    try {
        await waitForPostgresAppInboxWorkerParticipants(
            firstInput.barrier.readyDirectoryPath,
            handles.length,
            handles.map((handle) => handle.done)
        );
        await writeFile(firstInput.barrier.releaseFilePath, 'release', 'utf8');
        return {
            outputs: await Promise.all(handles.map((handle) => handle.done)),
            traces: await Promise.all(inputs.map((input) => readTrace(input.traceFilePath)))
        };
    }
    finally {
        await Promise.allSettled(handles.map((handle) => handle.done));
    }
}

export function assertIndependentBarrierWorkers(traces: readonly WorkerTrace[]): void {
    expect(traces).toHaveLength(2);
    expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
    expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
}

export async function readTrace(traceFilePath: string): Promise<WorkerTrace> {
    const parsed: JsonWireValue = JSON.parse(await readFile(traceFilePath, 'utf8'));
    return decodeWorkerTrace(parsed);
}

export function expectCompactWorkerOutput(output: WorkerOutput): void {
    expect(Object.keys(output).sort()).toEqual([
        'acceptedCausalRevision',
        'acceptedStorageRevision',
        'acceptedVersion',
        'attemptCount',
        'commandHash',
        'domainStatus',
        'operation',
        'outboxIds',
        'requestId'
    ]);
    expect(output.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.requestId).toMatch(/\S/u);
    expect(output.attemptCount).toBeGreaterThanOrEqual(1);
    expect(output.attemptCount).toBeLessThanOrEqual(3);
    if (output.domainStatus === 'applied') {
        expect(output.outboxIds).toHaveLength(output.operation.startsWith('client-') ? 2 : 1);
        output.outboxIds.forEach((outboxId) => expect(outboxId).toMatch(/\S/u));
    }
    else if (output.domainStatus === 'no-op') {
        expect(output).toMatchObject({
            acceptedStorageRevision: null,
            acceptedCausalRevision: null,
            acceptedVersion: null,
            outboxIds: []
        });
    }
}

interface ExpectPendingWorkerOutboxesInput {
    readonly sql: PSqlSql;
    readonly outputs: readonly WorkerOutput[];
    readonly kind: 'client' | 'group';
    readonly effects: readonly WorkerOutboxEffect[];
}

export async function expectPendingWorkerOutboxes(
    input: ExpectPendingWorkerOutboxesInput
): Promise<void> {
    const outboxIds = input.outputs.flatMap((output) => output.outboxIds);
    assertWorkerOutboxLifecycle({
        entries: await readDirectResourceOutboxEntries(input.sql, outboxIds),
        outputs: input.outputs,
        kind: input.kind,
        effects: input.effects
    });
}

export async function assertOneWorkerRebased(input: AssertOneWorkerRebasedInput): Promise<void> {
    const { outputs, traces } = input;
    expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
    expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
    const loserIndex = outputs.findIndex((output) => output.attemptCount === 2);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect(
        findSingleRetriedAppInboxAttemptSequence({
            traces,
            ownedResourceIds: await readOwnedAppInboxResourceIds({
                sql: input.sql,
                scope: input.scope,
                requestIds: outputs.map((output) => output.requestId)
            })
        }).map((attempt) => ({
            attempt: attempt.attempt,
            classification: attempt.classification,
            retryDelayMs: attempt.retryDelayMs
        }))
    ).toEqual([
        { attempt: 1, classification: 'retryable', retryDelayMs: 1 },
        { attempt: 2, classification: 'accepted', retryDelayMs: 0 }
    ]);
}

export function requireArrayEntry<T>(values: readonly T[], index: number, label: string): T {
    const value = values[index];
    if (value === undefined) {
        throw new TypeError(`${label} is missing at index ${index}`);
    }
    return value;
}

function decodeWorkerOutput(value: JsonWireValue): WorkerOutput {
    const output = requireJsonWireObject(value, 'Worker output');
    const operation = requireWorkerOperation(output.operation);
    const requestId = requireString(output.requestId, 'Worker output requestId');
    const commandHash = requireString(output.commandHash, 'Worker output commandHash');
    const attemptCount = requireNumber(output.attemptCount, 'Worker output attemptCount');
    const acceptedStorageRevision = requireNullableNumber(
        output.acceptedStorageRevision,
        'Worker output acceptedStorageRevision'
    );
    const acceptedCausalRevision = output.acceptedCausalRevision === null
        ? null
        : requireJsonWireObject(
            output.acceptedCausalRevision,
            'Worker output acceptedCausalRevision'
        );
    const acceptedVersion = requireNullableNumber(
        output.acceptedVersion,
        'Worker output acceptedVersion'
    );
    const outboxIds = requireStringArray(output.outboxIds, 'Worker output outboxIds');
    const domainStatus = requireDomainStatus(output.domainStatus);
    return {
        operation,
        requestId,
        commandHash,
        attemptCount,
        acceptedStorageRevision,
        acceptedCausalRevision,
        acceptedVersion,
        outboxIds,
        domainStatus
    };
}

function decodeWorkerTrace(value: JsonWireValue): WorkerTrace {
    const trace = requireJsonWireObject(value, 'Worker trace');
    if (!Array.isArray(trace.attempts)) {
        throw new TypeError('Worker trace attempts must be an array');
    }
    return {
        backendPid: requireNumber(trace.backendPid, 'Worker trace backendPid'),
        barrierWaitCount: requireNumber(trace.barrierWaitCount, 'Worker trace barrierWaitCount'),
        attempts: trace.attempts.map((attempt) => {
            const item = requireJsonWireObject(attempt, 'Worker trace attempt');
            return {
                resourceId: requireString(item.resourceId, 'Worker trace resourceId'),
                attempt: requireNumber(item.attempt, 'Worker trace attempt'),
                classification: requireClassification(item.classification),
                status: requireString(item.status, 'Worker trace status'),
                retryDelayMs: requireNumber(item.retryDelayMs, 'Worker trace retryDelayMs')
            };
        })
    };
}

function requireJsonWireObject(value: JsonWireValue, label: string): JsonWireObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return Object.fromEntries(Object.entries(value));
}

function requireString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireNumber(value: JsonWireValue | undefined, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number`);
    }
    return value;
}

function requireNullableNumber(value: JsonWireValue | undefined, label: string): number | null {
    return value === null ? null : requireNumber(value, label);
}

function requireStringArray(value: JsonWireValue | undefined, label: string): readonly string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value.map((item) => requireString(item, `${label} item`));
}

function requireWorkerOperation(value: JsonWireValue | undefined): WorkerInput['command'] {
    if (
        value !== 'client-heartbeat' &&
        value !== 'client-disconnect' &&
        value !== 'client-reconnect' &&
        value !== 'group-join' &&
        value !== 'group-ban' &&
        value !== 'group-presence-connect' &&
        value !== 'group-presence-heartbeat' &&
        value !== 'group-presence-disconnect'
    ) {
        throw new TypeError('Worker output operation is invalid');
    }
    return value;
}

function requireDomainStatus(value: JsonWireValue | undefined): WorkerOutput['domainStatus'] {
    if (value !== 'applied' && value !== 'no-op' && value !== 'rejected') {
        throw new TypeError('Worker output domainStatus is invalid');
    }
    return value;
}

function requireClassification(
    value: JsonWireValue | undefined
): WorkerTraceAttempt['classification'] {
    if (value !== 'accepted' && value !== 'retryable' && value !== 'non-retryable') {
        throw new TypeError('Worker trace classification is invalid');
    }
    return value;
}
