#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
    appendFileSync,
    copyFileSync,
    mkdirSync,
    readFileSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';

const command = process.argv[2];
const args = process.argv.slice(3);
const root = process.env.PORT_ROOT;
const failure = process.env.PORT_FAILURE;
const commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const image = 'postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171';
appendFileSync(
    path.join(root, 'calls.jsonl'),
    JSON.stringify({ command, args, benchmarkAlive: readBenchmarkAlive(), descendantAlive: readDescendantAlive() }) + '\n'
);
if (command === 'node' && args[0]?.endsWith('capture-api-v1-state-write-environment.mjs')) {
    capture();
}
else if (command === 'npm' && args.includes('perf:api-v1:state-write')) {
    benchmark();
}
else if (command === 'docker') {
    docker();
}
else if (command === 'git') {
    if (args[0] === 'rev-parse') {
        console.log(args.includes('HEAD^{tree}') ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : commit);
    }
    else if (args[0] === 'ls-files') {
        console.log(
            'package.json\npackage-lock.json\napps/api-v1/deno.json\napps/api-v1/deno.lock\ndocker-compose.perf-bench.yml\n.github/workflows/api-v1-state-write-pr-measurement.yml\napps/api-v1/scripts/perf/run-api-v1-state-write-measurement.mjs'
        );
    }
    else if (
        args[0] === 'diff' &&
        ((failure === 'dependencies' && args.includes('package-lock.json')) ||
            (failure === 'comparator' && args.includes('apps/api-v1/scripts/perf/validate-state-write-durable-evidence.mjs')))
    ) {
        process.exit(17);
    }
    else if (args[0] === 'show') {
        console.log(
            JSON.stringify({
                scripts: {
                    'perf:api-v1:state-write': failure === 'scripts' && args[1]?.startsWith(commit) ? 'changed script' : 'deno bench',
                    'db:migrate': 'deno migrate'
                }
            })
        );
    }
}
else if (command === 'node' && args[0]?.endsWith('resolve-changed-review-range.mjs')) {
    console.log('base=cccccccccccccccccccccccccccccccccccccccc\nhead=' + commit);
}
else if (command === 'node' && args[0] === '-e') {
    const child = spawnSync(process.env.REAL_NODE, args, { input: readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'] });
    process.exit(child.status ?? 1);
}
else if (command === 'nproc') {
    console.log(failure === 'cpu-invalid' ? 'unavailable' : failure === 'cpu' ? 2 : 4);
}
else if (command === 'ps') {
    console.log(failure === 'overlap' ? 'deno run api-v1-state-write-concurrency-bench.ts' : 'idle');
}
else {
    console.log('public toolchain fixture');
}

function capture() {
    const stage = args[args.indexOf('--stage') + 1];
    const out = args[args.indexOf('--out') + 1];
    if ((failure === 'preflight' && stage === 'postflight') || (failure === 'secondary' && out.endsWith('environment.txt'))) {
        process.exit(23);
    }
    mkdirSync(path.dirname(out), { recursive: true });
    if (stage === 'preflight') {
        const directory = out + '.acquisition';
        mkdirSync(directory);
        const defaults = ['PATH=/usr/local/bin:/usr/bin:/bin', 'PGDATA=/var/lib/postgresql/data'];
        const config = { Env: defaults, Entrypoint: ['docker-entrypoint.sh'], Volumes: { '/var/lib/postgresql/data': {} }, Labels: null };
        const container = createPublicNativeContainer(config, defaults);
        if (failure === 'unexpected-env') {
            container.Config.Env.push('PRIVATE_CONFIGURATION=do-not-disclose');
        }
        if (failure === 'unexpected-mount') {
            container.HostConfig.Binds = ['/private:/private'];
        }
        if (failure === 'ownership') {
            container.Config.Labels['com.docker.compose.project'] = 'unowned';
        }
        writeFileSync(path.join(root, 'container.json'), JSON.stringify(container));
        writeFileSync(path.join(directory, 'container-inspect.json'), JSON.stringify(container));
        writeFileSync(path.join(directory, 'image-inspect.json'), JSON.stringify({ Id: container.Image, Config: config, RepoDigests: [image] }));
        writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ config }));
        writeFileSync(path.join(directory, 'image.tar'), 'original archive bytes');
        if (failure === 'late-preflight' && out.includes('position-2-')) {
            process.exit(23);
        }
        writeFileSync(out, JSON.stringify({ containerId: container.Id, imageProof: { acquisition: { directory } } }));
    }
    else {
        writeFileSync(out, 'governed public environment');
        if (failure === 'metadata') {
            mkdirSync(path.join(process.cwd(), process.env.MEASUREMENT_OUTPUT, 'commands/benchmark-0-start.json'), { recursive: true });
        }
        if (failure === 'source-change') {
            appendFileSync('package.json', ' ');
        }
    }
}

