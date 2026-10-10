#!/usr/bin/env node

// Produces the governed environment descriptor that
// validate-api-v1-state-write-environment.mjs checks and that the A-B-B-A
// pooling protocol requires per source (issue #157).
//
// Capture is two-stage because the field semantics bracket the benchmark:
// preflight row counts and the preflight maintenance counter describe the
// database the run started against, while the postflight maintenance counter
// proves no automatic maintenance ran during it. Stage one writes a JSON
// sidecar, stage two completes it and emits the descriptor text.

import { execFile } from 'node:child_process';
import {
    mkdir,
    readFile,
    writeFile
} from 'node:fs/promises';
import { arch } from 'node:os';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
    readApiV1StateWriteImageIdentity,
    toImageManifestDescriptor
} from './read-api-v1-state-write-image-identity.mjs';
import { ENVIRONMENT_FIELDS, validateApiV1StateWriteEnvironment } from './validate-api-v1-state-write-environment.mjs';

const execFileAsync = promisify(execFile);

const GOVERNED_TABLES = [
    'app_data_store',
    'client_state_events',
    'group_state_events',
    'resource_inbox',
    'resource_inbox_results',
    'runtime_state_store'
];

const GOVERNED_SETTINGS = [
    'server_version',
    'autovacuum',
    'track_counts',
    'shared_buffers',
    'work_mem',
    'maintenance_work_mem',
    'effective_cache_size',
    'random_page_cost',
    'effective_io_concurrency',
    'synchronous_commit',
    'fsync',
    'full_page_writes',
    'max_wal_size',
    'checkpoint_timeout',
    'jit',
    'max_parallel_workers_per_gather'
];

const MAINTENANCE_SQL = 'SELECT coalesce(sum(autovacuum_count + autoanalyze_count), 0) FROM pg_stat_user_tables';

const BENCHMARK_PROCESS_MARKER = 'api-v1-state-write-concurrency-bench';

export async function captureApiV1StateWriteEnvironment(argumentsInput = process.argv.slice(2)) {
    const options = readCaptureOptions({ argumentsInput });
    const captured = options.stage === 'preflight'
        ? await readPreflightCapture({ options })
        : await readPostflightCapture({ options });
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, captured.text);
    console.log(`Wrote ${options.out}`);
}

async function readPreflightCapture({ options }) {
    const container = await readContainerRecord({ container: options.container });
    const image = await readApiV1StateWriteImageIdentity({ container });
    const postgres = await readPostgresRecord({ options });
    const record = {
        ...image.record,
        ...container.record,
        ...postgres,
        ...(await readToolchainRecord()),
        ...(await readOverlapRecord({ container: options.container })),
        host_architecture: arch()
    };
    validatePreflightIsClean({ record });
    return { text: `${JSON.stringify({ containerId: container.id, imageProof: image.proof, record }, null, 2)}\n` };
}

async function readPostflightCapture({ options }) {
    const sidecar = toCapturedSidecar({ text: await readFile(options.preflight, 'utf8') });
    const container = await readContainerRecord({ container: options.container });
    if (container.id !== sidecar.containerId) {
        throw new TypeError('container identity changed between preflight and postflight capture');
    }
    const maintenance = await readScalar({ options, sql: MAINTENANCE_SQL });
    const record = {
        ...sidecar.record,
        ...container.record,
        ...(await readOverlapRecord({ container: options.container })),
        postflight_automatic_maintenance_count: maintenance
    };
    const text = toEnvironmentText({ record });
    const errors = validateApiV1StateWriteEnvironment(text);
    if (errors.length > 0) {
        throw new TypeError(`captured environment is not governed-valid: ${errors.join('; ')}`);
    }
    return { text };
}

// The pooled comparison only means anything if every source ran against an
// equivalently empty database, so a dirty preflight fails here rather than
// surviving into a verdict.
function validatePreflightIsClean({ record }) {
    const dirty = ENVIRONMENT_FIELDS.filter(
        (field) => field.startsWith('preflight_') && record[field] !== '0'
    );
    if (dirty.length > 0) {
        throw new TypeError(`preflight database is not empty: ${dirty.join(', ')}`);
    }
}

