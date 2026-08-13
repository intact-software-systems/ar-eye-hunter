import { describe, expect, it } from 'vitest';

import {
  classifyDistributedValidationRisk,
  decodeGitChangedPathRecords,
} from '../../../../scripts/distributed-validation-risk/distributed-validation-risk.mjs';
import {
  parseAdaptivePlanRecord,
  replaceAdaptivePlanRecord,
  validateAdaptivePlanRecord,
} from '../../../../scripts/plan-adaptation/adaptive-plan-record.mjs';

const activePlanPath = 'plans/distributed-validation-fixture.md';
const activePlanMarkdown = createActivePlanMarkdown();

describe('distributed validation risk classification', () => {
  it.each([
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/rallar-black-box-control-server/src/control-service.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/rallar-black-box-headless/src/main.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/control-protocol.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/rallar-black-box/scripts/headless-worker.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/browser-control-agent.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/browser-control-agent-config.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/control-client.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/rallar-black-box/package.json',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/browser-adapter.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/client-defaults.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/distributed-run.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/redaction.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/runtime.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/schema.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/types.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/runtime.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/rallar-black-box/src/headless-worker-config.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/rallar-black-box/src/headless-worker-runtime.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/diagnostics.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/rtc-stream.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/control-snapshots.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/fleet-report.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/control-retention.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/control-retention-canonical.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/recipe-fixtures.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/package.json',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'package.json',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'package-lock.json',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'deno.lock',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'apps/api-v1/deno.lock',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/browser/rtc-connect-readiness.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/assert/assert-value-operators.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/wait/wait-for-event.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/rallar-bb-test/loop/loop-until.ts',
    },
    {
      family: 'distributed-protocol-controller-headless',
      path: 'packages/shared-test/json-compare/json-compare.ts',
    },
    {
      family: 'realtime-routing-topology',
      path: 'packages/shared/multicast/WebRtcOverlayMulticastService.ts',
    },
    {
      family: 'realtime-routing-topology',
      path: 'packages/shared-server/rallar-system/topology/group-topology-management-service.ts',
    },
    {
      family: 'deployment-runner',
      path: '.github/workflows/hetzner-distributed-recipe-runner.yml',
    },
    {
      family: 'deployment-runner',
      path: '.github/workflows/deploy-hetzner-controller.yml',
    },
    {
      family: 'deployment-runner',
      path: 'scripts/hetzner/controller/08-rollout-controller.sh',
    },
  ])('selects $family for $path', ({ family, path: changedPath }) => {
    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: 'M', paths: [changedPath] }],
      planDocuments: [],
    });

    expect(result).toMatchObject({
      selected: true,
      reasonCode: 'path-risk',
      riskFamilies: [family],
    });
  });

  it.each([
    'apps/rallar-black-box/src/scorecard.ts',
    'apps/rallar-black-box/scripts/export-report.ts',
    'packages/shared-test/test-data/unrelated-fixture.json',
    'packages/shared-test/docs/unrelated-guide.md',
    'packages/shared-web/browser/app-data.ts',
    '.github/workflows/release-gate.yml',
    'docs/operator-guide.md',
  ])('keeps unrelated path %s cheap', (changedPath) => {
    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: 'M', paths: [changedPath] }],
      planDocuments: [],
    });

    expect(result).toEqual({
      selected: false,
      reasonCode: 'no-distributed-risk',
      reason: 'Distributed validation not selected: no distributed-risk paths or plan requirement.',
      riskFamilies: [],
      riskPaths: [],
      planRequirements: [],
    });
  });

  it('classifies both endpoints of a rename', () => {
    const movedOut = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [
        {
          status: 'R100',
          paths: [
            'apps/rallar-black-box-headless/src/main.ts',
            'apps/rallar-black-box/src/ordinary-main.ts',
          ],
        },
      ],
      planDocuments: [],
    });
    const movedIn = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [
        {
          status: 'R087',
          paths: [
            'apps/rallar-black-box/src/ordinary-main.ts',
            'packages/shared/rtc/ordinary-main.ts',
          ],
        },
      ],
      planDocuments: [],
    });

    expect(movedOut.riskPaths).toContain('apps/rallar-black-box-headless/src/main.ts');
    expect(movedIn.riskPaths).toContain('packages/shared/rtc/ordinary-main.ts');
    expect(movedOut.selected).toBe(true);
    expect(movedIn.selected).toBe(true);
  });

  it('classifies a deleted risk path and both endpoints of a copy', () => {
    const deleted = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [
        { status: 'D', paths: ['scripts/hetzner/controller/08-rollout-controller.sh'] },
      ],
      planDocuments: [],
    });
    const copied = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [
        {
          status: 'C091',
          paths: [
            'apps/rallar-black-box/src/ordinary-main.ts',
            'apps/rallar-black-box-headless/src/copied-main.ts',
          ],
        },
      ],
      planDocuments: [],
    });

    expect(deleted.riskPaths).toEqual(['scripts/hetzner/controller/08-rollout-controller.sh']);
    expect(copied.riskPaths).toEqual(['apps/rallar-black-box-headless/src/copied-main.ts']);
    expect(deleted.selected).toBe(true);
    expect(copied.selected).toBe(true);
  });

  it.each([
    {
      status: 'A',
      paths: ['apps/rallar-black-box/scripts/headless-worker.ts'],
      expectedPath: 'apps/rallar-black-box/scripts/headless-worker.ts',
    },
    {
      status: 'D',
      paths: ['.github/workflows/deploy-hetzner-controller.yml'],
      expectedPath: '.github/workflows/deploy-hetzner-controller.yml',
    },
    {
      status: 'R100',
      paths: [
        '.github/workflows/deploy-hetzner-controller.yml',
        '.github/workflows/archived-controller-deploy.yml',
      ],
      expectedPath: '.github/workflows/deploy-hetzner-controller.yml',
    },
    {
      status: 'C100',
      paths: [
        'packages/shared-test/rallar-bb-test/browser-control-agent.ts',
        'packages/shared-test/rallar-bb-test/copied-browser-agent.ts',
      ],
      expectedPath: 'packages/shared-test/rallar-bb-test/browser-control-agent.ts',
    },
  ])('selects real headless/deployment closure endpoint for $status', (input) => {
    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: input.status, paths: input.paths }],
      planDocuments: [],
    });

    expect(result.selected).toBe(true);
    expect(result.riskPaths).toContain(input.expectedPath);
  });

  it('selects explicit structured active-plan acceptance', () => {
    const record = parseAdaptivePlanRecord(activePlanMarkdown);
    record.distributedValidation = {
      required: true,
      reason: 'The acceptance proof requires the supported remote matrix.',
    };
    const planMarkdown = replaceAdaptivePlanRecord(activePlanMarkdown, record);

    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: 'M', paths: ['docs/operator-guide.md'] }],
      planDocuments: [{ path: activePlanPath, markdown: planMarkdown }],
    });

    expect(result).toMatchObject({
      selected: true,
      reasonCode: 'plan-requirement',
      planRequirements: [
        {
          planId: 'distributed-validation-fixture',
          reason: 'The acceptance proof requires the supported remote matrix.',
        },
      ],
    });
  });

  it('treats no active adaptive plan as no explicit requirement', () => {
    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: 'M', paths: ['docs/operator-guide.md'] }],
      planDocuments: [],
    });

    expect(result.selected).toBe(false);
    expect(result.reasonCode).toBe('no-distributed-risk');
  });

  it.each([
    { required: false, reason: 'Attempted waiver.' },
    { required: true, reason: '' },
    { required: true, reason: 'Valid reason.', waiver: true },
  ])('fails closed for malformed plan requirement %#', (distributedValidation) => {
    const record = parseAdaptivePlanRecord(activePlanMarkdown);
    record.distributedValidation = distributedValidation;

    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: 'M', paths: ['docs/operator-guide.md'] }],
      planDocuments: [
        {
          path: activePlanPath,
          markdown: replaceAdaptivePlanRecord(activePlanMarkdown, record),
        },
      ],
    });

    expect(result).toMatchObject({
      selected: true,
      reasonCode: 'invalid-input',
      riskFamilies: [],
    });
    expect(result.reason).toContain('fail-closed');
  });

  it('keeps a fail-closed reason on one output-safe line', () => {
    const changedPath = 'docs/line\nbreak.md';
    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [
        { status: 'M', paths: [changedPath] },
        { status: 'D', paths: [changedPath] },
      ],
      planDocuments: [],
    });

    expect(result.reasonCode).toBe('invalid-input');
    expect(result.reason).not.toMatch(/[\r\n]/u);
  });

  it('fails closed for ambiguous active plan records', () => {
    const secondRecord = parseAdaptivePlanRecord(activePlanMarkdown);
    secondRecord.planId = 'second-active-plan';
    const secondPlan = replaceAdaptivePlanRecord(activePlanMarkdown, secondRecord);

    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords: [{ status: 'M', paths: ['docs/operator-guide.md'] }],
      planDocuments: [
        { path: activePlanPath, markdown: activePlanMarkdown },
        { path: 'plans/second-active-plan.md', markdown: secondPlan },
      ],
    });

    expect(result).toMatchObject({ selected: true, reasonCode: 'invalid-input' });
    expect(result.reason).toContain('multiple active adaptive plans');
  });

  it.each([
    [{ status: 'R100', paths: ['old.ts'] }],
    [{ status: 'M', paths: ['../outside.ts'] }],
    [
      { status: 'M', paths: ['docs/duplicate.md'] },
      { status: 'D', paths: ['docs/duplicate.md'] },
    ],
  ])('fails closed for malformed or ambiguous changed paths %#', (changedPathRecords) => {
    const result = classifyDistributedValidationRisk({
      eventName: 'push',
      changedPathRecords,
      planDocuments: [],
    });

    expect(result).toMatchObject({ selected: true, reasonCode: 'invalid-input' });
    expect(result.reason).toContain('fail-closed');
  });

  it('manual dispatch is an operator override even with malformed other inputs', () => {
    const result = classifyDistributedValidationRisk({
      eventName: 'workflow_dispatch',
      changedPathRecords: [{ status: 'R100', paths: ['old.ts'] }],
      planDocuments: [{ path: 'plans/broken.md', markdown: '```plan-adaptation-v1\n{' }],
    });

    expect(result).toEqual({
      selected: true,
      reasonCode: 'manual-override',
      reason: 'Distributed validation selected: workflow_dispatch operator override.',
      riskFamilies: [],
      riskPaths: [],
      planRequirements: [],
    });
  });
});

