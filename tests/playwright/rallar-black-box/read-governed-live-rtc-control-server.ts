import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
    createFullStackControlWebServer,
    type FullStackControlWebServer
} from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import { isRtcBaselineId } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-id.ts';

export interface GovernedLiveRtcControlAttemptDto {
    readonly repoRoot: string;
    readonly baselineId: string;
    readonly locator: { readonly caseId: string; readonly intendedPhase: string; readonly outerOrdinal: number; };
}

export interface GovernedLiveRtcControlServerInput {
    readonly attempt: GovernedLiveRtcControlAttemptDto;
    readonly baseUrl: string;
    readonly storageDirectory: string | undefined;
}

export interface GovernedLiveRtcControlWebServer extends FullStackControlWebServer {
    readonly env: { readonly RALLAR_BLACK_BOX_STORAGE_DIR: string; };
}

export async function readGovernedLiveRtcControlServer(
    input: GovernedLiveRtcControlServerInput
): Promise<GovernedLiveRtcControlWebServer> {
    const attempt = input.attempt;
    if (
        !isRtcBaselineId(attempt.baselineId) ||
        !['default', 'all-scenarios', 'retention-100'].includes(attempt.locator.caseId) ||
        !['warmup', 'retained'].includes(attempt.locator.intendedPhase) ||
        !Number.isSafeInteger(attempt.locator.outerOrdinal) || attempt.locator.outerOrdinal < 1
    ) {
        throw new Error('Governed RTC recorder selection is invalid.');
    }
    const root = await realpath(attempt.repoRoot);
    const expected = resolve(
        root,
        'tmp/perf/rtc-b06-recorder',
        attempt.baselineId,
        attempt.locator.caseId,
        `${attempt.locator.intendedPhase}-${attempt.locator.outerOrdinal}`
    );
    if (input.storageDirectory === undefined || resolve(input.storageDirectory) !== expected) {
        throw new Error('Governed RTC control requires the exact current-attempt recorder directory.');
    }
    let directory = root;
    for (const segment of relative(root, expected).split(sep)) {
        directory = resolve(directory, segment);
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('Governed RTC recorder directory is not confined.');
        }
    }
    await writeRecorderProbe(expected);
    return {
        ...createFullStackControlWebServer({ baseUrl: input.baseUrl, reuseExistingServer: false }),
        env: { RALLAR_BLACK_BOX_STORAGE_DIR: expected }
    };
}

async function writeRecorderProbe(directory: string): Promise<void> {
    const path = resolve(directory, '.rtc-journal-write-probe');
    const file = await open(path, 'wx');
    try {
        await file.writeFile('RTC recorder preflight\n');
    }
    finally {
        await file.close();
    }
    await unlink(path);
}