function createPublicNativeContainer(config, defaults) {
    return {
        Id: 'container-fixture',
        Image: 'sha256:' + 'd'.repeat(64),
        Name: '/rallar-perf-bench-postgres',
        Config: {
            ...config,
            Image: image,
            Cmd: ['postgres', '-c', 'autovacuum=off'],
            Env: [...defaults, 'POSTGRES_USER=app', 'POSTGRES_PASSWORD=app', 'POSTGRES_DB=appdb'],
            Labels: {
                'com.docker.compose.project': 'state-write-comparison',
                'com.docker.compose.service': 'perf-bench-postgres',
                'com.docker.compose.container-number': '1',
                'com.docker.compose.oneoff': 'False',
                'com.docker.compose.project.working_dir': process.cwd(),
                'com.docker.compose.project.config_files': path.join(process.cwd(), 'docker-compose.perf-bench.yml'),
                'com.docker.compose.config-hash': 'e'.repeat(64),
                'com.docker.compose.version': '5.0.0',
                'com.docker.compose.image': 'sha256:' + 'd'.repeat(64),
                'com.docker.compose.depends_on': ''
            }
        },
        HostConfig: { Binds: null, Mounts: [], VolumesFrom: null },
        Mounts: [{
            Type: 'volume',
            Name: 'f'.repeat(64),
            Source: '/var/lib/docker/volumes/' + 'f'.repeat(64) + '/_data',
            Destination: '/var/lib/postgresql/data',
            Driver: 'local',
            Mode: '',
            RW: true,
            Propagation: ''
        }]
    };
}

function benchmark() {
    writeFileSync(path.join(root, 'benchmark.pid'), String(process.pid));
    const inherited = failure === 'inherited-pipe';
    const program = inherited
        ? 'const {writeFileSync}=require(\'node:fs\'); setInterval(()=>{},1000); setTimeout(()=>{writeFileSync(process.argv[1],\'fixture lifetime fallback\'); process.exit(29);},6000);'
        : 'setInterval(() => {}, 1000)';
    const descendant = spawn(process.execPath, ['-e', program, path.join(root, 'descendant-fallback')], {
        stdio: inherited ? ['ignore', process.stdout, process.stderr] : 'ignore'
    });
    descendant.unref();
    writeFileSync(path.join(root, 'descendant.pid'), String(descendant.pid));
    if (failure === 'recording') {
        const commands = path.join(process.cwd(), process.env.MEASUREMENT_OUTPUT, 'commands');
        mkdirSync(path.join(commands, 'benchmark-0.stdout'), { recursive: true });
        console.log('owned fake benchmark recording failure');
    }
    if (failure === 'interrupt' || failure === 'recording') {
        if (failure === 'interrupt') {
            process.kill(process.ppid, 'SIGTERM');
        }
        setTimeout(() => process.exit(29), 2000);
        return;
    }
    const out = args.find((value) => value.startsWith('--out=')).slice(6);
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(path.join(root, 'artifact.json'), out);
    if (failure === 'canonical') {
        writeFileSync(out, '{}');
    }
    const diagnostic = args.find((value) => value.startsWith('--diagnostics-dir='));
    if (diagnostic) {
        const directory = diagnostic.slice(18);
        mkdirSync(directory);
        writeDiagnosticFiles(directory);
    }
    if (failure === 'benchmark' || failure === 'secondary' || inherited) {
        process.exit(19);
    }
}

