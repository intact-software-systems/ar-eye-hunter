#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
    mkdir,
    readFile,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Either } from '../../../packages/shared/resilience/Either.ts';
import { toError } from '../../../packages/shared/resilience/to-error.ts';
import { parseRtcCaptureMode } from '../../../packages/shared/webrtc/rtc-capture-configuration.ts';

import { toEffectiveHetznerRunManifestScope, validateHetznerRunManifestScope } from './hetzner-run-manifest-scope.mjs';

/**
 * @typedef {object} MaterializerInput
 * @property {string} sourcePath
 * @property {string} outputPath
 * @property {string} recordOutputPath
 * @property {string} agentSource
 * @property {string} operatorPhase
 * @property {string} controlRunId
 * @property {string} distributedRunId
 * @property {string} repository
 * @property {string} workflowRunId
 * @property {string} workflowRunAttempt
 * @property {string} applicationId
 * @property {string} workspaceId
 * @property {string} roomId
 * @property {string} [rtcCaptureMode] Absent when preserving authored capture.
 */

/**
 * @typedef {object} MaterializerOutputDependencies
 * @property {(directory: string) => Promise<void>} mkdir
 * @property {(filePath: string, contents: string) => Promise<void>} writeFile
 * @property {(source: string, destination: string) => Promise<void>} rename
 * @property {(filePath: string) => Promise<void>} removeTemporary
 * @property {() => string} temporaryIdentity
 */

/**
 * @typedef {object} MaterializerDependencies
 * @property {(filePath: string) => Promise<string>} readSourceText
 * @property {MaterializerOutputDependencies} output
 */

/**
 * @typedef {object} MaterializerExpectedFailure
 * @property {'validation'} kind
 * @property {string} message
 */

/**
 * @typedef {object} MaterializerRuntimeFailure
 * @property {'runtime'} kind
 * @property {string} operation
 * @property {Error} cause
 */

/** @typedef {MaterializerExpectedFailure | MaterializerRuntimeFailure} MaterializerFailure */

/**
 * @typedef {object} MaterializerRecord
 * @property {number} schemaVersion
 * @property {'explicit' | 'isolated' | 'preserved'} isolationMode
 * @property {import('../../../packages/shared-test/rallar-bb-test/distributed-run.ts').RallarBlackBoxDistributedGroupRef} sourceGroupRef
 * @property {import('../../../packages/shared-test/rallar-bb-test/distributed-run.ts').RallarBlackBoxDistributedGroupRef} effectiveGroupRef
 * @property {string} sourceManifestSha256
 * @property {string} materializedManifestSha256
 */

/**
 * @typedef {object} MaterializerComputation
 * @property {string} manifestText
 * @property {MaterializerRecord} record
 * @property {string} recordText
 */

/**
 * @typedef {object} MaterializerSource
 * @property {string} text
 * @property {unknown} manifest
 */

const argumentNames = [
    'source',
    'output',
    'record-output',
    'agent-source',
    'operator-phase',
    'control-run-id',
    'distributed-run-id',
    'repository',
    'workflow-run-id',
    'workflow-run-attempt',
    'application-id',
    'workspace-id',
    'room-id'
];

function toMaterializerArguments(values) {
    const argumentsByName = new Map();
    for (let index = 0; index < values.length; index += 2) {
        const name = values[index]?.replace(/^--/, '');
        const value = values[index + 1];
        if (!name || value === undefined) {
            return Either.ofLeft({
                kind: 'validation',
                message: `Expected --name value arguments; received ${values.join(' ')}`
            });
        }
        argumentsByName.set(name, value);
    }
    const missing = argumentNames.filter((name) => !argumentsByName.has(name));
    return missing.length > 0
        ? Either.ofLeft({
            kind: 'validation',
            message: missing.map((name) => `Missing required argument --${name}`).join('\n')
        })
        : Either.ofRight(argumentsByName);
}

function validateMaterializerText(value, label) {
    return typeof value !== 'string' || value.trim().length === 0 ? [`${label} must be a non-empty string.`] : [];
}

function toSourceGroupRef(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return Either.ofLeft({ kind: 'validation', message: 'manifest.group must be an object.' });
    }
    const issues = ['applicationId', 'workspaceId', 'groupId'].flatMap((key) =>
        validateMaterializerText(value[key], `manifest.group.${key}`)
    );
    return issues.length > 0 ? Either.ofLeft({ kind: 'validation', message: issues.join('\n') }) : Either.ofRight({
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId
    });
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function computeIsolatedGroupId(input) {
    const canonicalIdentity = JSON.stringify({
        namespace: 'rallar-hetzner-run-group-v1',
        repository: input.repository,
        workflowRunId: input.workflowRunId,
        workflowRunAttempt: input.workflowRunAttempt,
        controlRunId: input.controlRunId,
        sourceManifestSha256: input.sourceManifestSha256,
        sourceGroupRef: input.sourceGroupRef
    });

    return `hetzner-run-${sha256(canonicalIdentity)}`;
}

