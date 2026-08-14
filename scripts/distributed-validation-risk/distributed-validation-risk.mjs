import {
  isSafeRepositoryPath,
  parseAdaptivePlanRecord,
  validateAdaptivePlanRecord,
} from '../plan-adaptation/adaptive-plan-record.mjs';

const ordinaryStatusPattern = /^[ABDMRTXU]$/u;
const copyOrRenameStatusPattern = /^[CR][0-9]{1,3}$/u;

const distributedProtocolControllerHeadlessPaths = new Set([
  'apps/api-v1/deno.json',
  'apps/api-v1/deno.lock',
  'deno.json',
  'deno.lock',
  'package-lock.json',
  'package.json',
  'apps/rallar-black-box/package.json',
  'apps/rallar-black-box/scripts/headless-worker.ts',
  'packages/shared-test/package.json',
]);

const distributedProtocolControllerHeadlessRoots = [
  'packages/shared-test/black-box-runner/browser',
  'packages/shared-test/json-compare',
  'packages/shared-test/rallar-bb-test',
];

const deploymentWorkflowPaths = new Set(['.github/workflows/deploy-hetzner-controller.yml']);

const riskFamilies = [
  {
    name: 'distributed-protocol-controller-headless',
    matches: isDistributedProtocolControllerHeadlessPath,
  },
  {
    name: 'realtime-routing-topology',
    matches: isRealtimeRoutingTopologyPath,
  },
  {
    name: 'deployment-runner',
    matches: isDeploymentRunnerPath,
  },
];

export function classifyDistributedValidationRisk(input) {
  if (input.eventName === 'workflow_dispatch') {
    return {
      selected: true,
      reasonCode: 'manual-override',
      reason: 'Distributed validation selected: workflow_dispatch operator override.',
      riskFamilies: [],
      riskPaths: [],
      planRequirements: [],
    };
  }

  const changedPathIssues = validateChangedPathRecords(input.changedPathRecords);
  const planSelection = readPlanRequirements(input.planDocuments);
  const issues = [...(input.changedPathIssues ?? []), ...changedPathIssues, ...planSelection.issues]
    .filter((issue) => typeof issue === 'string' && issue.trim() !== '')
    .sort();
  if (input.eventName !== 'push') {
    issues.push(`unsupported event name: ${String(input.eventName)}`);
  }
  if (issues.length > 0) {
    return invalidInputSelection(issues);
  }

  const pathSelection = classifyRiskPaths(input.changedPathRecords);
  return createSelection(pathSelection, planSelection.requirements);
}

export function decodeGitChangedPathRecords(rawRecords) {
  if (typeof rawRecords !== 'string') {
    return { records: [], issues: ['changed-path input must be a string'] };
  }
  if (rawRecords === '') {
    return { records: [], issues: [] };
  }
  if (!rawRecords.endsWith('\0')) {
    return { records: [], issues: ['changed-path input must end with a NUL delimiter'] };
  }

  const fields = rawRecords.split('\0');
  fields.pop();
  const records = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    const copyOrRename = isCopyOrRenameStatus(status);
    if (!copyOrRename && !ordinaryStatusPattern.test(status)) {
      return {
        records: [],
        issues: [`changed-path record has unsupported status: ${status}`],
      };
    }
    const pathCount = copyOrRename ? 2 : 1;
    if (index + pathCount >= fields.length) {
      return {
        records: [],
        issues: [changedPathCountIssue(status, pathCount)],
      };
    }
    records.push({ status, paths: fields.slice(index + 1, index + 1 + pathCount) });
    index += pathCount + 1;
  }
  return { records, issues: [] };
}

