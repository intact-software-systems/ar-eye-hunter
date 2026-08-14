const trustedWorkflowPath = '.github/workflows/deploy.yml';
const trustedJobName = 'Classify authenticated governance decision';
const trustedStepNames = [
  'Verify an exact decision-only commit',
  'Resolve fail-closed governance classification',
  'Record authenticated governance admission',
];
const gitObjectIdPattern = /^[0-9a-f]{40}$/u;
const decisionIdPattern = /^[0-9a-f]{64}$/u;

export function verifyGovernanceDecisionAdmission(admissionInput) {
  if (
    !gitObjectIdPattern.test(admissionInput.commitOid ?? '') ||
    !decisionIdPattern.test(admissionInput.decisionId ?? '') ||
    !Array.isArray(admissionInput.evidence?.workflowRuns)
  ) {
    throw new Error('governance decision admission evidence is malformed');
  }
  const matchingRuns = admissionInput.evidence.workflowRuns.filter(({ run }) =>
    isMatchingRun(run, admissionInput.commitOid),
  );
  if (matchingRuns.length !== 1) {
    throw new Error('decision commit has no unambiguous authenticated main-push admission');
  }
  const [{ run, jobs }] = matchingRuns;
  const matchingJobs = Array.isArray(jobs)
    ? jobs.filter((job) => isSuccessfulAdmissionJob(job, run, admissionInput.commitOid))
    : [];
  if (matchingJobs.length !== 1) {
    throw new Error('decision commit has no unambiguous authenticated main-push admission');
  }
  return {
    commitOid: admissionInput.commitOid,
    decisionId: admissionInput.decisionId,
    workflowRunId: run.id,
    runAttempt: run.run_attempt,
  };
}

function isMatchingRun(run, commitOid) {
  return (
    Number.isSafeInteger(run?.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    run.event === 'push' &&
    run.head_sha === commitOid &&
    run.head_branch === 'main' &&
    run.path === trustedWorkflowPath &&
    ['in_progress', 'completed'].includes(run.status) &&
    (run.status !== 'completed' || run.conclusion === 'success')
  );
}

function isSuccessfulAdmissionJob(job, run, commitOid) {
  if (
    !Number.isSafeInteger(job?.id) ||
    job.id <= 0 ||
    job.name !== trustedJobName ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== commitOid ||
    !Array.isArray(job.steps)
  ) {
    return false;
  }
  return trustedStepNames.every((stepName) => {
    const matchingSteps = job.steps.filter((step) => step.name === stepName);
    return (
      matchingSteps.length === 1 &&
      matchingSteps[0].status === 'completed' &&
      matchingSteps[0].conclusion === 'success'
    );
  });
}