async function readContainerRecord({ container }) {
    const inspected = toNativeObject({
        value: JSON.parse(await readDockerJson({ argumentsInput: ['container', 'inspect', container] }))
    });
    const host = toNativeObject({ value: inspected.HostConfig });
    const config = toNativeObject({ value: inspected.Config });
    const id = toNativeText({ value: inspected.Id });
    const imageId = toNativeText({ value: inspected.Image });
    if (id.length === 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
        throw new TypeError('native container identities must be complete');
    }
    return {
        id,
        imageId,
        manifest: toImageManifestDescriptor({ value: inspected.ImageManifestDescriptor }),
        record: {
            platform: toNativeText({ value: inspected.Platform }),
            command: toNativeArguments({ value: config.Cmd }).join(' '),
            shm_size: String(toNativeCounter({ value: host.ShmSize })),
            memory: String(toNativeCounter({ value: host.Memory })),
            memory_swap: String(toNativeCounter({ value: host.MemorySwap })),
            nano_cpus: String(toNativeCounter({ value: host.NanoCpus })),
            cpu_period: String(toNativeCounter({ value: host.CpuPeriod })),
            cpu_quota: String(toNativeCounter({ value: host.CpuQuota })),
            cpu_set: toNativeText({ value: host.CpusetCpus }),
            fresh_container: String(toNativeCounter({ value: inspected.RestartCount }) === 0)
        }
    };
}

async function readDockerJson({ argumentsInput }) {
    const { stdout } = await execFileAsync('docker', [...argumentsInput, '--format', '{{json .}}'], {
        timeout: 15_000,
        maxBuffer: 65_536
    });
    return stdout;
}

async function readPostgresRecord({ options }) {
    const settings = await readPsqlPairs(
        {
            options,
            sql: `SELECT name, setting FROM pg_settings WHERE name IN (${toSqlList({ values: GOVERNED_SETTINGS })})`
        }
    );
    const rows = await readPsqlPairs({ options, sql: toRowCountSql() });
    return {
        ...settings,
        ...rows,
        preflight_automatic_maintenance_count: await readScalar({ options, sql: MAINTENANCE_SQL })
    };
}

function toRowCountSql() {
    return GOVERNED_TABLES.map(
        (table) => `SELECT 'preflight_${table}_rows' AS name, count(*)::text AS setting FROM ${table}`
    ).join(' UNION ALL ');
}

function toSqlList({ values }) {
    return values.map((value) => `'${value}'`).join(', ');
}

async function readPsqlPairs({ options, sql }) {
    const stdout = await readPsql({ options, sql });
    const record = {};
    for (const line of stdout.split('\n').filter((value) => value.length > 0)) {
        const separator = line.indexOf('=');
        if (
            separator < 1 || !ENVIRONMENT_FIELDS.includes(line.slice(0, separator)) ||
            Object.hasOwn(record, line.slice(0, separator))
        ) {
            throw new TypeError('native SQL facts must contain unique named values');
        }
        record[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return record;
}

async function readScalar({ options, sql }) {
    return (await readPsql({ options, sql })).trim();
}

async function readPsql({ options, sql }) {
    const { stdout } = await execFileAsync('docker', [
        'exec',
        options.container,
        'psql',
        '-U',
        options.databaseUser,
        '-d',
        options.databaseName,
        '-At',
        '-F=',
        '-c',
        sql
    ], { timeout: 15_000, maxBuffer: 65_536 });
    return stdout;
}

async function readToolchainRecord() {
    const deno = await readCommandOutput({ command: 'deno', argumentsInput: ['--version'] });
    return {
        node: process.versions.node,
        npm: await readCommandOutput({ command: 'npm', argumentsInput: ['--version'] }),
        deno: toDenoComponent({ versionText: deno, name: 'deno' }),
        deno_v8: toDenoComponent({ versionText: deno, name: 'v8' }),
        deno_typescript: toDenoComponent({ versionText: deno, name: 'typescript' }),
        docker: await readCommandOutput({
            command: 'docker',
            argumentsInput: ['version', '--format', '{{.Server.Version}}']
        }),
        docker_compose: await readCommandOutput({
            command: 'docker',
            argumentsInput: ['compose', 'version', '--short']
        })
    };
}

function toDenoComponent({ versionText, name }) {
    const line = versionText.split('\n').find((value) => value.startsWith(`${name} `));
    return line === undefined ? '' : line.slice(name.length + 1).split(' ')[0];
}

async function readOverlapRecord({ container }) {
    const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}'], {
        timeout: 15_000,
        maxBuffer: 65_536
    });
    const others = stdout.split('\n').filter((name) => name.length > 0 && name !== container);
    return {
        container_overlap_count: String(others.length),
        benchmark_process_overlap_count: String(await readBenchmarkProcessCount())
    };
}