function validateChangedPathRecords(records) {
  if (!Array.isArray(records)) {
    return ['changed-path records must be an array'];
  }
  const issues = [];
  const observedPaths = new Set();
  for (const [index, record] of records.entries()) {
    const name = `changed-path record ${index}`;
    if (!isRecord(record)) {
      issues.push(`${name} must be an object`);
      continue;
    }
    const unsupportedFields = Object.keys(record)
      .filter((field) => !['status', 'paths'].includes(field))
      .sort();
    if (unsupportedFields.length > 0) {
      issues.push(`${name} contains unsupported fields: ${unsupportedFields.join(', ')}`);
    }
    const expectedPathCount = isCopyOrRenameStatus(record.status)
      ? 2
      : ordinaryStatusPattern.test(record.status)
        ? 1
        : undefined;
    if (expectedPathCount === undefined) {
      issues.push(`${name} has unsupported status: ${String(record.status)}`);
      continue;
    }
    if (!Array.isArray(record.paths) || record.paths.length !== expectedPathCount) {
      issues.push(`${name} ${record.status} must contain exactly ${expectedPathCount} paths`);
      continue;
    }
    for (const changedPath of record.paths) {
      if (!isSafeRepositoryPath(changedPath)) {
        issues.push(`${name} contains an unsafe repository path: ${String(changedPath)}`);
        continue;
      }
      if (observedPaths.has(changedPath)) {
        issues.push(`changed path is ambiguous because it occurs more than once: ${changedPath}`);
      }
      observedPaths.add(changedPath);
    }
  }
  return issues;
}

function readPlanRequirements(planDocuments) {
  if (!Array.isArray(planDocuments)) {
    return { requirements: [], issues: ['plan documents must be an array'] };
  }
  const requirements = [];
  const issues = [];
  for (const document of planDocuments) {
    if (!isRecord(document) || !isSafeRepositoryPath(document.path)) {
      issues.push('adaptive plan path must be repository-relative');
      continue;
    }
    if (typeof document.markdown !== 'string') {
      issues.push(`${document.path} adaptive plan Markdown must be a string`);
      continue;
    }
    try {
      const record = parseAdaptivePlanRecord(document.markdown, document.path);
      issues.push(
        ...validateAdaptivePlanRecord(record).map((issue) => `${document.path}: ${issue}`),
      );
      if (record.status === 'active' && record.distributedValidation !== undefined) {
        requirements.push({
          planId: record.planId,
          reason: record.distributedValidation.reason,
        });
      }
    } catch (error) {
      issues.push(`${document.path}: ${toError(error).message}`);
    }
  }
  return {
    requirements: requirements.sort((left, right) => left.planId.localeCompare(right.planId)),
    issues,
  };
}

function classifyRiskPaths(changedPathRecords) {
  const familyNames = new Set();
  const paths = new Set();
  for (const record of changedPathRecords) {
    for (const changedPath of record.paths) {
      for (const family of riskFamilies) {
        if (family.matches(changedPath)) {
          familyNames.add(family.name);
          paths.add(changedPath);
        }
      }
    }
  }
  return {
    families: [...familyNames].sort(),
    paths: [...paths].sort(),
  };
}

function createSelection(pathSelection, planRequirements) {
  const hasPathRisk = pathSelection.families.length > 0;
  const hasPlanRequirement = planRequirements.length > 0;
  if (!hasPathRisk && !hasPlanRequirement) {
    return {
      selected: false,
      reasonCode: 'no-distributed-risk',
      reason: 'Distributed validation not selected: no distributed-risk paths or plan requirement.',
      riskFamilies: [],
      riskPaths: [],
      planRequirements: [],
    };
  }

  const reasonCode =
    hasPathRisk && hasPlanRequirement
      ? 'path-risk-and-plan-requirement'
      : hasPathRisk
        ? 'path-risk'
        : 'plan-requirement';
  const reasonParts = [];
  if (hasPathRisk) {
    reasonParts.push(`path risk (${pathSelection.families.join(', ')})`);
  }
  if (hasPlanRequirement) {
    reasonParts.push(
      `active plan requirement (${planRequirements.map((item) => item.planId).join(', ')})`,
    );
  }
  return {
    selected: true,
    reasonCode,
    reason: `Distributed validation selected: ${reasonParts.join(' and ')}.`,
    riskFamilies: pathSelection.families,
    riskPaths: pathSelection.paths,
    planRequirements,
  };
}

