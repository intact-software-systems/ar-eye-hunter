import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/hetzner-supported-distributed-manifests.yml',
);

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

interface WorkflowJob {
  readonly if?: string;
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly ['runs-on']?: string;
  readonly steps?: readonly WorkflowStep[];
  readonly strategy?: unknown;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowDocument {
  readonly on?: unknown;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

function readWorkflow(): WorkflowDocument {
  return load(readFileSync(workflowPath, 'utf8')) as WorkflowDocument;
}

describe('risk-scoped supported Hetzner workflow', () => {
  it('selects before every expensive job and retains manual dispatch', () => {
    const workflow = readWorkflow();

    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      workflow_dispatch: null,
    });
    expect(workflow.jobs.selection).toMatchObject({
      name: 'Select distributed validation',
      'runs-on': 'ubuntu-24.04',
      outputs: {
        selected: '${{ steps.selection.outputs.selected }}',
        reason_code: '${{ steps.selection.outputs.reason_code }}',
        reason: '${{ steps.selection.outputs.reason }}',
      },
    });
    expect(workflow.jobs.preflight).toMatchObject({
      needs: 'selection',
      if: "needs.selection.outputs.selected == 'true'",
    });
    expect(workflow.jobs.prepare).toMatchObject({
      needs: ['selection', 'preflight'],
      if: "needs.selection.outputs.selected == 'true' && needs.preflight.result == 'success'",
    });
    expect(workflow.jobs.run).toMatchObject({
      needs: ['selection', 'prepare'],
      if: "needs.selection.outputs.selected == 'true' && needs.prepare.result == 'success'",
    });
  });

  it('has one always-visible result that distinguishes no-risk skip from failures', () => {
    const workflow = readWorkflow();
    const result = workflow.jobs['distributed-validation-result'];

    expect(result).toMatchObject({
      name: 'Run Hetzner Supported Distributed Manifests result',
      needs: ['selection', 'preflight', 'prepare', 'run'],
      if: 'always()',
      'runs-on': 'ubuntu-24.04',
    });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: 'Conclude distributed validation',
        run: expect.stringContaining('node scripts/distributed-validation-risk.mjs conclude'),
      }),
    );
  });

  it('routes manual, no-risk, and selected pushes through the same required result truth', () => {
    const workflow = readWorkflow();
    const selectionRun = workflow.jobs.selection.steps?.find(
      (step) => step.name === 'Classify distributed validation risk',
    )?.run;
    const conclusionRun = workflow.jobs['distributed-validation-result'].steps?.find(
      (step) => step.name === 'Conclude distributed validation',
    )?.run;

    expect(selectionRun).toContain('--event-name "$EVENT_NAME"');
    expect(selectionRun).toContain('--base "$BASE"');
    expect(selectionRun).toContain('--head "$HEAD"');
    expect(conclusionRun).toContain('--selected "$SELECTED"');
    expect(conclusionRun).toContain('--selection-result "$SELECTION_RESULT"');
    expect(workflow.jobs['distributed-validation-result'].name).toBe(
      'Run Hetzner Supported Distributed Manifests result',
    );
  });

  it('keeps the supported matrix and reusable runner inputs unchanged', () => {
    const workflow = readWorkflow();

    expect(workflow.jobs.run.strategy).toEqual({
      'fail-fast': false,
      'max-parallel': 1,
      matrix: {
        include: [
          {
            manifest_id: '01-health-2-agent',
            manifest_path: 'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
          },
          {
            manifest_id: '02-composite-evidence-2-agent',
            manifest_path:
              'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
          },
          {
            manifest_id: '03-rtc-smoke-2-agent',
            manifest_path: 'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
          },
          {
            manifest_id: '04-provider-parity-2-agent',
            manifest_path:
              'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
          },
          {
            manifest_id: '05a-rtc-realtime-stability-2-agent-5s',
            manifest_path:
              'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json',
          },
        ],
      },
    });
    expect(workflow.jobs.prepare.uses).toBe(
      './.github/workflows/hetzner-distributed-recipe-runner.yml',
    );
    expect(workflow.jobs.run.uses).toBe(
      './.github/workflows/hetzner-distributed-recipe-runner.yml',
    );
    expect(workflow.jobs.prepare.with).toMatchObject({
      operator_phase: 'prepare',
      rollout_before_run: true,
      install_playwright: true,
      npm_ci: false,
      wait_for_agents: false,
      stop_after_run: false,
    });
    expect(workflow.jobs.run.with).toMatchObject({
      operator_phase: 'run',
      rollout_before_run: false,
      install_playwright: false,
      npm_ci: false,
      wait_for_agents: true,
      stop_after_run: true,
    });
  });
});
