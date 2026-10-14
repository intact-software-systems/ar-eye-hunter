import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadLiveRtcPerformanceAttempt } from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';
import {
    portFromBaseUrl,
    readFullStackApiBaseUrl,
    readFullStackSpaBaseUrl
} from '../playwright-full-stack-api-server.ts';
import { readFullStackRtcProductionSeal } from '../playwright-full-stack-spa-server.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const attempt = await loadLiveRtcPerformanceAttempt({ repoRoot, environment: process.env });
if (!attempt) {
    throw new Error('Production preview requires an admitted original attempt.');
}
const verified = await readFullStackRtcProductionSeal(attempt, {
    buildRoot: process.env.RALLAR_BLACK_BOX_RTC_BUILD_ROOT ?? '',
    apiBaseUrl: readFullStackApiBaseUrl(),
    spaBaseUrl: readFullStackSpaBaseUrl(),
    environment: process.env
});
if (!verified.right) {
    throw new Error(verified.left?.message ?? 'Production preview binding failed.');
}
const seal = verified.right;
const child = spawn('npm', [
    '--workspace',
    'rallar-black-box',
    'run',
    'preview',
    '--',
    '--outDir',
    `${seal.buildRoot}/output`,
    '--port',
    String(portFromBaseUrl(seal.spaOrigin)),
    '--strictPort',
    '--mode',
    'production'
], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'ignore'
});
process.on('SIGTERM', () => {
    child.kill('SIGTERM');
});
process.on('SIGINT', () => {
    child.kill('SIGINT');
});
child.on('error', () => {
    console.error('Original production preview failed to launch.');
    process.exitCode = 1;
});
child.on('exit', (code) => {
    process.exitCode = code ?? 1;
});
