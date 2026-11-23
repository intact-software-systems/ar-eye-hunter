import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    readGithubArtifactDirectory,
    readGithubRepository,
    readGithubWorkflowRunArtifacts,
    readGithubWorkflowRunJobs,
    readGithubWorkflowRuns,
    type GithubWorkflowRun
} from '../../../../../../scripts/github-actions/read-github-workflow-runs.mjs';
import { computeAlmLaneLedger } from './compute-alm-lane-ledger.ts';
import { computeAlmLaneWorkflowRuns } from './compute-alm-lane-workflow-runs.ts';
import { decodeAlmLaneFlakeCausesText } from './decode-alm-lane-flake-causes.ts';
import { decodeAlmLaneLedgerArguments, type AlmLaneLedgerArguments } from './decode-alm-lane-ledger-arguments.ts';
import type { AlmLaneResultFile } from './decode-alm-lane-result-file.ts';
import { toAlmLaneLedgerText } from './to-alm-lane-ledger-text.ts';
import {
    resolveAlmLaneResultArtifacts,
    toAlmLaneObservedRuns,
    type AlmLaneObservedRunsReading
} from './to-alm-lane-observed-runs.ts';

const WORKFLOW_PATH = '.github/workflows/alm-conformance-observation.yml';

const CAUSES_PATH = path.join(import.meta.dir, 'alm-lane-flake-causes.json');

decodeAlmLaneLedgerArguments(process.argv.slice(2)).fold(
    (issues) => writeFailure(issues.join(' ')),
    (arguments_) => {
        try {
            process.stdout.write(readAlmLaneLedgerText(arguments_));
        }
        catch (error) {
            writeFailure(error instanceof Error ? error.message : String(error));
        }
    }
);

function readAlmLaneLedgerText(arguments_: AlmLaneLedgerArguments): string {
    const repository = arguments_.repository ?? readGithubRepository();
    const filter = { repository, workflowPath: WORKFLOW_PATH, limit: arguments_.limit };
    const workflowRuns = computeAlmLaneWorkflowRuns({
        push: readGithubWorkflowRuns({ ...filter, branch: 'main', event: 'push' }),
        pullRequest: readGithubWorkflowRuns({ ...filter, event: 'pull_request' }),
        dispatch: readGithubWorkflowRuns({ ...filter, event: 'workflow_dispatch' })
    });
    const readings = workflowRuns.runsToRead.map((run) => readObservedRuns(repository, run));
    const causes = decodeAlmLaneFlakeCausesText(readCausesText());
    const ledger = computeAlmLaneLedger({
        runs: readings.flatMap((reading) => reading.runs),
        causes: causes.fold(() => [], (decoded) => decoded)
    });
    return toAlmLaneLedgerText({
        ledger,
        window: workflowRuns.window,
        issues: [
            ...causes.fold((issues) => issues.map((issue) => `${CAUSES_PATH}: ${issue}`), () => []),
            ...readings.flatMap((reading) => reading.issues)
        ]
    });
}

function readObservedRuns(repository: string, run: GithubWorkflowRun): AlmLaneObservedRunsReading {
    const runId = run.id;
    const artifacts = resolveAlmLaneResultArtifacts(readGithubWorkflowRunArtifacts({ repository, runId }));
    return toAlmLaneObservedRuns({
        runId,
        commitSha: run.head_sha,
        event: run.event,
        attempt: run.run_attempt,
        status: run.status,
        conclusion: run.conclusion,
        jobs: readGithubWorkflowRunJobs({ repository, runId }),
        artifacts: artifacts.map((artifact) => ({
            ...artifact,
            files: artifact.expired
                ? null
                : readGithubArtifactDirectory({
                    repository,
                    runId,
                    artifactName: artifact.name,
                    readDirectory: readResultFiles
                }) ?? null
        }))
    });
}

function readResultFiles(artifactDirectory: string): readonly AlmLaneResultFile[] {
    return readdirSync(artifactDirectory, { recursive: true, encoding: 'utf8' })
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => ({ fileName, text: readFileSync(path.join(artifactDirectory, fileName), 'utf8') }));
}

/** Null when the file cannot be read; the ledger prints that as an issue. */
function readCausesText(): string | null {
    try {
        return readFileSync(CAUSES_PATH, 'utf8');
    }
    catch {
        return null;
    }
}

function writeFailure(message: string): void {
    console.error(`FAIL: alm lane ledger: ${message}`);
    process.exitCode = 1;
}
