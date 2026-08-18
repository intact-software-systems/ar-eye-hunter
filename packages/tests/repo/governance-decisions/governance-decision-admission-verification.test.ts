import { describe, expect, it } from 'vitest';

import { verifyGovernanceDecisionAdmission } from '../../../../scripts/governance-decisions/governance-decision-admission-verification.mjs';

const commitOid = '1'.repeat(40);
const decisionId = '2'.repeat(64);

describe('governance decision authenticated admission', () => {
  it('binds one successful trusted main-push classifier attempt to the exact decision commit', () => {
    expect(
      verifyGovernanceDecisionAdmission({
        commitOid,
        decisionId,
        evidence: successfulAdmissionEvidence(),
      }),
    ).toEqual({ commitOid, decisionId, workflowRunId: 701, runAttempt: 2 });
  });

  it('rejects a masked verify conclusion when fail-closed resolution skips admission', () => {
    const evidence = successfulAdmissionEvidence();
    const admissionMarker = evidence.workflowRuns[0].jobs[0].steps.find(
      (step) => step.name === 'Record authenticated governance admission',
    );
    if (!admissionMarker) {
      throw new Error('Fixture is missing the admission marker step.');
    }
    admissionMarker.status = 'completed';
    admissionMarker.conclusion = 'skipped';

    expect(() => verifyGovernanceDecisionAdmission({ commitOid, decisionId, evidence })).toThrow(
      'no unambiguous authenticated main-push admission',
    );
  });

  it.each([
    ['pull request event', { event: 'pull_request' }],
    ['feature branch', { head_branch: 'feature' }],
    ['different commit', { head_sha: '3'.repeat(40) }],
    ['different workflow', { path: '.github/workflows/release-gate.yml' }],
    ['queued run', { status: 'queued' }],
    ['failed completed run', { status: 'completed', conclusion: 'failure' }],
  ])('rejects a %s run', (_name, runChange) => {
    const evidence = successfulAdmissionEvidence();
    evidence.workflowRuns[0].run = { ...evidence.workflowRuns[0].run, ...runChange };

    expect(() => verifyGovernanceDecisionAdmission({ commitOid, decisionId, evidence })).toThrow(
      'no unambiguous authenticated main-push admission',
    );
  });

  it.each([
    ['different run', { run_id: 999 }],
    ['different attempt', { run_attempt: 3 }],
    ['different commit', { head_sha: '3'.repeat(40) }],
    ['failed classifier', { conclusion: 'failure' }],
  ])('rejects a classifier job from a %s', (_name, jobChange) => {
    const evidence = successfulAdmissionEvidence();
    evidence.workflowRuns[0].jobs[0] = {
      ...evidence.workflowRuns[0].jobs[0],
      ...jobChange,
    };

    expect(() => verifyGovernanceDecisionAdmission({ commitOid, decisionId, evidence })).toThrow(
      'no unambiguous authenticated main-push admission',
    );
  });

  it.each([
    'Verify an exact decision-only commit',
    'Resolve fail-closed governance classification',
  ])('rejects a missing, failed, or duplicate %s step', (stepName) => {
    const duplicatedStep = successfulAdmissionEvidence().workflowRuns[0].jobs[0].steps.find(
      (step) => step.name === stepName,
    );
    if (!duplicatedStep) {
      throw new Error(`Fixture is missing the ${stepName} step.`);
    }

    for (const steps of [
      successfulAdmissionEvidence().workflowRuns[0].jobs[0].steps.filter(
        (step) => step.name !== stepName,
      ),
      successfulAdmissionEvidence().workflowRuns[0].jobs[0].steps.map((step) =>
        step.name === stepName ? { ...step, conclusion: 'failure' } : step,
      ),
      [...successfulAdmissionEvidence().workflowRuns[0].jobs[0].steps, duplicatedStep],
    ]) {
      const evidence = successfulAdmissionEvidence();
      evidence.workflowRuns[0].jobs[0].steps = steps;
      expect(() => verifyGovernanceDecisionAdmission({ commitOid, decisionId, evidence })).toThrow(
        'no unambiguous authenticated main-push admission',
      );
    }
  });

  it('fails closed when two workflow runs or two classifier jobs claim admission', () => {
    const duplicateRun = successfulAdmissionEvidence();
    duplicateRun.workflowRuns.push(structuredClone(duplicateRun.workflowRuns[0]));
    expect(() =>
      verifyGovernanceDecisionAdmission({ commitOid, decisionId, evidence: duplicateRun }),
    ).toThrow('no unambiguous authenticated main-push admission');

    const duplicateJob = successfulAdmissionEvidence();
    duplicateJob.workflowRuns[0].jobs.push(structuredClone(duplicateJob.workflowRuns[0].jobs[0]));
    expect(() =>
      verifyGovernanceDecisionAdmission({ commitOid, decisionId, evidence: duplicateJob }),
    ).toThrow('no unambiguous authenticated main-push admission');
  });
});

interface AdmissionJobStep {
  name: string;
  status: string;
  conclusion: string | null;
}

interface AdmissionClassifierJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  steps: AdmissionJobStep[];
}

interface AdmissionWorkflowRun {
  id: number;
  run_attempt: number;
  event: string;
  head_sha: string;
  head_branch: string;
  path: string;
  status: string;
  conclusion: string | null;
}

interface AdmissionEvidence {
  workflowRuns: { run: AdmissionWorkflowRun; jobs: AdmissionClassifierJob[] }[];
}

function successfulAdmissionEvidence(): AdmissionEvidence {
  return {
    workflowRuns: [
      {
        run: {
          id: 701,
          run_attempt: 2,
          event: 'push',
          head_sha: commitOid,
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
          status: 'in_progress',
          conclusion: null,
        },
        jobs: [
          {
            id: 702,
            name: 'Classify authenticated governance decision',
            status: 'completed',
            conclusion: 'success',
            run_id: 701,
            run_attempt: 2,
            head_sha: commitOid,
            steps: [
              {
                name: 'Verify an exact decision-only commit',
                status: 'completed',
                conclusion: 'success',
              },
              {
                name: 'Resolve fail-closed governance classification',
                status: 'completed',
                conclusion: 'success',
              },
              {
                name: 'Record authenticated governance admission',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          },
        ],
      },
    ],
  };
}
