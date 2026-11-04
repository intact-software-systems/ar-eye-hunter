import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
    readonly run?: string;
}

interface WorkflowJob {
    readonly steps?: readonly WorkflowStep[];
    readonly strategy?: Readonly<{ matrix: Readonly<{ lane?: readonly string[]; }>; }>;
}

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const releaseGate = load(
    readFileSync(path.join(repoRoot, '.github/workflows/release-gate.yml'), 'utf8')
) as WorkflowDocument;
const gamesReleaseGate = load(
    readFileSync(path.join(repoRoot, '.github/workflows/games-release-gate.yml'), 'utf8')
) as WorkflowDocument;

function toRunText(jobs: Readonly<Record<string, WorkflowJob>>): string {
    return Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? '')).join('\n');
}

describe('Games Release Gate lanes', () => {
    const gamesRun = toRunText(gamesReleaseGate.jobs);
    const platformRun = toRunText(releaseGate.jobs);

    it('owns the game builds and server checks and keeps them out of the platform gate', () => {
        for (
            const command of [
                'npm run build:ar-eye-hunter-v1',
                'npm run build:relic-hunters-v1',
                '(cd apps/ar-eye-hunter-server-v1 && deno task check)',
                '(cd apps/relic-hunter-server-v1 && deno task check)'
            ]
        ) {
            expect(gamesRun).toContain(command);
            expect(platformRun).not.toContain(command);
        }
    });

    it('runs only the three game lanes', () => {
        expect(Object.keys(gamesReleaseGate.jobs).toSorted()).toEqual([
            'checks-games',
            'deno-games',
            'e2e-game-rooms'
        ]);
    });

    it('routes game Deno tests through the split script', () => {
        expect(gamesRun).toContain('npm run test:deno:games');
    });

    it('runs the seven game-room browser lanes', () => {
        expect(gamesReleaseGate.jobs['e2e-game-rooms']?.strategy?.matrix?.lane).toEqual([
            'ar-eye',
            'relic',
            'relic-continuity',
            'move-together',
            'matchmaking',
            'ar-eye-tournaments',
            'relic-tournaments'
        ]);
    });
});
