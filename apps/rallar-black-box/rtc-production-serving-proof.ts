import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
    lstat,
    open,
    readFile,
    writeFile
} from 'node:fs/promises';
import { resolve } from 'node:path';

import {
    decodeFullStackRtcProductionProof,
    decodeProductionSeal,
    type FullStackRtcBrowserEntry,
    type FullStackRtcProductionFile,
    type FullStackRtcProductionSeal,
    type FullStackRtcServedBuild,
    type FullStackRtcServingProof
} from '../../packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';

import { Either } from '../../packages/shared/resilience/Either.ts';

import {
    readFullStackRtcProductionSeal,
    type FullStackRtcProductionAttempt,
    type FullStackRtcProductionConfiguration
} from './playwright-full-stack-spa-server.ts';

export interface FullStackRtcServingResponse {
    readonly status: number;
    readonly bytes: Uint8Array;
}

export interface FullStackRtcServingDependencies {
    readBytes(url: string): Promise<FullStackRtcServingResponse>;
}

export interface FullStackRtcBrowserResponse extends FullStackRtcServingResponse {
    readonly prefix: 'A' | 'B' | 'C';
    readonly url: string;
}

export interface FullStackRtcServingFailure {
    readonly code: 'served-bytes-mismatch' | 'missing-serving-proof';
    readonly message: string;
}

export async function readFullStackRtcServedBuild(
    seal: FullStackRtcProductionSeal,
    readBytes: FullStackRtcServingDependencies['readBytes']
): Promise<Either<FullStackRtcServingFailure, FullStackRtcServedBuild>> {
    try {
        const servedFiles: FullStackRtcProductionFile[] = [];
        for (const file of seal.files.filter((file) => !file.path.startsWith('.'))) {
            const response = await readBytes(
                new URL(file.path === 'index.html' ? '/' : `/${file.path}`, seal.spaOrigin).href
            );
            const observed = toServedFile(file.path, response.bytes);
            if (response.status !== 200 || JSON.stringify(observed) !== JSON.stringify(file)) {
                return servingFailure('served-bytes-mismatch');
            }
            servedFiles.push(observed);
        }
        if (
            !servedFiles.some((file) => file.path === 'index.html') ||
            !seal.entryFiles.every((path) => servedFiles.some((file) => file.path === path))
        ) {
            return servingFailure('served-bytes-mismatch');
        }
        return Either.ofRight({ seal, servedFiles });
    }
    catch {
        return servingFailure('served-bytes-mismatch');
    }
}

export function toFullStackRtcBrowserEntry(
    build: FullStackRtcServedBuild,
    response: FullStackRtcBrowserResponse
): Either<FullStackRtcServingFailure, FullStackRtcBrowserEntry> {
    try {
        const url = new URL(response.url);
        const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = build.servedFiles.find((file) => file.path === path);
        const observed = toServedFile(path, response.bytes);
        if (
            url.origin !== build.seal.spaOrigin || response.status !== 200 ||
            !['A', 'B', 'C'].includes(response.prefix) || !file || JSON.stringify(observed) !== JSON.stringify(file)
        ) {
            return servingFailure('served-bytes-mismatch');
        }
        return Either.ofRight({ prefix: response.prefix, ...observed });
    }
    catch {
        return servingFailure('served-bytes-mismatch');
    }
}

export async function readDefaultFullStackRtcServedBuild(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration
): Promise<FullStackRtcServedBuild> {
    const verified = await readFullStackRtcProductionSeal(attempt, configuration);
    if (!verified.right) {
        throw new Error('Production serving requires a verified original build.');
    }
    const existing = await readExistingServedBuild(verified.right);
    if (existing) {
        return existing;
    }
    const served = await readFullStackRtcServedBuild(verified.right, async (url) => {
        const response = await fetch(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            cache: 'no-store'
        });
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    });
    if (!served.right) {
        throw new Error('Actual production served bytes did not match the sealed build.');
    }
    await writeFile(resolve(configuration.buildRoot, 'serving.json'), JSON.stringify(served.right), { flag: 'wx' });
    return served.right;
}

export async function writeFullStackRtcBrowserEntries(
    build: FullStackRtcServedBuild,
    entries: readonly FullStackRtcBrowserEntry[]
): Promise<void> {
    for (const entry of entries) {
        const file = build.servedFiles.find((file) => file.path === entry.path);
        if (
            !file || entry.sha256 !== file.sha256 || entry.sizeBytes !== file.sizeBytes ||
            !['A', 'B', 'C'].includes(entry.prefix)
        ) {
            throw new Error('Browser entry bytes did not match the sealed build.');
        }
    }
    const receipt = await open(
        resolve(build.seal.buildRoot, 'entries.jsonl'),
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
    );
    try {
        if (!(await receipt.stat()).isFile()) {
            throw new Error('Unsafe private serving proof.');
        }
        await receipt.writeFile(
            entries.map((entry) =>
                JSON.stringify({
                    prefix: entry.prefix,
                    path: entry.path,
                    sizeBytes: entry.sizeBytes,
                    sha256: entry.sha256
                })
            ).join('\n') + '\n'
        );
    }
    finally {
        await receipt.close();
    }
}

