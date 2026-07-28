#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'room-id',
];

const identityFieldNames = new Set(['applicationId', 'workspaceId', 'groupId', 'roomId']);

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

function readRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readGroupRef(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return {
    applicationId: readRequiredString(value.applicationId, `${label}.applicationId`),
    workspaceId: readRequiredString(value.workspaceId, `${label}.workspaceId`),
    groupId: readRequiredString(value.groupId, `${label}.groupId`),
  };
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
    sourceGroupRef: input.sourceGroupRef,
  });

  return `hetzner-run-${sha256(canonicalIdentity)}`;
}

function validateAgentSource(value) {
  if (!['hetzner', 'external', 'mixed'].includes(value)) {
    throw new Error(`agent-source must be hetzner, external, or mixed; received ${value}`);
  }
}

function validateOperatorPhase(value) {
  if (!['full', 'prepare', 'run'].includes(value)) {
    throw new Error(`operator-phase must be full, prepare, or run; received ${value}`);
  }
}

function resolveEffectiveGroup(input) {
  if (input.roomId.length > 0) {
    return {
      isolationMode: 'explicit',
      effectiveGroupRef: {
        applicationId: input.applicationId || input.sourceGroupRef.applicationId,
        workspaceId: input.workspaceId || input.sourceGroupRef.workspaceId,
        groupId: input.roomId,
      },
    };
  }

  if (input.agentSource === 'hetzner' && input.operatorPhase !== 'prepare') {
    return {
      isolationMode: 'isolated',
      effectiveGroupRef: {
        applicationId: input.applicationId || input.sourceGroupRef.applicationId,
        workspaceId: input.workspaceId || input.sourceGroupRef.workspaceId,
        groupId: computeIsolatedGroupId(input),
      },
    };
  }

  return {
    isolationMode: 'preserved',
    effectiveGroupRef: input.sourceGroupRef,
  };
}

function decodePathSegment(value, location, issues) {
  try {
    return decodeURIComponent(value);
  } catch {
    issues.push(`${location} contains an invalid URI-encoded identity segment ${JSON.stringify(value)}`);
    return value;
  }
}

function validateEmbeddedPathScope(value, expectedGroupRef, location) {
  if (!value.startsWith('/api/state/apps/')) {
    return [];
  }

  const issues = [];
  const match = value.match(
    /^\/api\/state\/apps\/([^/]+)\/workspaces\/([^/]+)\/groups(?:\/([^/]+))?(?:\/|$)/,
  );
  if (!match) {
    return [`${location} has an unrecognized state group path ${JSON.stringify(value)}`];
  }

  const applicationId = decodePathSegment(match[1], location, issues);
  const workspaceId = decodePathSegment(match[2], location, issues);
  const groupId = match[3] === undefined ? undefined : decodePathSegment(match[3], location, issues);
  if (applicationId !== expectedGroupRef.applicationId) {
    issues.push(
      `${location} contains application ${JSON.stringify(applicationId)}; expected ${JSON.stringify(expectedGroupRef.applicationId)}`,
    );
  }
  if (workspaceId !== expectedGroupRef.workspaceId) {
    issues.push(
      `${location} contains workspace ${JSON.stringify(workspaceId)}; expected ${JSON.stringify(expectedGroupRef.workspaceId)}`,
    );
  }
  if (groupId !== undefined && groupId !== expectedGroupRef.groupId) {
    issues.push(
      `${location} contains group ${JSON.stringify(groupId)}; expected ${JSON.stringify(expectedGroupRef.groupId)}`,
    );
  }
  return issues;
}

function validateEmbeddedRequestScope(value, expectedGroupRef, location) {
  const marker = value.includes(':ensure-group:')
    ? ':ensure-group:'
    : value.includes(':ensure-member:')
      ? ':ensure-member:'
      : undefined;
  if (!marker) {
    return [];
  }

  const scope = value.slice(value.indexOf(marker) + marker.length).split(':');
  const expectedScope = [
    expectedGroupRef.applicationId,
    expectedGroupRef.workspaceId,
    expectedGroupRef.groupId,
  ];
  if (scope.length < expectedScope.length) {
    return [`${location} has an incomplete scoped request identity ${JSON.stringify(value)}`];
  }

  return expectedScope.flatMap((expected, index) =>
    scope[index] === expected
      ? []
      : [
          `${location} contains scoped request identity ${JSON.stringify(value)}; expected ${JSON.stringify(expectedGroupRef)}`,
        ],
  );
}

function validateEmbeddedScope(value, key, expectedGroupRef, location) {
  if (typeof value !== 'string') {
    return [];
  }
  if (key === 'path') {
    return validateEmbeddedPathScope(value, expectedGroupRef, location);
  }
  if (key === 'requestId' || key.toLowerCase() === 'idempotency-key') {
    return validateEmbeddedRequestScope(value, expectedGroupRef, location);
  }
  return [];
}

function validateManifestScope(value, expectedGroupRef, location = '$') {
  const issues = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      issues.push(...validateManifestScope(entry, expectedGroupRef, `${location}[${index}]`));
    });
    return issues;
  }

  if (!value || typeof value !== 'object') {
    return issues;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryLocation = `${location}.${key}`;
    issues.push(...validateEmbeddedScope(entry, key, expectedGroupRef, entryLocation));
    if (identityFieldNames.has(key) && typeof entry === 'string') {
      const expected =
        key === 'applicationId'
          ? expectedGroupRef.applicationId
          : key === 'workspaceId'
            ? expectedGroupRef.workspaceId
            : expectedGroupRef.groupId;
      if (entry !== expected) {
        issues.push(
          `${entryLocation} is ${JSON.stringify(entry)}; expected ${JSON.stringify(expected)}`,
        );
      }
    }
    issues.push(...validateManifestScope(entry, expectedGroupRef, entryLocation));
  }

  return issues;
}

