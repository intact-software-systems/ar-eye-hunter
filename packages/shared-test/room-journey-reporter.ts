import type {
    FullConfig,
    FullProject,
    FullResult,
    Reporter,
    TestCase,
    TestResult,
    TestStep
} from '@playwright/test/reporter';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export namespace RoomJourneyReporter {
    export interface Config {
        readonly application: string;
        readonly environment: string;
        readonly sourceRevision: string | null;
    }

    export type Phase = 'entry' | 'recovery' | 'repeat-play';
    export type Status = 'passed' | 'failed' | 'skipped' | 'not-reached' | 'invalid';

    export interface Observation {
        readonly testId: string;
        readonly testTitle: string;
        readonly repeatEachIndex: number;
        readonly retry: number;
        readonly attemptStatus: TestResult['status'];
        readonly phase: Phase;
        readonly status: Status;
        readonly durationMs: number | null;
    }

    export interface Issue {
        readonly testId: string | null;
        readonly code:
            | 'invalid-declaration'
            | 'undeclared-phase'
            | 'missing-phase'
            | 'duplicate-phase'
            | 'invalid-duration';
    }
}

export class RoomJourneyReporter implements Reporter {
    private readonly config: RoomJourneyReporter.Config;
    private readonly observations: RoomJourneyReporter.Observation[] = [];
    private readonly issues: RoomJourneyReporter.Issue[] = [];
    private outputDirectory: string | undefined;
    private workers = 0;

    constructor(config: RoomJourneyReporter.Config) {
        this.config = config;
    }

    onBegin(
        config: Pick<FullConfig, 'workers'> & { readonly projects: readonly Pick<FullProject, 'outputDir'>[]; }
    ): void {
        const directories = new Set(config.projects.map((project) => project.outputDir));
        this.outputDirectory = directories.size === 1 ? directories.values().next().value : undefined;
        this.workers = config.workers;
    }

    onTestEnd(
        test: Pick<TestCase, 'id' | 'title' | 'repeatEachIndex'>,
        result: Pick<TestResult, 'annotations' | 'retry' | 'status' | 'steps'>
    ): void {
        const declarations = result.annotations.filter((annotation) => annotation.type === 'room-journey');
        const phases = declarations.map((annotation) => annotation.description).filter(isJourneyPhase);
        if (phases.length !== declarations.length || new Set(phases).size !== phases.length) {
            this.issues.push({ testId: test.id, code: 'invalid-declaration' });
            return;
        }
        const steps = toJourneySteps(result.steps);
        if (steps.some((step) => !phases.some((phase) => step.title === `room-journey:${phase}`))) {
            this.issues.push({ testId: test.id, code: 'undeclared-phase' });
        }
        for (const phase of phases) {
            const evidence = computePhaseEvidence(phase, steps, result.status);
            this.observations.push({
                testId: test.id,
                testTitle: test.title,
                repeatEachIndex: test.repeatEachIndex,
                retry: result.retry,
                attemptStatus: result.status,
                phase,
                status: evidence.status,
                durationMs: evidence.durationMs
            });
            if (evidence.issue) {
                this.issues.push({ testId: test.id, code: evidence.issue });
            }
        }
    }

    async onEnd(result: Pick<FullResult, 'status'>): Promise<{ status: FullResult['status']; }> {
        const status = this.issues.length > 0 ? 'failed' : result.status;
        if (!this.outputDirectory) {
            console.error('Room journey evidence requires exactly one project output directory.');
            return { status: 'failed' };
        }
        const report = {
            formatVersion: 1,
            application: this.config.application,
            environment: this.config.environment,
            sourceRevision: this.config.sourceRevision,
            workers: this.workers,
            runStatus: result.status,
            observations: this.observations,
            issues: this.issues
        };
        try {
            await mkdir(this.outputDirectory, { recursive: true });
            await writeFile(join(this.outputDirectory, 'room-journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
            return { status };
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            console.error('Unable to write room journey evidence:', cause.message);
            return { status: 'failed' };
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}

interface PhaseEvidence {
    readonly status: RoomJourneyReporter.Status;
    readonly durationMs: number | null;
    readonly issue: RoomJourneyReporter.Issue['code'] | undefined;
}

function isJourneyPhase(phase: string | undefined): phase is RoomJourneyReporter.Phase {
    return phase === 'entry' || phase === 'recovery' || phase === 'repeat-play';
}

function toJourneySteps(steps: readonly TestStep[]): readonly TestStep[] {
    return steps.flatMap((step) => [
        ...(step.category === 'test.step' && step.title.startsWith('room-journey:') ? [step] : []),
        ...toJourneySteps(step.steps)
    ]);
}

function computePhaseEvidence(
    phase: RoomJourneyReporter.Phase,
    steps: readonly TestStep[],
    attemptStatus: TestResult['status']
): PhaseEvidence {
    const matching = steps.filter((step) => step.title === `room-journey:${phase}`);
    if (matching.length > 1) {
        return { status: 'invalid', durationMs: null, issue: 'duplicate-phase' };
    }
    const step = matching[0];
    if (!step) {
        return computeMissingPhaseEvidence(attemptStatus);
    }
    // test.skip inside a step annotates the attempt and throws this native interruption.
    // Preserve earlier caught failures in that skipped attempt as failed evidence.
    const interruptedBySkip = attemptStatus === 'skipped' &&
        step.error?.message?.startsWith('Error: Test is skipped:');
    if (step.annotations.some((annotation) => annotation.type === 'skip') || interruptedBySkip) {
        return { status: 'skipped', durationMs: null, issue: undefined };
    }
    if (!Number.isFinite(step.duration) || step.duration < 0) {
        return { status: 'invalid', durationMs: null, issue: 'invalid-duration' };
    }
    return { status: step.error ? 'failed' : 'passed', durationMs: step.duration, issue: undefined };
}

function computeMissingPhaseEvidence(attemptStatus: TestResult['status']): PhaseEvidence {
    if (attemptStatus === 'passed') {
        return { status: 'invalid', durationMs: null, issue: 'missing-phase' };
    }
    return {
        status: attemptStatus === 'skipped' ? 'skipped' : 'not-reached',
        durationMs: null,
        issue: undefined
    };
}

export default RoomJourneyReporter;