function invalidInputSelection(issues) {
  const uniqueIssues = [...new Set(issues.map(toSingleLine))].sort();
  return {
    selected: true,
    reasonCode: 'invalid-input',
    reason: `Distributed validation selected fail-closed: ${uniqueIssues.join('; ')}.`,
    riskFamilies: [],
    riskPaths: [],
    planRequirements: [],
  };
}

function isDistributedProtocolControllerHeadlessPath(changedPath) {
  return (
    distributedProtocolControllerHeadlessPaths.has(changedPath) ||
    distributedProtocolControllerHeadlessRoots.some((root) => isWithin(changedPath, root)) ||
    isWithin(changedPath, 'apps/rallar-black-box-control-server') ||
    isWithin(changedPath, 'apps/rallar-black-box-headless') ||
    isWithin(changedPath, 'apps/rallar-black-box/manifests/hetzner') ||
    isWithin(changedPath, 'apps/rallar-black-box/src/hetzner') ||
    isWithin(changedPath, 'apps/rallar-black-box/src/legacy/runner/distributed') ||
    changedPath.startsWith('apps/rallar-black-box/src/distributed-') ||
    changedPath.startsWith('apps/rallar-black-box/src/headless-worker-') ||
    changedPath.startsWith('apps/rallar-black-box/src/recipe-console/control/distributed-') ||
    /^apps\/rallar-black-box\/scripts\/[^/]*(?:distributed|hetzner)[^/]*$/u.test(changedPath)
  );
}

function isRealtimeRoutingTopologyPath(changedPath) {
  return (
    [
      'packages/shared/rtc',
      'packages/shared/webrtc',
      'packages/shared/multicast',
      'packages/shared-server/rallar-system/topology',
      'packages/shared-server/postgres/rtc-topology',
      'apps/api-v1/src/runtime/rtc-topology',
    ].some((root) => isWithin(changedPath, root)) ||
    /^packages\/shared\/services\/[^/]*(?:rtc|webrtc)[^/]*\.ts$/iu.test(changedPath) ||
    /^packages\/shared\/api\/[^/]*topology[^/]*\.ts$/iu.test(changedPath) ||
    /^packages\/shared-graph\/[^/]*topology[^/]*\.ts$/iu.test(changedPath) ||
    matchesFileWithin(changedPath, 'packages/shared-web/browser', [
      'rtc',
      'realtime',
      'ws-engine',
      'ws-message-router',
    ]) ||
    matchesFileWithin(changedPath, 'packages/shared-server/rallar-system', [
      'rtc',
      'topology',
      'state-sync-routing',
      'ws-system-topics',
      'ws-server-target-resolver',
    ]) ||
    matchesFileWithin(changedPath, 'apps/api-v1/src', [
      'rtc-topology',
      'graph-topology',
      'ws-routes',
      'ws-topic-room-authorizer',
    ])
  );
}

function isDeploymentRunnerPath(changedPath) {
  return (
    deploymentWorkflowPaths.has(changedPath) ||
    changedPath.startsWith('.github/workflows/hetzner-') ||
    isWithin(changedPath, 'scripts/hetzner') ||
    /^scripts\/github-actions\/[^/]*hetzner[^/]*$/u.test(changedPath) ||
    isWithin(changedPath, 'apps/rallar-black-box/manifests/hetzner')
  );
}

function isWithin(changedPath, root) {
  return changedPath === root || changedPath.startsWith(`${root}/`);
}

function matchesFileWithin(changedPath, root, nameParts) {
  if (!isWithin(changedPath, root) || !changedPath.endsWith('.ts')) {
    return false;
  }
  const fileName = changedPath.slice(changedPath.lastIndexOf('/') + 1);
  return nameParts.some((namePart) => fileName.includes(namePart));
}

function changedPathCountIssue(status, pathCount) {
  const count = pathCount === 2 ? 'two' : 'one';
  return `changed-path record ${status} must contain exactly ${count} paths`;
}

function isCopyOrRenameStatus(status) {
  if (typeof status !== 'string' || !copyOrRenameStatusPattern.test(status)) {
    return false;
  }
  const similarity = Number(status.slice(1));
  return similarity >= 0 && similarity <= 100;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSingleLine(value) {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
