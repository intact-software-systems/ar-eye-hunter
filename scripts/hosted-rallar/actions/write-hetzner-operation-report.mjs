#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argumentNames = [
    'log',
    'output-dir',
    'status',
    'phase',
    'exit-code',
    'commit',
    'manifest',
    'control-run-id',
    'distributed-run-id',
    'artifact-available',
    'started-at',
    'finished-at',
    'materialization-record',
    'materialized-manifest'
];

const unavailableGroupRef = Object.freeze({
    applicationId: 'unavailable',
    workspaceId: 'unavailable',
    groupId: 'unavailable'
});

function readArguments(values) {
    const argumentsByName = new Map();

    for (let index = 0; index < values.length; index += 2) {
        const name = values[index]?.replace(/^--/, '');
        const value = values[index + 1];
        if (!name || value === undefined) {
            throw new Error(`Expected --name value arguments; received ${values.join(' ')}`);
        }
        argumentsByName.set(name, value);
    }

    for (const name of argumentNames) {
        if (!argumentsByName.has(name)) {
            throw new Error(`Missing required argument --${name}`);
        }
    }

    return argumentsByName;
}

function readBoolean(value, name) {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`${name} must be true or false; received ${value}`);
}

function sanitizeOperationLog(value) {
    return value
        .replace(/(authorization\s*:\s*bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
        .replace(/((?:password|token|secret)[a-z0-9_]*\s*=)\s*[^\s]*/gi, '$1[REDACTED]')
        .replace(/([?&](?:token|password|secret)=)[^&\s]*/gi, '$1[REDACTED]');
}

function readOperationStage(log) {
    const stages = [...log.matchAll(/^RALLAR_OPERATION_STAGE=([a-z0-9-]+)$/gm)];
    return stages.at(-1)?.[1] ?? 'unknown';
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function readGroupRef(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const result = {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId
    };
    return Object.values(result).every((entry) => typeof entry === 'string' && entry.length > 0)
        ? result
        : null;
}

async function readMaterialization(recordPath, manifestPath) {
    const recordText = await readFile(recordPath, 'utf8').catch(() => null);
    const manifestText = await readFile(manifestPath, 'utf8').catch(() => null);
    const unavailable = {
        materializationStatus: 'failed',
        groupIsolationMode: 'unresolved',
        sourceGroupRef: unavailableGroupRef,
        effectiveGroupRef: unavailableGroupRef,
        sourceManifestSha256: 'unavailable',
        materializedManifestSha256: 'unavailable',
        materializedManifestAvailable: manifestText !== null,
        record: null
    };
    if (recordText === null || manifestText === null) {
        return unavailable;
    }

    try {
        const record = JSON.parse(recordText);
        const manifest = JSON.parse(manifestText);
        const sourceGroupRef = readGroupRef(record.sourceGroupRef);
        const effectiveGroupRef = readGroupRef(record.effectiveGroupRef);
        const manifestGroupRef = readGroupRef(manifest.group);
        const validMode = ['isolated', 'explicit', 'preserved'].includes(record.isolationMode);
        const validHashes = /^[a-f0-9]{64}$/.test(record.sourceManifestSha256) &&
            /^[a-f0-9]{64}$/.test(record.materializedManifestSha256);
        const manifestMatches = manifestGroupRef !== null &&
            effectiveGroupRef !== null &&
            JSON.stringify(manifestGroupRef) === JSON.stringify(effectiveGroupRef) &&
            sha256(manifestText) === record.materializedManifestSha256;
        if (!sourceGroupRef || !effectiveGroupRef || !validMode || !validHashes || !manifestMatches) {
            return unavailable;
        }
        return {
            materializationStatus: 'succeeded',
            groupIsolationMode: record.isolationMode,
            sourceGroupRef,
            effectiveGroupRef,
            sourceManifestSha256: record.sourceManifestSha256,
            materializedManifestSha256: record.materializedManifestSha256,
            materializedManifestAvailable: true,
            record
        };
    }
    catch {
        return unavailable;
    }
}

function classifyFailure({ status, stage, log, missingArtifacts }) {
    if (missingArtifacts) {
        return {
            failureCategory: 'missing-artifacts',
            component: 'Distributed recipe artifacts',
            nextAction: 'Inspect artifact collection and the controller run directory before retrying the recipe.'
        };
    }

    if (status === 'succeeded') {
        return {
            failureCategory: 'none',
            component: 'none',
            nextAction: 'No action required.'
        };
    }

    if (/deb\.nodesource\.com/i.test(log) && /403\s+Forbidden/i.test(log)) {
        return {
            failureCategory: 'dependency-repository',
            component: 'NodeSource apt repository',
            nextAction: 'Retry controller preparation after confirming isolated Ubuntu dependency sources.'
        };
    }

    const classifications = {
        'manifest-materialization': {
            failureCategory: 'manifest-scope',
            component: 'Hetzner run manifest materialization',
            nextAction: 'Inspect the source and effective group scope in the operation artifacts.'
        },
        'manifest-scope-validation': {
            failureCategory: 'manifest-scope',
            component: 'Hetzner run manifest scope',
            nextAction: 'Compare the materialized manifest group with the worker scope and run identifiers.'
        },
        'playwright-system-dependencies': {
            failureCategory: 'browser-dependencies',
            component: 'Playwright system dependencies',
            nextAction: 'Inspect the apt evidence and repair controller browser dependencies.'
        },
        'playwright-browser-install': {
            failureCategory: 'browser-installation',
            component: 'Playwright browser download',
            nextAction: 'Inspect the browser download evidence; the active browser was preserved.'
        },
        'playwright-browser-smoke': {
            failureCategory: 'browser-verification',
            component: 'Playwright browser launch',
            nextAction: 'Inspect the browser launch error before retrying controller preparation.'
        },
        'deployment-readiness': {
            failureCategory: 'deployment-readiness',
            component: 'Hetzner deployment readiness stamp',
            nextAction: 'Run controller preparation for the exact commit before starting recipes.'
        },
        'rollout-service-health': {
            failureCategory: 'service-health',
            component: 'Rallar controller services',
            nextAction: 'Inspect API, control-server, and Caddy service status on the controller.'
        },
        'agent-readiness': {
            failureCategory: 'agent-readiness',
            component: 'Hetzner headless agents',
            nextAction: 'Inspect worker service logs and the control-run agent snapshot.'
        },
        'recipe-execution': {
            failureCategory: 'recipe-execution',
            component: 'Distributed recipe',
            nextAction: 'Open the distributed analysis and cited raw recipe evidence.'
        }
    };

    return (
        classifications[stage] ?? {
            failureCategory: /ssh:/i.test(log) ? 'ssh' : 'unknown',
            component: /ssh:/i.test(log) ? 'Hetzner SSH connection' : 'unknown',
            nextAction: 'Open the sanitized evidence and the failing GitHub Actions step.'
        }
    );
}

function toEvidenceExcerpt(log) {
    return log
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0 && !line.startsWith('RALLAR_OPERATION_STAGE='))
        .slice(-40)
        .map((line) => line.slice(0, 250))
        .join('\n');
}

function toSummary(report) {
    const recipeSentence = report.recipeStarted
        ? 'The distributed recipe started.'
        : 'The distributed recipe did not start.';
    const artifactSentence = report.distributedArtifactAvailable
        ? 'Distributed artifacts are available.'
        : 'No distributed artifact was created.';

    return [
        '## Hetzner operation diagnostics',
        '',
        '| Field | Value |',
        '| --- | --- |',
        `| Status | ${report.status} |`,
        `| Phase | ${report.phase} |`,
        `| Stage | ${report.stage} |`,
        `| Failure category | ${report.failureCategory} |`,
        `| Component | ${report.component} |`,
        `| Exit code | ${report.exitCode} |`,
        `| Commit | \`${report.commitSha}\` |`,
        `| Control run | \`${report.controlRunId}\` |`,
        `| Distributed run | \`${report.distributedRunId}\` |`,
        `| Manifest materialization | ${report.materializationStatus} (${report.groupIsolationMode}) |`,
        `| Source group | \`${report.sourceGroupRef.applicationId}/${report.sourceGroupRef.workspaceId}/${report.sourceGroupRef.groupId}\` |`,
        `| Effective group | \`${report.effectiveGroupRef.applicationId}/${report.effectiveGroupRef.workspaceId}/${report.effectiveGroupRef.groupId}\` |`,
        `| Source manifest SHA-256 | \`${report.sourceManifestSha256}\` |`,
        `| Materialized manifest SHA-256 | \`${report.materializedManifestSha256}\` |`,
        '',
        `${recipeSentence} ${artifactSentence}`,
        '',
        `**Next action:** ${report.nextAction}`,
        '',
        '<details><summary>Sanitized evidence</summary>',
        '',
        '```text',
        report.evidenceExcerpt || '(no operation output captured)',
        '```',
        '',
        '</details>',
        ''
    ].join('\n');
}

const argumentsByName = readArguments(process.argv.slice(2));
const requestedStatus = argumentsByName.get('status');
if (requestedStatus !== 'succeeded' && requestedStatus !== 'failed') {
    throw new Error(`status must be succeeded or failed; received ${requestedStatus}`);
}

const rawLog = await readFile(argumentsByName.get('log'), 'utf8').catch(() => '');
const sanitizedLog = sanitizeOperationLog(rawLog);
const stage = readOperationStage(sanitizedLog);
const phase = argumentsByName.get('phase');
const distributedArtifactAvailable = readBoolean(
    argumentsByName.get('artifact-available'),
    'artifact-available'
);
const missingArtifacts = requestedStatus === 'succeeded' && phase !== 'prepare' && !distributedArtifactAvailable;
const status = missingArtifacts ? 'failed' : requestedStatus;
const materialization = await readMaterialization(
    argumentsByName.get('materialization-record'),
    argumentsByName.get('materialized-manifest')
);
const classification = classifyFailure({
    status,
    stage,
    log: sanitizedLog,
    missingArtifacts
});
const report = {
    schemaVersion: 2,
    status,
    phase,
    stage,
    failureCategory: classification.failureCategory,
    component: classification.component,
    exitCode: Number(argumentsByName.get('exit-code')),
    commitSha: argumentsByName.get('commit'),
    manifestPath: argumentsByName.get('manifest'),
    controlRunId: argumentsByName.get('control-run-id'),
    distributedRunId: argumentsByName.get('distributed-run-id'),
    distributedArtifactAvailable,
    materializationStatus: materialization.materializationStatus,
    groupIsolationMode: materialization.groupIsolationMode,
    sourceGroupRef: materialization.sourceGroupRef,
    effectiveGroupRef: materialization.effectiveGroupRef,
    sourceManifestSha256: materialization.sourceManifestSha256,
    materializedManifestSha256: materialization.materializedManifestSha256,
    materializedManifestAvailable: materialization.materializedManifestAvailable,
    recipeStarted: /^RALLAR_OPERATION_STAGE=recipe-execution$/m.test(sanitizedLog),
    startedAt: argumentsByName.get('started-at'),
    finishedAt: argumentsByName.get('finished-at'),
    evidenceExcerpt: toEvidenceExcerpt(sanitizedLog),
    nextAction: classification.nextAction
};

if (!Number.isInteger(report.exitCode) || report.exitCode < 0) {
    throw new Error(`exit-code must be a non-negative integer; received ${report.exitCode}`);
}

const outputDirectory = path.resolve(argumentsByName.get('output-dir'));
await mkdir(outputDirectory, { recursive: true });
await writeFile(
    path.join(outputDirectory, 'operation-report.json'),
    `${JSON.stringify(report, null, 2)}\n`
);
await writeFile(path.join(outputDirectory, 'summary.md'), toSummary(report));
await writeFile(path.join(outputDirectory, 'evidence.log'), `${report.evidenceExcerpt}\n`);
if (materialization.materializedManifestAvailable) {
    await copyFile(
        argumentsByName.get('materialized-manifest'),
        path.join(outputDirectory, 'materialized-manifest.json')
    );
}
await writeFile(
    path.join(outputDirectory, 'manifest-materialization.json'),
    `${
        JSON.stringify(
            materialization.record ?? {
                schemaVersion: 1,
                status: 'failed',
                isolationMode: 'unresolved',
                sourceGroupRef: unavailableGroupRef,
                effectiveGroupRef: unavailableGroupRef,
                sourceManifestSha256: 'unavailable',
                materializedManifestSha256: 'unavailable'
            },
            null,
            2
        )
    }\n`
);