function writeDiagnosticFiles(directory) {
    let bytes = 0;
    for (let ordinal = 0; ordinal < 12; ordinal += 1) {
        bytes += writeDiagnosticPhase(directory, ordinal);
    }
    writeFileSync(
        path.join(directory, 'receipt.json'),
        JSON.stringify({
            kind: 'complete',
            stage: 'none',
            phases: 12,
            bytes,
            byteAccounting: 'phase-bytes-reserved-including-failed-writes',
            receiptReserveBytes: 1024
        })
    );
}

function writeDiagnosticPhase(directory, ordinal) {
    const header = {
        record: 'phase',
        schema: failure === 'old-schema'
            ? 'rallar.state-write.diagnostic.v1'
            : failure === 'unknown-schema'
            ? 'rallar.state-write.diagnostic.v4'
            : 'rallar.state-write.diagnostic.v3',
        workload: ['uncontended', 'shared', 'hot'][Math.floor(ordinal / 4)],
        phase: ordinal % 4 === 0 ? 'warmup' : 'measured',
        runIndex: ordinal % 4 === 0 ? 0 : ordinal % 4 - 1,
        outcome: 'completed'
    };
    const commands = Array.from({ length: 700 }, (_, commandOrdinal) => ({ record: 'command', commandOrdinal, status: 'accepted' }));
    const eventCounts = { 'observed-capacity': 101185, 'exact-capacity': 110000, capacity: 110001, 'unassociated-mismatch': 1384 };
    const { timings, releases } = createDiagnosticEvents(ordinal === 0 ? eventCounts[failure] ?? 0 : 0);
    const counts = { total: 0, retained: 0, unassociated: 0, rejected: 0, truncated: 0 };
    const footer = {
        record: 'completeness',
        complete: failure !== 'incomplete',
        timing: { ...counts, total: timings.length, retained: timings.length, unassociated: timings.length },
        releases: { ...counts, total: releases.length, retained: releases.length },
        boundaries: { ...counts, total: 701, retained: 701 },
        reservationObservations: { expected: 0, available: 0, unavailable: 0 }
    };
    if (failure === 'total-mismatch') {
        footer.timing.total += 1;
    }
    if (failure === 'record-mismatch') {
        footer.timing.total += 1;
        footer.timing.retained += 1;
    }
    if (failure === 'unassociated-mismatch' && ordinal === 0) {
        footer.timing.unassociated -= 1;
    }
    if (failure.startsWith('observation-')) {
        addReservationObservationFixture(releases, footer);
    }
    const extra = failure === 'unknown-record' ? [{ record: 'unexpected' }] : [];
    const text = [header, ...commands, ...releases, ...timings, ...extra, footer].map((value) => JSON.stringify(value)).join('\n') + '\n';
    writeFileSync(path.join(directory, 'phase-' + ordinal + '.ndjson'), text);
    return Buffer.byteLength(text);
}

