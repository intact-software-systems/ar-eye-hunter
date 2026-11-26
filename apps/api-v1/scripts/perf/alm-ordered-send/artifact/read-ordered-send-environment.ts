import { execFileSync } from 'node:child_process';
import {
    arch,
    cpus,
    loadavg,
    platform,
    release,
    totalmem
} from 'node:os';

import { createDefaultApiV1DatabaseLifecycle } from '../../../../src/db/api-v1-database-lifecycle.ts';
import type { OrderedSendArtifactEnvironment, OrderedSendArtifactSource } from './to-ordered-send-artifact.ts';

interface PostgresServerVersionRow {
    readonly version: string;
}

/** The commit this file is checked out at, and whether the working tree around it differs from that commit. */
export function readOrderedSendSource(): OrderedSendArtifactSource {
    return {
        commit: readGitOutput(['rev-parse', 'HEAD']),
        dirty: readGitOutput(['status', '--porcelain']).length > 0
    };
}

/**
 * The machine and the runtime of this process, and the version of the server at `databaseUrl`, read through a
 * database lifecycle of its own that it closes again. The URL is a credential and no part of what is returned.
 */
export async function readOrderedSendEnvironment(databaseUrl: string): Promise<OrderedSendArtifactEnvironment> {
    const bunVersion = process.versions.bun;
    if (bunVersion === undefined) {
        throw new TypeError('The ordered-send cell runs under Bun.');
    }
    const processors = cpus();
    return {
        host: {
            cpuModel: processors[0]?.model ?? 'unknown',
            cpuCount: processors.length,
            totalMemoryBytes: totalmem()
        },
        os: { platform: platform(), release: release(), architecture: arch() },
        bunVersion,
        postgresServerVersion: await readPostgresServerVersion(databaseUrl)
    };
}

/** The machine's load average over the last 1, 5 and 15 minutes. */
export function readOrderedSendLoadAverage(): readonly number[] {
    return loadavg();
}

function readGitOutput(args: readonly string[]): string {
    return execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
}

async function readPostgresServerVersion(databaseUrl: string): Promise<string> {
    const lifecycle = await createDefaultApiV1DatabaseLifecycle({
        database: {
            mode: 'postgres',
            url: databaseUrl,
            schemaInitialization: 'disabled',
            pubSub: 'postgres',
            applicationPool: { maxConnections: 1, idleTimeoutSeconds: 0 },
            listenerPool: { maxConnections: 1, idleTimeoutSeconds: 0 }
        },
        pgliteEvidence: { mode: 'disabled', pollIntervalMs: 1_000 },
        statementCensus: undefined
    });
    try {
        const rows = await lifecycle.database<
            readonly PostgresServerVersionRow[]
        >`select current_setting('server_version') as version`;
        return rows[0].version;
    }
    finally {
        await lifecycle.close();
    }
}