function toEmbeddedScope(value, sourceGroupRef, effectiveGroupRef, key) {
  if (key === 'path') {
    const sourcePrefix =
      `/apps/${encodeURIComponent(sourceGroupRef.applicationId)}` +
      `/workspaces/${encodeURIComponent(sourceGroupRef.workspaceId)}/groups`;
    const effectivePrefix =
      `/apps/${encodeURIComponent(effectiveGroupRef.applicationId)}` +
      `/workspaces/${encodeURIComponent(effectiveGroupRef.workspaceId)}/groups`;
    return value
      .replaceAll(sourcePrefix, effectivePrefix)
      .replaceAll(
        `/${encodeURIComponent(sourceGroupRef.groupId)}`,
        `/${encodeURIComponent(effectiveGroupRef.groupId)}`,
      );
  }

  const sourceRequestScope =
    `:${sourceGroupRef.applicationId}:` +
    `${sourceGroupRef.workspaceId}:${sourceGroupRef.groupId}:`;
  const effectiveRequestScope =
    `:${effectiveGroupRef.applicationId}:` +
    `${effectiveGroupRef.workspaceId}:${effectiveGroupRef.groupId}:`;
  return value
    .replaceAll(sourceRequestScope, effectiveRequestScope)
    .replaceAll(sourceGroupRef.groupId, effectiveGroupRef.groupId);
}

function toEffectiveScope(value, sourceGroupRef, effectiveGroupRef, key = '') {
  if (Array.isArray(value)) {
    return value.map((entry) => toEffectiveScope(entry, sourceGroupRef, effectiveGroupRef));
  }

  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') {
      return value;
    }
    return toEmbeddedScope(value, sourceGroupRef, effectiveGroupRef, key);
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => {
      if (entryKey === 'applicationId' && entry === sourceGroupRef.applicationId) {
        return [entryKey, effectiveGroupRef.applicationId];
      }
      if (entryKey === 'workspaceId' && entry === sourceGroupRef.workspaceId) {
        return [entryKey, effectiveGroupRef.workspaceId];
      }
      if ((entryKey === 'groupId' || entryKey === 'roomId') && entry === sourceGroupRef.groupId) {
        return [entryKey, effectiveGroupRef.groupId];
      }
      return [entryKey, toEffectiveScope(entry, sourceGroupRef, effectiveGroupRef, entryKey)];
    }),
  );
}

async function writeAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, filePath);
}

export async function materializeHetznerRunManifest(input) {
  const sourceText = await readFile(input.sourcePath, 'utf8');
  const sourceManifest = JSON.parse(sourceText);
  const sourceGroupRef = readGroupRef(sourceManifest.group, 'manifest.group');
  const sourceIssues = validateManifestScope(sourceManifest, sourceGroupRef);
  if (sourceIssues.length > 0) {
    throw new Error(`Source manifest scope is inconsistent:\n- ${sourceIssues.join('\n- ')}`);
  }

  const sourceManifestSha256 = sha256(sourceText);
  const effective = resolveEffectiveGroup({
    ...input,
    sourceGroupRef,
    sourceManifestSha256,
  });
  const scopedManifest = toEffectiveScope(
    sourceManifest,
    sourceGroupRef,
    effective.effectiveGroupRef,
  );
  const manifest = {
    ...scopedManifest,
    distributedRunId: input.distributedRunId,
    controlRunId: input.controlRunId,
    metadata: {
      ...(scopedManifest.metadata ?? {}),
      runIsolation: {
        schemaVersion: 1,
        isolationMode: effective.isolationMode,
        effectiveGroupRef: effective.effectiveGroupRef,
        workflowRunId: input.workflowRunId,
        workflowRunAttempt: input.workflowRunAttempt,
      },
    },
  };
  const effectiveIssues = validateManifestScope(manifest, effective.effectiveGroupRef);
  if (effectiveIssues.length > 0) {
    throw new Error(
      `Materialized manifest scope is inconsistent:\n- ${effectiveIssues.join('\n- ')}`,
    );
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const record = {
    schemaVersion: 1,
    isolationMode: effective.isolationMode,
    sourceGroupRef,
    effectiveGroupRef: effective.effectiveGroupRef,
    sourceManifestSha256,
    materializedManifestSha256: sha256(manifestText),
  };

  await writeAtomic(input.outputPath, manifestText);
  await writeAtomic(input.recordOutputPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function main() {
  const argumentsByName = readArguments(process.argv.slice(2));
  const agentSource = argumentsByName.get('agent-source');
  const operatorPhase = argumentsByName.get('operator-phase');
  validateAgentSource(agentSource);
  validateOperatorPhase(operatorPhase);

  const record = await materializeHetznerRunManifest({
    sourcePath: argumentsByName.get('source'),
    outputPath: argumentsByName.get('output'),
    recordOutputPath: argumentsByName.get('record-output'),
    agentSource,
    operatorPhase,
    controlRunId: readRequiredString(argumentsByName.get('control-run-id'), 'control-run-id'),
    distributedRunId: readRequiredString(
      argumentsByName.get('distributed-run-id'),
      'distributed-run-id',
    ),
    repository: readRequiredString(argumentsByName.get('repository'), 'repository'),
    workflowRunId: readRequiredString(argumentsByName.get('workflow-run-id'), 'workflow-run-id'),
    workflowRunAttempt: readRequiredString(
      argumentsByName.get('workflow-run-attempt'),
      'workflow-run-attempt',
    ),
    applicationId: argumentsByName.get('application-id'),
    workspaceId: argumentsByName.get('workspace-id'),
    roomId: argumentsByName.get('room-id'),
  });

  process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
