import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type MatrixEntry = {
    id: string;
    recipe: string;
    category: string;
    mode: string;
    profiles: string[];
    expectedExitCode: number;
    artifactName?: string;
    requires?: {
        env?: string[];
        httpServices?: Array<{ name: string; env: string; default?: string }>;
        playwright?: boolean;
    };
};

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const runnerRoot = path.join(repoRoot, 'packages/shared-test/black-box-runner');
const examplesRoot = path.join(runnerRoot, 'examples');
const matrixPath = path.join(runnerRoot, 'recipe-matrix.json');

function readMatrix(): { entries: MatrixEntry[] } {
    return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

describe('black-box runner recipe matrix', () => {
    it('has unique entry ids and artifact names', () => {
        const { entries } = readMatrix();
        const ids = entries.map(entry => entry.id);
        const artifactNames = entries.map(entry => entry.artifactName ?? entry.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(artifactNames).size).toBe(artifactNames.length);
    });

    it('points every entry at an example recipe file', () => {
        const { entries } = readMatrix();

        entries.forEach(entry => {
            expect(entry.recipe.startsWith('examples/')).toBe(true);
            expect(entry.recipe.endsWith('.json')).toBe(true);
            expect(() => readFileSync(path.join(runnerRoot, entry.recipe), 'utf8')).not.toThrow();
        });
    });

    it('covers every example recipe at least once', () => {
        const { entries } = readMatrix();
        const covered = new Set(entries.map(entry => entry.recipe));
        const examples = readdirSync(examplesRoot)
            .filter(name => name.endsWith('.json'))
            .map(name => 'examples/' + name);

        expect([...covered].sort()).toEqual(expect.arrayContaining(examples.sort()));
    });

    it('classifies profiles and execution modes explicitly', () => {
        const { entries } = readMatrix();
        const profiles = new Set(entries.flatMap(entry => entry.profiles));

        expect(profiles.has('quick')).toBe(true);
        expect(profiles.has('dry')).toBe(true);
        expect(profiles.has('deterministic')).toBe(true);
        expect(profiles.has('soak')).toBe(true);
        expect(profiles.has('traffic')).toBe(true);
        expect(profiles.has('parallel')).toBe(true);
        expect(profiles.has('live')).toBe(true);
        expect(profiles.has('live-soak')).toBe(true);
        expect(profiles.has('live-traffic')).toBe(true);
        expect(profiles.has('live-parallel')).toBe(true);

        entries.forEach(entry => {
            expect(['dry-run', 'run']).toContain(entry.mode);
            expect(entry.profiles.length).toBeGreaterThan(0);
            expect([0, 1]).toContain(entry.expectedExitCode);
        });
    });

    it('gates live browser and remote entries', () => {
        const { entries } = readMatrix();
        const liveEntries = entries.filter(entry => entry.profiles.includes('live'));

        liveEntries.forEach(entry => {
            expect(entry.requires).toBeTruthy();
        });

        const browserLiveEntries = entries.filter(entry => entry.profiles.includes('browser-live'));
        browserLiveEntries.forEach(entry => {
            expect(entry.requires?.playwright).toBe(true);
        });

        const remoteLiveEntries = entries.filter(entry => entry.profiles.includes('remote-live'));
        remoteLiveEntries.forEach(entry => {
            expect(entry.requires?.env).toContain('RALLAR_BLACK_BOX_CONTROL_BASE_URL');
            expect(entry.requires?.env).toContain('RALLAR_BLACK_BOX_AGENT_ID');
        });
    });

    it('includes gated live-provider baselines for soak, traffic, and parallel RTC patterns', () => {
        const { entries } = readMatrix();
        const byProfile = (profile: string) => entries.filter(entry => entry.profiles.includes(profile));

        expect(byProfile('live-soak').map(entry => entry.id).sort()).toEqual([
            'browser-messages-rtc-same-connection-soak-live',
            'remote-messages-rtc-same-connection-soak-live',
        ]);
        expect(byProfile('live-traffic').map(entry => entry.id).sort()).toEqual([
            'browser-messages-rtc-seeded-traffic-live',
            'remote-messages-rtc-seeded-traffic-live',
        ]);
        expect(byProfile('live-parallel').map(entry => entry.id).sort()).toEqual([
            'browser-messages-rtc-parallel-groups-live',
            'remote-messages-rtc-parallel-groups-live',
        ]);

        for (const entry of [
            ...byProfile('live-soak'),
            ...byProfile('live-traffic'),
            ...byProfile('live-parallel'),
        ]) {
            expect(entry.mode).toBe('run');
            expect(entry.expectedExitCode).toBe(0);
            expect(entry.profiles).toContain('live');
            expect(entry.requires?.env).toContain('RALLAR_API_BASE_URL');
            expect(entry.requires?.env).toContain('RALLAR_ALICE_USERNAME');
            expect(entry.requires?.env).toContain('RALLAR_BOB_USERNAME');
        }
    });
});