async function readBenchmarkProcessCount() {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'command='], { timeout: 15_000, maxBuffer: 1_048_576 });
    return stdout
        .split('\n')
        .filter((line) => line.includes(BENCHMARK_PROCESS_MARKER) && !line.includes('ps -A')).length;
}

async function readCommandOutput({ command, argumentsInput }) {
    const { stdout } = await execFileAsync(command, argumentsInput, { timeout: 15_000, maxBuffer: 65_536 });
    return stdout.trim();
}

function toEnvironmentText({ record }) {
    const missing = ENVIRONMENT_FIELDS.filter((field) => typeof record[field] !== 'string');
    if (missing.length > 0) {
        throw new TypeError(`captured environment is missing fields: ${missing.join(', ')}`);
    }
    return `${ENVIRONMENT_FIELDS.map((field) => `${field}=${record[field]}`).join('\n')}\n`;
}

function readCaptureOptions({ argumentsInput }) {
    const { values } = parseArgs({
        args: argumentsInput,
        options: {
            stage: { type: 'string' },
            container: { type: 'string' },
            'database-url': { type: 'string' },
            preflight: { type: 'string' },
            out: { type: 'string' }
        },
        strict: true
    });
    if (values.stage !== 'preflight' && values.stage !== 'postflight') {
        throw new TypeError('--stage must be preflight or postflight');
    }
    if (values.stage === 'postflight' && typeof values.preflight !== 'string') {
        throw new TypeError('--preflight is required for the postflight stage');
    }
    for (const name of ['container', 'database-url', 'out']) {
        if (typeof values[name] !== 'string' || values[name].length === 0) {
            throw new TypeError(`--${name} is required`);
        }
    }
    return { ...toDatabaseIdentity({ databaseUrl: values['database-url'] }), ...values, out: values.out };
}

function toDatabaseIdentity({ databaseUrl }) {
    const parsed = new URL(databaseUrl);
    return {
        databaseUser: decodeURIComponent(parsed.username),
        databaseName: decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    };
}

function toCapturedSidecar({ text }) {
    const sidecar = toNativeObject({ value: JSON.parse(text) });
    const record = toNativeObject({ value: sidecar.record });
    const capturedRecord = {};
    for (const [field, value] of Object.entries(record)) {
        if (!ENVIRONMENT_FIELDS.includes(field)) {
            throw new TypeError('preflight sidecar must contain governed fields');
        }
        capturedRecord[field] = toNativeText({ value });
    }
    return { containerId: toNativeText({ value: sidecar.containerId }), record: capturedRecord };
}

/** @param {{ value: unknown }} input */
function toNativeObject({ value }) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('native capture facts must be an object');
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {{ value: unknown }} input */
function toNativeText({ value }) {
    if (typeof value !== 'string') {
        throw new TypeError('native capture fact must be text');
    }
    return value;
}

/** @param {{ value: unknown }} input */
function toNativeCounter({ value }) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('native capture counter must be a nonnegative integer');
    }
    return value;
}

/** @param {{ value: unknown }} input */
function toNativeArguments({ value }) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError('native container command must be a nonempty argument array');
    }
    return value.map((argument) => toNativeText({ value: argument }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await captureApiV1StateWriteEnvironment();
}
