import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import * as diagnosticFiles from 'node:fs/promises';
import { normalize } from 'node:path';
import process from 'node:process';
import type { Sql } from 'postgres';
import { queryStateWriteDurableEvidence } from './api-v1-state-write-durable-evidence.ts';
import { createStateWriteBenchmarkSql } from './create-state-write-benchmark-sql.ts';
import {
    createStateWriteServiceRuntime,
    type StateWriteServiceRuntimeContext
} from './create-state-write-service-runtime.ts';
import { parseGroupTopologyRegressionReasons } from './pool-group-topology-state-write-position-balanced-results.mjs';
import {
    assertStateWriteSchemaReady,
    readStateWritePostgresCounters,
    readStateWriteWalDifference,
    startStateWriteLockWaitSampler,
    type StateWritePostgresCounters
} from './read-state-write-postgres-counters.ts';
import {
    createStateWriteBenchmarkArtifact,
    readBenchmarkGitIdentity,
    type BenchmarkGitIdentity,
    type StateWriteBenchmarkRegressionReason
} from './state-write/api-v1-state-write-benchmark-artifact.ts';
import {
    parseBenchmarkOptions,
    STATE_WRITE_REQUIRED_CONCURRENCY,
    type StateWriteBenchmarkOptions
} from './state-write/api-v1-state-write-benchmark-options.ts';
import { selectStateWriteRegressionReasons } from './state-write/api-v1-state-write-regression-reasons.ts';
import { writeStateWriteBenchmarkOutput } from './state-write/state-write-benchmark-output.ts';
import {
    STATE_WRITE_DIAGNOSTIC_BUDGET,
    type StateWriteDiagnosticPhase
} from './state-write/state-write-diagnostic-projection.ts';
import { StateWriteDiagnosticWriter } from './state-write/state-write-diagnostic-writer.ts';
import {
    computeRunSample,
    newRunContext,
    summarizeSamples,
    type RunSample,
    type WorkloadEvidence
} from './state-write/state-write-measurement.ts';
import { seedCompleteState } from './state-write/state-write-seed.ts';
import type { StateWriteBenchmarkCommand, StateWriteDiagnosticCommand } from './state-write/state-write-workload.ts';
import {
    createCommands,
    executeMeasuredWorkload,
    MUTATION_MIX,
    StateWriteCommandCapture,
    WORKLOADS
} from './state-write/state-write-workload.ts';
const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';
if (import.meta.main) {
    await main();
}

function validateBenchmarkRunOptions(
    options: StateWriteBenchmarkOptions
): Either<Error, StateWriteBenchmarkOptions> {
    if (options.backend !== 'postgres') {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --backend=postgres; received ${options.backend}`
            )
        );
    }
    if (options.warmup !== 1) {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --warmup=1; received ${options.warmup}`
            )
        );
    }
    if (options.runs < 3) {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --runs>=3; received ${options.runs}`
            )
        );
    }
    if (options.concurrency !== STATE_WRITE_REQUIRED_CONCURRENCY) {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --concurrency=${STATE_WRITE_REQUIRED_CONCURRENCY}; ` +
                    `received ${options.concurrency}`
            )
        );
    }
    return Either.ofRight(options);
}

interface BenchmarkConfiguration {
    readonly options: StateWriteBenchmarkOptions;
    readonly gitIdentity: BenchmarkGitIdentity;
    readonly regressionReasons: readonly StateWriteBenchmarkRegressionReason[];
    readonly databaseUrl: string;
    readonly runId: string;
}

