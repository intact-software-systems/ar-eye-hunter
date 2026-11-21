import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    readGithubArtifactDirectory,
    readGithubRepository,
    readGithubWorkflowRunArtifactNames,
    readGithubWorkflowRunJobs,
    readGithubWorkflowRuns,
    type GithubWorkflowRun
} from '../../../../../../scripts/github-actions/read-github-workflow-runs.mjs';
import { computeAlmLaneLedger } from './compute-alm-lane-ledger.ts';
import { decodeAlmLaneFlakeCauses } from './decode-alm-lane-flake-causes.ts';
import { decodeAlmLaneLedgerArguments, type AlmLaneLedgerArguments } from './decode-alm-lane-ledger-arguments.ts';
import { toAlmLaneLedgerText } from './to-alm-lane-ledger-text.ts';
import {
    resolveAlmLaneResultArtifactNames,
    toAlmLaneObservedRuns,
    type AlmLaneObservedRunsReading,
    type AlmLaneResultFile
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
            writeFailure(toError(error).message);
        }
    }
);

function readAlmLaneLedgerText(arguments_: AlmLaneLedgerArguments): string {
    const repository = arguments_.repository ?? readGithubRepository();
    const workflowRuns = readGithubWorkflowRuns({ repository, workflowPath: WORKFLOW_PATH, limit: arguments_.limit });
    const readings = workflowRuns.map((run) => readObservedRuns(repository, run));
    const causes = decodeAlmLaneFlakeCauses(JSON.parse(readFileSync(CAUSES_PATH, 'utf8')));
    const ledger = computeAlmLaneLedger({
        runs: readings.flatMap((reading) => reading.runs),
        causes: causes.fold(() => [], (decoded) => decoded)
    });
    return toAlmLaneLedgerText({
        ledger,
        commitShas: workflowRuns.map((run) => run.head_sha),
        issues: [
            ...causes.fold((issues) => issues.map((issue) => `${CAUSES_PATH}: ${issue}`), () => []),
            ...readings.flatMap((reading) => reading.issues)
        ]
    });
}

function readObservedRuns(repository: string, run: GithubWorkflowRun): AlmLaneObservedRunsReading {
    const runId = run.id;
    const artifactNames = resolveAlmLaneResultArtifactNames(readGithubWorkflowRunArtifactNames({ repository, runId }));
    return toAlmLaneObservedRuns({
        runId,
        commitSha: run.head_sha,
        event: run.event,
        attempt: run.run_attempt,
        jobs: readGithubWorkflowRunJobs({ repository, runId }),
        artifacts: artifactNames.map((artifactName) => ({
            name: artifactName,
            files: readGithubArtifactDirectory({ repository, runId, artifactName, readDirectory: readResultFiles }) ??
                null
        }))
    });
}

function readResultFiles(artifactDirectory: string): readonly AlmLaneResultFile[] {
    return readdirSync(artifactDirectory, { recursive: true, encoding: 'utf8' })
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => ({ fileName, text: readFileSync(path.join(artifactDirectory, fileName), 'utf8') }));
}

function writeFailure(message: string): void {
    console.error(`FAIL: alm lane ledger: ${message}`);
    process.exitCode = 1;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