describe('adaptive plan distributed validation requirement', () => {
  it('accepts an optional exact positive requirement', () => {
    const withoutRequirement = parseAdaptivePlanRecord(activePlanMarkdown);
    const withRequirement = parseAdaptivePlanRecord(activePlanMarkdown);
    withRequirement.distributedValidation = {
      required: true,
      reason: 'The acceptance proof requires the supported remote matrix.',
    };

    expect(validateAdaptivePlanRecord(withoutRequirement)).toEqual([]);
    expect(validateAdaptivePlanRecord(withRequirement)).toEqual([]);
  });

  it.each([
    {
      value: { required: false, reason: 'Attempted waiver.' },
      issue: 'record.distributedValidation.required must be true when present',
    },
    {
      value: { required: true, reason: '' },
      issue: 'record.distributedValidation.reason must be a non-empty string',
    },
    {
      value: { required: true, reason: 'Valid.', waiver: true },
      issue: 'record.distributedValidation contains unsupported fields: waiver',
    },
  ])('rejects malformed requirement $value', ({ value, issue }) => {
    const record = parseAdaptivePlanRecord(activePlanMarkdown);
    record.distributedValidation = value;

    expect(validateAdaptivePlanRecord(record)).toContain(issue);
  });
});

describe('Git changed-path record decoding', () => {
  it('decodes ordinary and rename records without dropping either endpoint', () => {
    expect(
      decodeGitChangedPathRecords(
        'M\0docs/readme.md\0R100\0packages/shared/rtc/old.ts\0packages/shared/rtc/new.ts\0',
      ),
    ).toEqual({
      records: [
        { status: 'M', paths: ['docs/readme.md'] },
        {
          status: 'R100',
          paths: ['packages/shared/rtc/old.ts', 'packages/shared/rtc/new.ts'],
        },
      ],
      issues: [],
    });
  });

  it('returns a fail-closed issue instead of guessing a truncated rename', () => {
    expect(decodeGitChangedPathRecords('R100\0packages/shared/rtc/old.ts\0')).toEqual({
      records: [],
      issues: ['changed-path record R100 must contain exactly two paths'],
    });
  });

  it.each(['C0', 'C00', 'C000', 'R100'])('accepts similarity boundary %s', (status) => {
    expect(decodeGitChangedPathRecords(`${status}\0old.ts\0new.ts\0`)).toEqual({
      records: [{ status, paths: ['old.ts', 'new.ts'] }],
      issues: [],
    });
  });

  it('rejects a similarity score greater than 100', () => {
    expect(decodeGitChangedPathRecords('C101\0old.ts\0new.ts\0')).toEqual({
      records: [],
      issues: ['changed-path record has unsupported status: C101'],
    });
  });
});