export async function readFullStackRtcServingProof(
    attempt: FullStackRtcProductionAttempt,
    configuration: FullStackRtcProductionConfiguration
): Promise<Either<FullStackRtcServingFailure, FullStackRtcServingProof>> {
    const verified = await readFullStackRtcProductionSeal(attempt, configuration);
    if (!verified.right) {
        return servingFailure('missing-serving-proof');
    }
    try {
        const build = await readExistingServedBuild(verified.right);
        if (!build) {
            return servingFailure('missing-serving-proof');
        }
        const lines = (await readPrivateProofFile(configuration.buildRoot, 'entries.jsonl')).trim().split('\n');
        const entries: FullStackRtcBrowserEntry[] = [];
        for (const line of lines) {
            const entry = decodeBrowserEntry(JSON.parse(line), build);
            if (!entry) {
                return servingFailure('served-bytes-mismatch');
            }
            entries.push(entry);
        }
        const proof = { build, entries };
        const decoded = decodeFullStackRtcProductionProof(proof, {
            baselineId: attempt.baselineId,
            attempt: attempt.locator,
            git: attempt.runtimeObservation.git,
            inputFiles: attempt.runtimeObservation.sourceHashes
        });
        return decoded.left ? servingFailure('missing-serving-proof') : Either.ofRight(decoded.right!);
    }
    catch {
        return servingFailure('missing-serving-proof');
    }
}

export async function readFullStackRtcAttemptServingProof(
    attempt: FullStackRtcProductionAttempt
): Promise<Either<FullStackRtcServingFailure, FullStackRtcServingProof>> {
    const buildRoot = resolve(
        attempt.repoRoot,
        'tmp/perf/rtc-b06-private-build',
        attempt.baselineId,
        attempt.locator.caseId,
        `${attempt.locator.intendedPhase}-${attempt.locator.outerOrdinal}`
    );
    try {
        const seal = decodeProductionSeal(JSON.parse(await readFile(resolve(buildRoot, 'seal.json'), 'utf8')));
        if (!seal) {
            return servingFailure('missing-serving-proof');
        }
        return readFullStackRtcServingProof(attempt, {
            buildRoot,
            apiBaseUrl: seal.apiOrigin,
            spaBaseUrl: seal.spaOrigin,
            environment: { NODE_ENV: 'production' }
        });
    }
    catch {
        return servingFailure('missing-serving-proof');
    }
}

function toServedFile(path: string, bytes: Uint8Array): FullStackRtcProductionFile {
    return { path, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function readExistingServedBuild(seal: FullStackRtcProductionSeal): Promise<FullStackRtcServedBuild | null> {
    try {
        const expected = { seal, servedFiles: seal.files.filter((file) => !file.path.startsWith('.')) };
        return JSON.stringify(JSON.parse(await readPrivateProofFile(seal.buildRoot, 'serving.json'))) ===
                JSON.stringify(expected)
            ? expected
            : null;
    }
    catch {
        return null;
    }
}

async function readPrivateProofFile(buildRoot: string, filename: string): Promise<string> {
    const path = resolve(buildRoot, filename);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error('Unsafe private serving proof.');
    }
    return readFile(path, 'utf8');
}

function decodeBrowserEntry(raw: unknown, build: FullStackRtcServedBuild): FullStackRtcBrowserEntry | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    if (!('prefix' in raw) || (raw.prefix !== 'A' && raw.prefix !== 'B' && raw.prefix !== 'C')) {
        return null;
    }
    const file = build.servedFiles.find((file) => file.path === ('path' in raw ? raw.path : undefined));
    if (
        !file || !('sha256' in raw) || raw.sha256 !== file.sha256 || !('sizeBytes' in raw) ||
        raw.sizeBytes !== file.sizeBytes ||
        Object.keys(raw).some((key) => !['prefix', 'path', 'sha256', 'sizeBytes'].includes(key))
    ) {
        return null;
    }
    return { prefix: raw.prefix, ...file };
}

function servingFailure(code: FullStackRtcServingFailure['code']): Either<FullStackRtcServingFailure, never> {
    return Either.ofLeft({
        code,
        message: 'Original production serving and browser entry bytes could not be verified.'
    });
}