function addReservationObservationFixture(releases, footer) {
    const release = createDiagnosticEvents(1382).releases[0];
    release.selectedLane = 'RETRY';
    release.reservationObservation = {
        availability: 'available',
        boundary: 'postgres-update-returning',
        association: 'physical-key-and-reservation-attempt',
        reservationAttempt: 1,
        previousPersistedRetryDelayUs: 5000000,
        dueToReservationObservationUs: -1
    };
    releases.push(release);
    footer.releases.total += 1;
    footer.releases.retained += 1;
    footer.reservationObservations = { expected: 1, available: 1, unavailable: 0 };
    if (failure === 'observation-missing') {
        delete release.reservationObservation;
    }
    if (failure === 'observation-fraction') {
        release.reservationObservation.dueToReservationObservationUs = 0.5;
    }
    if (failure === 'observation-range') {
        release.reservationObservation.dueToReservationObservationUs = 9007199254740992;
    }
    if (failure === 'observation-boundary') {
        release.reservationObservation.boundary = 'commit';
    }
    if (failure === 'observation-lane') {
        release.selectedLane = 'NEW';
    }
    if (failure === 'observation-attempt') {
        release.reservationObservation.reservationAttempt = 2;
    }
    if (failure === 'observation-count') {
        footer.reservationObservations.expected = 2;
    }
    if (failure === 'observation-redaction') {
        release.reservationObservation.key = 'private';
    }
}

function createDiagnosticEvents(total) {
    const releaseCount = total === 0 ? 0 : 1382;
    const timings = Array.from({ length: total - releaseCount }, () => ({
        record: 'timing',
        component: 'state-write-benchmark-sql',
        operation: 'read',
        status: 'ok',
        completedAtEpochMs: 100,
        roundedDurationMs: 1,
        association: { kind: 'process-unassociated', reason: 'sql-process-scope', observingStack: 'unavailable' },
        queueAgeMs: 'unavailable',
        dueAgeMs: 'unavailable'
    }));
    const releases = Array.from({ length: releaseCount }, () => ({
        record: 'release',
        reservationObservation: {
            availability: 'unavailable',
            boundary: 'unavailable',
            association: 'unavailable',
            reservationAttempt: 1,
            reason: 'not-applicable'
        },
        commandOrdinal: 0,
        operation: 'profile',
        originatingStack: 0,
        observingStack: 'unavailable',
        endpoint: 'unavailable',
        attempt: 1,
        classification: 'accepted',
        status: 'COMPLETED',
        selectedLane: 'NEW',
        queueAgeMs: 1,
        dueAgeMs: 0,
        retryDelayMs: 0,
        failure: 'none'
    }));
    return { timings, releases };
}

function docker() {
    if (args[0] === 'ps') {
        let provisioned = false;
        if (args.includes('-aq')) {
            try {
                provisioned = readFileSync(path.join(root, 'provisioned'), 'utf8') === 'true';
            }
            catch {}
        }
        console.log(provisioned ? failure === 'replacement' && args.includes('--no-trunc') ? 'replacement-fixture' : 'container-fixture' : '');
    }
    else if (args[0] === 'inspect') {
        const container = JSON.parse(readFileSync(path.join(root, 'container.json'), 'utf8'));
        if (failure === 'cleanup-env') {
            container.Config.Env.push('PRIVATE_CONFIGURATION=do-not-disclose');
        }
        if (failure === 'replacement') {
            container.Id = 'replacement-fixture';
        }
        console.log(JSON.stringify(container));
    }
    else if (args[0] === 'logs' && failure === 'secondary') {
        process.exit(24);
    }
    else {
        if (args.includes('up')) {
            writeFileSync(path.join(root, 'provisioned'), 'true');
        }
        if (args.includes('down')) {
            writeFileSync(path.join(root, 'provisioned'), 'false');
        }
        console.log('owned public postgres');
    }
}

function readBenchmarkAlive() {
    try {
        let pid;
        try {
            pid = Number(readFileSync(path.join(root, 'benchmark.pid'), 'utf8'));
        }
        catch {
            pid = Number(readFileSync(path.join(process.cwd(), process.env.MEASUREMENT_OUTPUT, 'commands/benchmark-0.pid'), 'utf8'));
        }
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    catch {
        return null;
    }
}

function readDescendantAlive() {
    try {
        const pid = Number(readFileSync(path.join(root, 'descendant.pid'), 'utf8'));
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    catch {
        return null;
    }
}