async function readBenchmarkConfiguration(): Promise<BenchmarkConfiguration> {
    const options = parseBenchmarkOptions(Deno.args);
    const validation = validateBenchmarkRunOptions(options);
    if (validation.left) {
        throw validation.left;
    }
    const outputIssues = validatePerfOutputPath(options.out);
    if (outputIssues.length > 0) {
        throw new Error(outputIssues.join('; '));
    }
    const gitIdentity = await readBenchmarkGitIdentity();
    const reasonsText = options.regressionReasonsFile === undefined
        ? undefined
        : await Deno.readTextFile(options.regressionReasonsFile);
    const precommittedReasons = parseGroupTopologyRegressionReasons(
        reasonsText,
        gitIdentity
    );
    const regressionReasons = selectStateWriteRegressionReasons(
        options.regressionReasonProfile,
        precommittedReasons
    );

    const databaseUrl = Deno.env.get('DATABASE_URL')?.trim() ||
        DEFAULT_DATABASE_URL;
    const runId = `state-write-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    return { options, gitIdentity, regressionReasons, databaseUrl, runId };
}

async function main(): Promise<void> {
    const { options, gitIdentity, regressionReasons, databaseUrl, runId } = await readBenchmarkConfiguration();
    const adminSql = createStateWriteBenchmarkSql({
        databaseUrl,
        maxConnections: 10,
        applicationName: `${runId}-admin`
    });
    const serviceSql = [0, 1].map((index) =>
        createStateWriteBenchmarkSql({
            databaseUrl,
            maxConnections: options.concurrency,
            applicationName: `${runId}-service-${index}`
        })
    );

    const diagnostics = new StateWriteDiagnosticWriter(
        options.diagnostics,
        STATE_WRITE_DIAGNOSTIC_BUDGET,
        diagnosticFiles
    );
    const performanceTimeOriginEpochMs = options.diagnostics.kind === 'enabled' ? performance.timeOrigin : undefined;
    let completed = false;
    try {
        await diagnostics.start(options.out);
        await assertStateWriteSchemaReady(adminSql);
        const workloads = await runBenchmarkWorkloads({
            adminSql,
            serviceSql,
            runId,
            options,
            diagnostics,
            performanceTimeOriginEpochMs
        });

        const artifact = createStateWriteBenchmarkArtifact({
            generatedAt: new Date().toISOString(),
            gitIdentity,
            options,
            regressionReasons,
            workloads
        });

        await writeStateWriteBenchmarkOutput({ artifact, destination: options.out, diagnostics });
        completed = true;
        console.log(`Wrote ${options.out}`);
    }
    finally {
        const diagnosticStatus = await diagnostics.finish(completed);
        if (diagnosticStatus.kind !== 'disabled') {
            console.log(JSON.stringify({ diagnostic: diagnosticStatus }));
            if (diagnosticStatus.kind === 'incomplete' && completed) {
                process.exitCode = 1;
            }
        }
        await Promise.allSettled([
            adminSql.end({ timeout: 5 }),
            ...serviceSql.map((sql) => sql.end({ timeout: 5 }))
        ]);
    }
}

interface BenchmarkWorkloadsInput {
    readonly adminSql: Sql;
    readonly serviceSql: readonly Sql[];
    readonly runId: string;
    readonly options: StateWriteBenchmarkOptions;
    readonly diagnostics: StateWriteDiagnosticWriter;
    readonly performanceTimeOriginEpochMs: number | undefined;
}

async function runBenchmarkWorkloads(
    { adminSql, serviceSql, runId, options, diagnostics, performanceTimeOriginEpochMs }: BenchmarkWorkloadsInput
) {
    const workloads = [];
    for (const workload of WORKLOADS) {
        console.log(
            `Running ${workload.name}: warmup=${options.warmup}, measured=${options.runs}`
        );
        for (let warmup = 0; warmup < options.warmup; warmup += 1) {
            await runWorkloadPhase({
                adminSql,
                serviceSql,
                runId,
                workload,
                phaseLabel: `warmup-${warmup}`,
                runIndex: warmup,
                concurrency: options.concurrency,
                diagnostics,
                performanceTimeOriginEpochMs,
                phase: 'warmup'
            });
        }
        const samples: RunSample[] = [];
        for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
            samples.push(
                await runWorkloadPhase({
                    adminSql,
                    serviceSql,
                    runId,
                    workload,
                    phaseLabel: `measured-${runIndex}`,
                    runIndex,
                    concurrency: options.concurrency,
                    diagnostics,
                    performanceTimeOriginEpochMs,
                    phase: 'measured'
                })
            );
        }
        const summary = summarizeSamples(samples);
        workloads.push({
            name: workload.name,
            scale: {
                clients: workload.clients,
                groups: workload.groups,
                concurrency: options.concurrency
            },
            mutationMix: [...MUTATION_MIX],
            warmupRuns: options.warmup,
            measuredRuns: options.runs,
            samples,
            summary
        });
        console.log(JSON.stringify({ workload: workload.name, ...summary }));
    }
    return workloads;
}

interface BenchmarkPhaseInput {
    readonly adminSql: Sql;
    readonly serviceSql: readonly Sql[];
    readonly runId: string;
    readonly workload: (typeof WORKLOADS)[number];
    readonly phaseLabel: string;
    readonly phase: 'warmup' | 'measured';
    readonly diagnostics: StateWriteDiagnosticWriter;
    readonly performanceTimeOriginEpochMs: number | undefined;
    readonly runIndex: number;
    readonly concurrency: number;
}

async function runWorkloadPhase(
    input: BenchmarkPhaseInput
): Promise<RunSample> {
    const { scope, context, runtimes, commands, postgresBefore, cpuBefore, lockSampler } =
        await prepareWorkloadMeasurement(input);
    let rawCommands: StateWriteBenchmarkCommand[];
    const capture = input.performanceTimeOriginEpochMs === undefined ? undefined : new StateWriteCommandCapture();
    const diagnosticFacts = capture ? { input, scope, context, capture } : undefined;
    const startedAt = performance.now();

    try {
        rawCommands = await executeMeasuredWorkload({
            commands,
            runtimes,
            scope,
            concurrency: input.concurrency,
            capture
        });
    }
    catch (error) {
        await stopSamplerAfterCommandFailure(lockSampler);
        if (diagnosticFacts) {
            await writePhaseDiagnostic({
                ...diagnosticFacts,
                rawCommands: diagnosticFacts.capture.getCommands(),
                startedAt,
                endedAt: 'unavailable',
                outcome: 'operation-failed'
            });
        }
        throw error;
    }

    const endedAt = performance.now();
    const durationMs = endedAt - startedAt;
    const lockWaitMs = await lockSampler.stop();
    const cpu = process.cpuUsage(cpuBefore);
    const evidence = await readWorkloadEvidence({
        sql: input.adminSql,
        scope,
        rawCommands,
        groupCount: input.workload.groups,
        timingEvents: context.timingEvents,
        postgresBefore
    });
    const sample = computeRunSample({
        runIndex: input.runIndex,
        rawCommands,
        context,
        durationMs,
        lockWaitMs,
        cpuTimeMs: (cpu.user + cpu.system) / 1_000,
        postgresBefore,
        evidence
    });
    if (diagnosticFacts) {
        await writePhaseDiagnostic({ ...diagnosticFacts, rawCommands, startedAt, endedAt, outcome: 'completed' });
    }
    return sample;
}

async function stopSamplerAfterCommandFailure(
    sampler: ReturnType<typeof startStateWriteLockWaitSampler>
): Promise<void> {
    try {
        await sampler.stop();
    }
    catch {
        console.error('State-write benchmark cleanup failed after command failure');
    }
}

interface PhaseDiagnosticFacts {
    readonly input: BenchmarkPhaseInput;
    readonly scope: StateScope;
    readonly context: StateWriteServiceRuntimeContext;
    readonly capture: StateWriteCommandCapture;
    readonly rawCommands: readonly StateWriteDiagnosticCommand[];
    readonly startedAt: number;
    readonly endedAt: number | 'unavailable';
    readonly outcome: StateWriteDiagnosticPhase['outcome'];
}

async function writePhaseDiagnostic(facts: PhaseDiagnosticFacts): Promise<void> {
    const { input, context, capture } = facts;
    await input.diagnostics.writePhase({
        workload: input.workload.name,
        phase: input.phase,
        runIndex: input.runIndex,
        scope: facts.scope,
        groupCount: input.workload.groups,
        serviceIds: input.serviceSql.map((_, index) => `state-write-bench-${index}`),
        performanceTimeOriginEpochMs: input.performanceTimeOriginEpochMs!,
        startedAtMonotonicMs: facts.startedAt,
        endedAtMonotonicMs: facts.endedAt,
        commands: facts.rawCommands,
        boundaries: capture.getBoundaries(),
        timingEvents: context.timingEvents,
        releases: context.attemptReleases,
        outcome: facts.outcome
    });
}

async function prepareWorkloadMeasurement(input: BenchmarkPhaseInput) {
    const scope: StateScope = {
        applicationId: `${input.runId}-${input.workload.name}-${input.phaseLabel}`,
        workspaceId: 'state-write-bench'
    };
    await seedCompleteState(input.adminSql, scope, input.workload);

    const context = newRunContext();
    const timing: RallarTimingSink = (event) => context.timingEvents.push(event);
    const runtimes = input.serviceSql.map((sql, index) =>
        createStateWriteServiceRuntime({
            sql,
            serviceId: `state-write-bench-${index}`,
            context,
            timing
        })
    );
    const commands = createCommands(input.workload);
    const postgresBefore = await readStateWritePostgresCounters(input.adminSql);
    const cpuBefore = process.cpuUsage();
    const lockSampler = startStateWriteLockWaitSampler(
        input.adminSql,
        `${input.runId}-service-`
    );
    return { scope, context, runtimes, commands, postgresBefore, cpuBefore, lockSampler };
}

interface WorkloadEvidenceInput {
    readonly sql: Sql;
    readonly scope: StateScope;
    readonly rawCommands: readonly StateWriteBenchmarkCommand[];
    readonly groupCount: number;
    readonly timingEvents: StateWriteServiceRuntimeContext['timingEvents'];
    readonly postgresBefore: StateWritePostgresCounters;
}

async function readWorkloadEvidence(
    { sql, scope, rawCommands, groupCount, timingEvents, postgresBefore }: WorkloadEvidenceInput
): Promise<WorkloadEvidence> {
    const postgresAfter = await readStateWritePostgresCounters(sql);
    const walBytes = await readStateWriteWalDifference({
        sql: sql,
        before: postgresBefore.walLsn,
        after: postgresAfter.walLsn
    });
    const durable = await queryStateWriteDurableEvidence({
        sql: sql,
        scope,
        commands: rawCommands,
        groupCount: groupCount,
        timingEvents: timingEvents
    });
    return { postgresAfter, walBytes, durable };
}

function validatePerfOutputPath(path: string): readonly string[] {
    const normalized = normalize(path).replaceAll('\\', '/');
    if (!normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
        return [`Benchmark output must remain under tmp/perf/: ${path}`];
    }
    return [];
}
