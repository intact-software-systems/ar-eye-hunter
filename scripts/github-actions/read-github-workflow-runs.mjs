// @ts-check
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { commandOutputMaxBuffer } from '../command-output-max-buffer.mjs';

/**
 * The fields of a GitHub workflow run that typed callers read; the reader returns the API's whole object.
 * @typedef {object} GithubWorkflowRun
 * @property {number} id
 * @property {number} run_number
 * @property {number} run_attempt
 * @property {string} head_sha
 * @property {string} event
 * @property {string} status
 * @property {string | null} conclusion Null while the run is in progress.
 */

/**
 * @typedef {object} GithubWorkflowRunsFilter
 * @property {string} repository
 * @property {string} workflowPath
 * @property {string} [branch]
 * @property {string} [event]
 * @property {string} [status]
 * @property {number} [limit] At most one page: the newest runs only.
 */

/**
 * @typedef {object} GithubWorkflowRunJob
 * @property {string} name
 * @property {string} status
 * @property {string | null} conclusion Null while the job runs.
 */

/**
 * An artifact as GitHub lists it; an expired one can no longer be downloaded.
 * @typedef {object} GithubArtifact
 * @property {string} name
 * @property {boolean} expired
 */

/**
 * @typedef {object} GithubWorkflowRunIdentity
 * @property {string} repository
 * @property {number} runId
 */

const githubPageSize = 100;

/** @returns {string} */
export function readGithubRepository() {
    const source = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' });
    return JSON.parse(source).nameWithOwner;
}

/**
 * Without a limit every page is read; a limit of at most one page reads the newest runs only.
 * @param {GithubWorkflowRunsFilter} filter
 * @returns {readonly GithubWorkflowRun[]}
 */
export function readGithubWorkflowRuns(filter) {
    const endpoint = toGithubWorkflowRunsEndpoint(filter);
    const pages = filter.limit === undefined ? ['--paginate', '--slurp'] : [];
    return readWorkflowRunsEnvelope(readGithubApi([...pages, endpoint]));
}

/**
 * @param {GithubWorkflowRunsFilter} filter
 * @returns {string}
 */
export function toGithubWorkflowRunsEndpoint({ repository, workflowPath, branch, event, status, limit }) {
    const workflowName = path.posix.basename(workflowPath);
    /** @type {readonly (readonly [string, string | number | undefined])[]} */
    const query = [
        ['branch', branch],
        ['event', event],
        ['status', status],
        ['per_page', limit ?? githubPageSize]
    ];
    const search = query.filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
        .join('&');
    return `/repos/${repository}/actions/workflows/${workflowName}/runs?${search}`;
}

/**
 * @param {string} source
 * @returns {readonly GithubWorkflowRun[]}
 */
export function readWorkflowRunsEnvelope(source) {
    return readGithubListPages(source, { response: 'workflow runs', listKey: 'workflow_runs' });
}

/**
 * The jobs of a run's latest attempt.
 * @param {GithubWorkflowRunIdentity} run
 * @returns {readonly GithubWorkflowRunJob[]}
 */
export function readGithubWorkflowRunJobs({ repository, runId }) {
    const endpoint = `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=${githubPageSize}`;
    return toGithubWorkflowRunJobs(readGithubApi(['--paginate', '--slurp', endpoint]));
}

/**
 * @param {string} source
 * @returns {readonly GithubWorkflowRunJob[]}
 */
export function toGithubWorkflowRunJobs(source) {
    return readGithubListPages(source, { response: 'workflow run jobs', listKey: 'jobs' })
        .map(({ name, status, conclusion }) => ({ name, status, conclusion }));
}

/**
 * @param {GithubWorkflowRunIdentity} run
 * @returns {readonly GithubArtifact[]}
 */
export function readGithubWorkflowRunArtifacts({ repository, runId }) {
    const endpoint = `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=${githubPageSize}`;
    return toGithubArtifacts(readGithubApi(['--paginate', '--slurp', endpoint]));
}

/**
 * @param {string} source
 * @returns {readonly GithubArtifact[]}
 */
export function toGithubArtifacts(source) {
    return readGithubListPages(source, { response: 'workflow run artifacts', listKey: 'artifacts' })
        .map(({ name, expired }) => ({ name, expired }));
}

/**
 * Downloads one named artifact of a run into a temporary directory, hands that directory to `readDirectory`, and
 * removes it afterwards. Returns undefined when the run has no such artifact or it cannot be downloaded.
 * @template T
 * @param {GithubWorkflowRunIdentity & {
 *     artifactName: string,
 *     readDirectory: (artifactDirectory: string) => T
 * }} input
 * @returns {T | undefined}
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

/**
 * @param {readonly string[]} arguments_
 * @returns {string}
 */
function readGithubApi(arguments_) {
    return execFileSync('gh', ['api', ...arguments_], { encoding: 'utf8', maxBuffer: commandOutputMaxBuffer });
}

/**
 * The entries of every page's list; the pages are GitHub's JSON, trusted for the fields their callers name.
 * @param {string} source
 * @param {{ response: string, listKey: string }} list
 * @returns {any[]}
 */
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

/**
 * @param {any} value
 * @returns {boolean}
 */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