function validateAgentSource(value) {
    return ['hetzner', 'external', 'mixed'].includes(value)
        ? []
        : [`agent-source must be hetzner, external, or mixed; received ${value}`];
}

function validateOperatorPhase(value) {
    return ['full', 'prepare', 'run'].includes(value)
        ? []
        : [`operator-phase must be full, prepare, or run; received ${value}`];
}

function resolveEffectiveGroup(input) {
    if (input.roomId.length > 0) {
        return {
            isolationMode: 'explicit',
            effectiveGroupRef: {
                applicationId: input.applicationId || input.sourceGroupRef.applicationId,
                workspaceId: input.workspaceId || input.sourceGroupRef.workspaceId,
                groupId: input.roomId
            }
        };
    }

    if (input.agentSource === 'hetzner' && input.operatorPhase !== 'prepare') {
        return {
            isolationMode: 'isolated',
            effectiveGroupRef: {
                applicationId: input.applicationId || input.sourceGroupRef.applicationId,
                workspaceId: input.workspaceId || input.sourceGroupRef.workspaceId,
                groupId: computeIsolatedGroupId(input)
            }
        };
    }

    return {
        isolationMode: 'preserved',
        effectiveGroupRef: input.sourceGroupRef
    };
}

/**
 * @param {MaterializerInput} input
 * @param {MaterializerDependencies} dependencies
 * @returns {Promise<Either<MaterializerFailure, MaterializerRecord>>}
 */
export async function materializeHetznerRunManifest(input, dependencies) {
    const issues = [...validateAgentSource(input.agentSource), ...validateOperatorPhase(input.operatorPhase)];
    if (issues.length > 0) {
        return Either.ofLeft({ kind: 'validation', message: issues.join('\n') });
    }
    const capture = parseRtcCaptureMode(input.rtcCaptureMode?.trim() === '' ? undefined : input.rtcCaptureMode);
    if (capture.right === undefined) {
        return capture.mapLeft((issues) => ({
            kind: 'validation',
            message: issues.map((issue) => issue.message).join('\n')
        }));
    }
    const source = await readMaterializerSource(input.sourcePath, dependencies.readSourceText);
    if (source.right === undefined) {
        return source;
    }
    const computed = computeMaterializedManifest(input, source.right, capture.right.mode);
    if (computed.right === undefined) {
        return computed;
    }
    const written = await writeAtomic(input.outputPath, computed.right.manifestText, dependencies.output);
    if (written.right === undefined) {
        return written;
    }
    const recorded = await writeAtomic(input.recordOutputPath, computed.right.recordText, dependencies.output);
    return recorded.mapRight(() => computed.right.record);
}

