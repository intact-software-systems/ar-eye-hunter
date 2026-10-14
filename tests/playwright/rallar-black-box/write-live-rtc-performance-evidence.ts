import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { toError } from '@shared/resilience/to-error.ts';

import type {
    RtcBaselineExternalAttemptDto,
    RtcBaselineExternalCohortDto
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import { isRtcBaselineId } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-id.ts';
import { normalizeJson } from './live-rtc-evidence-json.ts';
import { writeLiveRtcJournalEvidence } from './write-live-rtc-journal-evidence.ts';

export interface WriteLiveRtcPerformanceEvidenceInput {
    repoRoot: string;
    baselineId: string;
    relativePath: string;
    evidence: RtcBaselineExternalAttemptDto | RtcBaselineExternalCohortDto;
}

export async function writeLiveRtcPerformanceEvidence(
    input: WriteLiveRtcPerformanceEvidenceInput
): Promise<string> {
    if (
        !isRtcBaselineId(input.baselineId) ||
        (!input.baselineId.includes('-e3-memory') && !input.baselineId.includes('-e4-pg'))
    ) {
        throw new Error('Live RTC evidence requires a canonical E3-memory or E4-pg baseline ID.');
    }
    if (
        isAbsolute(input.relativePath) ||
        !input.relativePath.startsWith('artifacts/staging/')
    ) {
        throw new Error('Live RTC staged evidence must be confined beneath artifacts/staging.');
    }
    normalizeJson(input.evidence);
    const realRepoRoot = await realpath(input.repoRoot);
    const baselineRoot = resolve(
        realRepoRoot,
        'tmp',
        'perf',
        'rtc-baseline',
        input.baselineId
    );
    const stagingRoot = resolve(baselineRoot, 'artifacts', 'staging');
    const outputPath = resolve(baselineRoot, input.relativePath);
    const confinedRelativePath = relative(stagingRoot, outputPath);
    if (
        confinedRelativePath === '' ||
        confinedRelativePath === '..' ||
        confinedRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(confinedRelativePath)
    ) {
        throw new Error('Live RTC staged evidence path is not confined beneath artifacts/staging.');
    }
    await createConfinedDirectories(realRepoRoot, dirname(outputPath));
    await createConfinedDirectories(realRepoRoot, resolve(baselineRoot, 'artifacts/journals'));
    const evidence = await writeLiveRtcJournalEvidence({ ...input, repoRoot: realRepoRoot });
    const file = await open(outputPath, 'wx');
    try {
        await file.writeFile(`${JSON.stringify(evidence)}\n`, 'utf8');
        await file.sync();
    }
    finally {
        await file.close();
    }
    return outputPath;
}

async function createConfinedDirectories(
    root: string,
    targetDirectory: string
): Promise<void> {
    const targetRelativePath = relative(root, targetDirectory);
    if (
        targetRelativePath === '..' ||
        targetRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(targetRelativePath)
    ) {
        throw new Error('Live RTC evidence directory is not confined to the repository root.');
    }
    let current = root;
    for (const segment of targetRelativePath.split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        try {
            const metadata = await lstat(current);
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
                throw new Error(`Live RTC evidence directory component is unsafe: ${current}`);
            }
        }
        catch (cause) {
            const error = toError(cause);
            if (!('code' in error && error.code === 'ENOENT')) {
                throw error;
            }
            await mkdir(current);
        }
    }
}
