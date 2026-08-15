import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readWorkflowRunsEnvelope } from './validation-evidence-selection.mjs';

export function readGithubWorkflowRuns({ repository, workflowPath, branch }) {
  const workflowName = path.posix.basename(workflowPath);
  const endpoint =
    `/repos/${repository}/actions/workflows/${workflowName}/runs` +
    `?branch=${encodeURIComponent(branch)}&event=pull_request&status=success&per_page=100`;
  const source = execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return readWorkflowRunsEnvelope(source);
}

export function readGithubValidationEvidenceArtifact({ repository, runId }) {
  const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'validation-evidence-download-'));
  try {
    execFileSync(
      'gh',
      [
        'run',
        'download',
        String(runId),
        '--repo',
        repository,
        '--name',
        'validation-evidence-v2',
        '--dir',
        artifactDirectory,
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(path.join(artifactDirectory, 'validation-evidence-v2.json'), 'utf8');
  } catch {
    return undefined;
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}
