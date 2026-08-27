import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, expect, it } from 'vitest';

interface BrowserSoakModule {
    runRtcDataChannelBrowserSoakCli(
        argumentsList: readonly string[],
        dependencies: { baselineRootPath: string; }
    ): Promise<object>;
}

const temporaryRoots: string[] = [];
let browserSoak: BrowserSoakModule;

beforeAll(async () => {
    browserSoak = (await import(
        // @ts-expect-error The Node entrypoint is JavaScript and owns no TypeScript declaration.
        '../../../workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'
    )) as BrowserSoakModule;
});

afterEach(() => {
    for (const temporaryRoot of temporaryRoots.splice(0)) {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

it('accepts a timestamped GitHub browser observation before reading its baseline evidence', async () => {
    const baselineRootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-observation-id-'));
    temporaryRoots.push(baselineRootPath);
    const observationId = '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2';

    await expect(
        browserSoak.runRtcDataChannelBrowserSoakCli(
            [
                '--capture=raw-evidence',
                `--baseline-id=${observationId}`,
                '--case-id=browser-data-channel-lifecycle',
                '--input-key=iterations-25',
                '--intended-phase=warmup',
                '--outer-ordinal=1',
                '--out=artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-warmup-001.json'
            ],
            { baselineRootPath }
        )
    ).rejects.toThrow('baseline directory does not exist');
});
