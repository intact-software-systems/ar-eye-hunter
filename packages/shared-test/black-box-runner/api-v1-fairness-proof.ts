import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FAIRNESS_OVERDUE_THRESHOLD_MS = 30_000;
const MAX_PROOF_BYTES = 16 * 1024;

type Fixture = Readonly<{
    resourceId: string;
    commandType: string;
    injectedDueAt: string;
    claimedAt: string;
    dueAgeAtClaimMs: number;
    afterAttempts: number;
}>;

type Timing = Readonly<{
    logPath: string;
    lineNumber: number;
    component: string;
    operation: string;
    serviceId?: string;
    atEpochMs: number;
    status?: string;
    details: Readonly<{
        resourceId: string;
        type: string;
        attempt: number;
        selectedLane: string;
        dueAgeMs: number;
    }>;
}>;

export type ApiV1FairnessProof = Readonly<{
    schemaVersion: 1;
    recipeId: string;
    resourceId: string;
    commandType: string;
    selectedLane: 'FAIRNESS';
    injectedDueAt: string;
    claimedAt: string;
    selectedEventAtEpochMs: number;
    dueAgeMs: number;
    attempt: number;
    overdueThresholdMs: number;
    noBeforeNextTs: true;
    source: Readonly<{
        logPath: string;
        lineNumber: number;
        component: string;
        operation: string;
        serviceId?: string;
    }>;
}>;

export async function verifyApiV1FairnessProof(
    artifactDir: string,
    serverLogPaths: readonly string[],
): Promise<readonly ApiV1FairnessProof[]> {
    const reports = await readEvidenceReports(artifactDir);
    const fixtures = reports.flatMap(({ recipeId, reportPath, report }) => {
        const fixture = report?.outputs?.stateWriteEvidence?.overdueRecoveryFixture;
        return fixture ? [{ recipeId, reportPath, report, fixture: fixture as Fixture }] : [];
    });
    if (fixtures.length === 0) return [];
    const timings = (await Promise.all(serverLogPaths.map(readTimings))).flat();
    const proofs: ApiV1FairnessProof[] = [];

    for (const item of fixtures) {
        const timing = timings.find((candidate) => matchesFixture(candidate, item.fixture));
        if (!timing) {
            throw new Error(
                `No timing found for ${item.fixture.resourceId} with controller-selected FAIRNESS lane.`,
            );
        }
        const proof = toProof(item.recipeId, item.fixture, timing, artifactDir);
        proofs.push(proof);
        item.report.outputs.stateWriteEvidence.overdueRecoveryFixture = {
            ...item.fixture,
            selectedLane: proof.selectedLane,
            selectedLaneSource: 'app-inbox-phase-timing',
            fairnessProofArtifact: 'fairness-proof.json',
        };
        await writeFile(item.reportPath, `${JSON.stringify(item.report, null, 2)}\n`);
    }

    const output = `${JSON.stringify({ schemaVersion: 1, proofs }, null, 2)}\n`;
    if (Buffer.byteLength(output) > MAX_PROOF_BYTES) {
        throw new Error(`Fairness proof exceeds ${MAX_PROOF_BYTES} bytes.`);
    }
    await writeFile(path.join(artifactDir, 'fairness-proof.json'), output);
    return proofs;
}

async function readEvidenceReports(artifactDir: string): Promise<Array<{
    recipeId: string;
    reportPath: string;
    report: any;
}>> {
    const summaries = [
        path.join(artifactDir, 'matrix-summary.json'),
        path.join(artifactDir, 'cluster', 'matrix-summary.json'),
    ];
    const reports = [];
    for (const summaryPath of summaries) {
        const summary = await readJsonIfPresent(summaryPath);
        for (const run of Array.isArray(summary?.runs) ? summary.runs : []) {
            if (run?.status !== 'PASSED' || typeof run?.artifactDir !== 'string') continue;
            const reportPath = path.join(run.artifactDir, 'report.json');
            const report = await readJsonIfPresent(reportPath);
            if (report) reports.push({ recipeId: String(run.id), reportPath, report });
        }
    }
    return reports;
}

async function readJsonIfPresent(filePath: string): Promise<any | undefined> {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function readTimings(logPath: string): Promise<Timing[]> {
    const lines = (await readFile(logPath, 'utf8')).split('\n');
    const timings: Timing[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim();
        if (!line?.startsWith('{')) continue;
        try {
            const event = JSON.parse(line);
            if (
                event?.component === 'app-inbox-phase' &&
                event?.operation === 'transaction' &&
                event?.details?.selectedLane === 'FAIRNESS'
            ) {
                timings.push({ ...event, logPath, lineNumber: index + 1 });
            }
        } catch {
            // Server logs may contain non-JSON diagnostic lines.
        }
    }
    return timings;
}

function matchesFixture(timing: Timing, fixture: Fixture): boolean {
    const dueAtEpochMs = Date.parse(fixture.injectedDueAt);
    const claimedAtEpochMs = Date.parse(fixture.claimedAt);
    return timing.details.resourceId === fixture.resourceId &&
        timing.details.type === fixture.commandType &&
        timing.details.attempt === fixture.afterAttempts &&
        timing.details.dueAgeMs >= FAIRNESS_OVERDUE_THRESHOLD_MS &&
        Math.abs(timing.details.dueAgeMs - fixture.dueAgeAtClaimMs) <= 5_000 &&
        claimedAtEpochMs >= dueAtEpochMs &&
        timing.atEpochMs >= claimedAtEpochMs;
}

function toProof(
    recipeId: string,
    fixture: Fixture,
    timing: Timing,
    artifactDir: string,
): ApiV1FairnessProof {
    return {
        schemaVersion: 1,
        recipeId,
        resourceId: fixture.resourceId,
        commandType: fixture.commandType,
        selectedLane: 'FAIRNESS',
        injectedDueAt: fixture.injectedDueAt,
        claimedAt: fixture.claimedAt,
        selectedEventAtEpochMs: timing.atEpochMs,
        dueAgeMs: timing.details.dueAgeMs,
        attempt: timing.details.attempt,
        overdueThresholdMs: FAIRNESS_OVERDUE_THRESHOLD_MS,
        noBeforeNextTs: true,
        source: {
            logPath: path.relative(artifactDir, timing.logPath),
            lineNumber: timing.lineNumber,
            component: timing.component,
            operation: timing.operation,
            ...(timing.serviceId ? { serviceId: timing.serviceId } : {}),
        },
    };
}