function createActivePlanMarkdown(): string {
  const record = {
    version: 1,
    planId: 'distributed-validation-fixture',
    status: 'active',
    goal: 'Prove distributed validation plan selection.',
    acceptanceCriteria: ['Distributed validation remains explicit and fail-closed.'],
    capabilities: [
      {
        owner: 'distributed validation fixture',
        root: 'scripts/distributed-validation-fixture',
        entry: 'scripts/distributed-validation-fixture.mjs',
        testRoot: 'packages/tests/repo/distributed-validation-fixture',
        focusedCommand: 'npm run test:distributed-validation-fixture',
        navigationMap: null,
        factContracts: [],
        controlFlowFamilies: ['fixture selection'],
      },
    ],
    architecture: {
      currentHypothesis: 'Distributed validation selection needs an explicit fixture.',
      intendedHypothesis: 'A permanent fixture owns plan-selection tests.',
      freshInitialReview: { status: 'complete', reviewer: 'fixture', verdict: 'pass' },
    },
    completedSlicesSinceCheckpoint: [],
    facts: {
      diffBase: 'HEAD',
      affectedCodeDigest: null,
      computedTriggers: ['written-plan'],
      undeclaredChangedPaths: [],
    },
    checkpoint: {
      outcome: 'The fixture is active.',
      learning: 'The fixture must not depend on a tactical plan file.',
      structure: 'The test owns its canonical plan record.',
      decision: 'continue',
      nextSlices: [],
    },
    structuralDispositions: [],
    freshStructuralReview: null,
    coldNavigationEvidence: null,
    materialDecisions: [],
  };
  return `# Distributed validation fixture\n\n\`\`\`plan-adaptation-v1\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}