/** @returns {Either<MaterializerFailure, MaterializerComputation>} */
function computeMaterializedManifest(input, source, captureMode) {
    const group = toSourceGroupRef(source.manifest?.group);
    if (group.right === undefined) {
        return group;
    }
    const sourceGroupRef = group.right;
    const sourceIssues = validateHetznerRunManifestScope(source.manifest, sourceGroupRef);
    if (sourceIssues.length > 0) {
        return Either.ofLeft({
            kind: 'validation',
            message: `Source manifest scope is inconsistent:\n- ${sourceIssues.join('\n- ')}`
        });
    }
    const sourceManifestSha256 = sha256(source.text);
    const effective = resolveEffectiveGroup({ ...input, sourceGroupRef, sourceManifestSha256 });
    const scopedManifest = toEffectiveHetznerRunManifestScope(
        source.manifest,
        sourceGroupRef,
        effective.effectiveGroupRef
    );
    const manifest = {
        ...scopedManifest,
        ...(captureMode === undefined ? {} : { rtcCaptureMode: captureMode }),
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        metadata: {
            ...(scopedManifest.metadata ?? {}),
            runIsolation: {
                schemaVersion: 1,
                isolationMode: effective.isolationMode,
                effectiveGroupRef: effective.effectiveGroupRef,
                workflowRunId: input.workflowRunId,
                workflowRunAttempt: input.workflowRunAttempt
            }
        }
    };
    const effectiveIssues = validateHetznerRunManifestScope(manifest, effective.effectiveGroupRef);
    if (effectiveIssues.length > 0) {
        return Either.ofLeft({
            kind: 'validation',
            message: `Materialized manifest scope is inconsistent:\n- ${effectiveIssues.join('\n- ')}`
        });
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const record = {
        schemaVersion: 1,
        isolationMode: effective.isolationMode,
        sourceGroupRef,
        effectiveGroupRef: effective.effectiveGroupRef,
        sourceManifestSha256,
        materializedManifestSha256: sha256(manifestText)
    };
    return Either.ofRight({ manifestText, record, recordText: `${JSON.stringify(record, null, 2)}\n` });
}

/** @returns {Promise<Either<MaterializerFailure, MaterializerSource>>} */
async function readMaterializerSource(sourcePath, readSourceText) {
    try {
        const text = await readSourceText(sourcePath);
        return Either.ofRight({ text, manifest: JSON.parse(text) });
    }
    catch (cause) {
        return Either.ofLeft({ kind: 'runtime', operation: `read source ${sourcePath}`, cause: toError(cause) });
    }
}

/** @param {MaterializerOutputDependencies} dependencies */
async function writeAtomic(filePath, contents, dependencies) {
    let temporaryPath;
    try {
        await dependencies.mkdir(path.dirname(filePath));
        temporaryPath = `${filePath}.${dependencies.temporaryIdentity()}.tmp`;
        await dependencies.writeFile(temporaryPath, contents);
        await dependencies.rename(temporaryPath, filePath);
        return Either.ofRight(true);
    }
    catch (cause) {
        const error = toError(cause);
        if (temporaryPath !== undefined) {
            try {
                await dependencies.removeTemporary(temporaryPath);
            }
            catch (cleanupCause) {
                return Either.ofLeft({
                    kind: 'runtime',
                    operation: `write ${filePath}`,
                    cause: new AggregateError([error, toError(cleanupCause)], error.message)
                });
            }
        }
        return Either.ofLeft({ kind: 'runtime', operation: `write ${filePath}`, cause: error });
    }
}

function toMaterializerInput(argumentsByName) {
    const requiredTextNames = [
        'control-run-id',
        'distributed-run-id',
        'repository',
        'workflow-run-id',
        'workflow-run-attempt'
    ];
    const issues = requiredTextNames.flatMap((name) => validateMaterializerText(argumentsByName.get(name), name));
    if (issues.length > 0) {
        return Either.ofLeft({ kind: 'validation', message: issues.join('\n') });
    }
    return Either.ofRight({
        sourcePath: argumentsByName.get('source'),
        outputPath: argumentsByName.get('output'),
        recordOutputPath: argumentsByName.get('record-output'),
        agentSource: argumentsByName.get('agent-source'),
        operatorPhase: argumentsByName.get('operator-phase'),
        controlRunId: argumentsByName.get('control-run-id'),
        distributedRunId: argumentsByName.get('distributed-run-id'),
        repository: argumentsByName.get('repository'),
        workflowRunId: argumentsByName.get('workflow-run-id'),
        workflowRunAttempt: argumentsByName.get('workflow-run-attempt'),
        applicationId: argumentsByName.get('application-id'),
        workspaceId: argumentsByName.get('workspace-id'),
        roomId: argumentsByName.get('room-id'),
        rtcCaptureMode: argumentsByName.get('rtc-capture-mode')
    });
}

async function main() {
    const input = toMaterializerArguments(process.argv.slice(2)).flatMap(Either.ofLeft, toMaterializerInput)
        .fold((failure) => {
            throw new Error(toMaterializerFailureText(failure));
        }, (input) => input);
    /** @type {MaterializerDependencies} */
    const dependencies = {
        readSourceText: (filePath) => readFile(filePath, 'utf8'),
        output: {
            mkdir: async (directory) => {
                await mkdir(directory, { recursive: true });
            },
            writeFile: async (filePath, contents) => {
                await writeFile(filePath, contents);
            },
            rename,
            removeTemporary: (filePath) => rm(filePath, { force: true }),
            temporaryIdentity: () => `${process.pid}.${randomUUID()}`
        }
    };
    const outcome = await materializeHetznerRunManifest(input, dependencies);
    outcome.fold((failure) => {
        throw new Error(toMaterializerFailureText(failure));
    }, (record) => process.stdout.write(`${JSON.stringify(record)}\n`));
}

function toMaterializerFailureText(failure) {
    return failure.kind === 'runtime' ? failure.cause.message : failure.message;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((error) => {
        console.error(toError(error).message);
        process.exitCode = 1;
    });
}
