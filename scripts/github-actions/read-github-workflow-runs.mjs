import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { commandOutputMaxBuffer } from '../validation-evidence/command-output-max-buffer.mjs';

const githubPageSize = 100;

export function readGithubRepository() {
    const source = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' });
    return JSON.parse(source).nameWithOwner;
}

/** Without a limit every page is read; a limit of at most one page reads the newest runs only. */
export function readGithubWorkflowRuns(filter) {
    const endpoint = toGithubWorkflowRunsEndpoint(filter);
    const pages = filter.limit === undefined ? ['--paginate', '--slurp'] : [];
    return readWorkflowRunsEnvelope(readGithubApi([...pages, endpoint]));
}

export function toGithubWorkflowRunsEndpoint({ repository, workflowPath, branch, event, status, limit }) {
    const workflowName = path.posix.basename(workflowPath);
    const query = [
        ['branch', branch],
        ['event', event],
        ['status', status],
        ['per_page', limit ?? githubPageSize]
    ].filter(([, value]) => value !== undefined);
    const search = query.map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&');
    return `/repos/${repository}/actions/workflows/${workflowName}/runs?${search}`;
}

export function readWorkflowRunsEnvelope(source) {
    return readGithubListPages(source, { response: 'workflow runs', listKey: 'workflow_runs' });
}

/** The jobs of a run's latest attempt. */
export function readGithubWorkflowRunJobs({ repository, runId }) {
    const endpoint = `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=${githubPageSize}`;
    return toGithubWorkflowRunJobs(readGithubApi(['--paginate', '--slurp', endpoint]));
}

export function toGithubWorkflowRunJobs(source) {
    return readGithubListPages(source, { response: 'workflow run jobs', listKey: 'jobs' })
        .map(({ name, status, conclusion }) => ({ name, status, conclusion }));
}

export function readGithubWorkflowRunArtifactNames({ repository, runId }) {
    const endpoint = `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=${githubPageSize}`;
    return toGithubArtifactNames(readGithubApi(['--paginate', '--slurp', endpoint]));
}

export function toGithubArtifactNames(source) {
    return readGithubListPages(source, { response: 'workflow run artifacts', listKey: 'artifacts' })
        .filter((artifact) => !artifact.expired)
        .map((artifact) => artifact.name);
}

/**
 * Downloads one named artifact of a run into a temporary directory, hands that directory to `readDirectory`, and
 * removes it afterwards. Returns undefined when the run has no such artifact or it cannot be downloaded.
 */
export function readGithubArtifactDirectory({ repository, runId, artifactName, readDirectory }) {
    const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'github-artifact-download-'));
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
                artifactName,
                '--dir',
                artifactDirectory
            ],
            { stdio: 'ignore' }
        );
    }
    catch {
        rmSync(artifactDirectory, { recursive: true, force: true });
        return undefined;
    }
    try {
        return readDirectory(artifactDirectory);
    }
    finally {
        rmSync(artifactDirectory, { recursive: true, force: true });
    }
}

function readGithubApi(arguments_) {
    return execFileSync('gh', ['api', ...arguments_], { encoding: 'utf8', maxBuffer: commandOutputMaxBuffer });
}

function readGithubListPages(source, { response, listKey }) {
    let envelope;
    try {
        envelope = JSON.parse(source);
    }
    catch {
        throw new Error(`${response} response must contain JSON`);
    }
    const pages = Array.isArray(envelope) ? envelope : [envelope];
    if (pages.length === 0 || pages.some((page) => !isRecord(page) || !Array.isArray(page[listKey]))) {
        throw new Error(`${response} response must contain ${listKey} pages`);
    }
    return pages.flatMap((page) => page[listKey]);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
