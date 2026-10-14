import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    writeFileSync
} from 'node:fs';
import {
    dirname,
    join,
    resolve
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

import { Either } from '../../../shared/resilience/Either.ts';
import { isRtcBrowserBaselineId } from '../../baseline/contracts/rtc-baseline-id.ts';
import {
    computeRtcDataChannelBrowserSoakSample,
    RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT,
    validateRtcDataChannelBrowserSoakRuntimeObservation
} from './rtc-data-channel-browser-soak-validation.ts';

const {
    workloadId: WORKLOAD_ID,
    caseId: CASE_ID,
    inputKey: INPUT_KEY,
    environmentId: ENVIRONMENT_ID,
    iterations: ACCEPTED_ITERATIONS,
    scriptPath: SCRIPT_PATH
} = RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT;
const DEFAULT_DIAGNOSTIC_OUT = 'tmp/perf/results/rtc-data-channel-browser-soak.json';
const DEFAULT_BASELINE_ROOT = 'tmp/perf/rtc-baseline';

/**
 * @typedef {object} BrowserSoakReadFailure
 * @property {'artifact-read-failed'} code
 * @property {'read-json' | 'read-directory' | 'read-output-path'} operation
 * @property {string} path
 * @property {string} message
 * @property {Error} cause
 */

/**
 * @typedef {{ code: 'invalid-admission', issues: readonly string[] }} BrowserSoakValidationFailure
 * @typedef {BrowserSoakValidationFailure | BrowserSoakReadFailure} BrowserSoakAdmissionFailure
 */

function validateIntegerOption({ value, name, minimum, maximum }) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? []
        : [`option --${name} must be an integer from ${minimum} through ${maximum}`];
}

function validateRawEvidenceOptions(options) {
    const issues = [];
    const allowed = new Set([
        'capture',
        'baseline-id',
        'case-id',
        'input-key',
        'intended-phase',
        'outer-ordinal',
        'out'
    ]);
    for (const name of options.keys()) {
        if (!allowed.has(name)) {
            issues.push(`option --${name} cannot override the accepted raw-evidence workload`);
        }
    }
    for (const name of ['baseline-id', 'case-id', 'input-key', 'intended-phase', 'outer-ordinal', 'out']) {
        if (!options.get(name)) {
            issues.push(`option --${name} is required`);
        }
    }
    if (options.get('baseline-id') && !isRtcBrowserBaselineId(options.get('baseline-id'))) {
        issues.push('baseline ID does not match the accepted E2 browser grammar');
    }
    const intendedPhase = options.get('intended-phase');
    if (intendedPhase && intendedPhase !== 'warmup' && intendedPhase !== 'retained') {
        issues.push('option --intended-phase must be warmup or retained');
    }
    if (options.get('outer-ordinal')) {
        issues.push(...validateIntegerOption({
            value: options.get('outer-ordinal'),
            name: 'outer-ordinal',
            minimum: 1,
            maximum: 999
        }));
    }
    return issues;
}

function parseCommand(argumentsList) {
    const options = new Map();
    const issues = [];
    for (const [index, argument] of argumentsList.entries()) {
        if (!argument.startsWith('--') || !argument.includes('=')) {
            issues.push(`argument ${index + 1} must use --name=value syntax`);
            continue;
        }
        const separator = argument.indexOf('=');
        const name = argument.slice(2, separator);
        if (options.has(name)) {
            issues.push(`option --${name} may appear only once`);
            continue;
        }
        options.set(name, argument.slice(separator + 1));
    }
    const rawEvidence = options.get('capture') === 'raw-evidence';
    const iterations = options.get('iterations') ?? '25';
    issues.push(
        ...(rawEvidence
            ? validateRawEvidenceOptions(options)
            : validateIntegerOption({ value: iterations, name: 'iterations', minimum: 1, maximum: 10_000 }))
    );
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight(
        rawEvidence
            ? {
                mode: 'raw-evidence',
                baselineId: options.get('baseline-id'),
                caseId: options.get('case-id'),
                inputKey: options.get('input-key'),
                intendedPhase: options.get('intended-phase'),
                outerOrdinal: Number(options.get('outer-ordinal')),
                rawResultRelativePath: options.get('out')
            }
            : {
                mode: 'diagnostic',
                iterations: Number(iterations),
                outputPath: options.get('out') ?? DEFAULT_DIAGNOSTIC_OUT
            }
    );
}

function toPaddedOrdinal(value) {
    return String(value).padStart(3, '0');
}

function toAcceptedSampleId(intendedPhase, outerOrdinal) {
    return [
        'rtc-b05-browser-data-channel-lifecycle-iterations-25',
        intendedPhase,
        toPaddedOrdinal(outerOrdinal),
        '001'
    ].join('-');
}

function toAcceptedRawRelativePath(intendedPhase, outerOrdinal) {
    return [
        'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25',
        intendedPhase,
        `${toPaddedOrdinal(outerOrdinal)}.json`
    ].join('-');
}

function computeExpectedOuterAttempts(retainedSampleMultiplier) {
    const retainedCount = retainedSampleMultiplier === 1 ? 5 : 10;
    const attempt = (intendedPhase, outerOrdinal) => ({
        workloadId: WORKLOAD_ID,
        caseId: CASE_ID,
        inputKey: INPUT_KEY,
        environmentId: ENVIRONMENT_ID,
        intendedPhase,
        outerOrdinal,
        sampleIds: [toAcceptedSampleId(intendedPhase, outerOrdinal)]
    });
    return [
        attempt('warmup', 1),
        ...Array.from({ length: retainedCount }, (_, index) => attempt('retained', index + 1))
    ];
}

/** @returns {Either<BrowserSoakReadFailure, import('../../baseline/contracts/rtc-baseline-contracts.ts').RtcBaselineJson>} */
function readJson(path, artifactName) {
    try {
        return Either.ofRight(JSON.parse(readFileSync(path, 'utf8')));
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return Either.ofLeft({
            code: 'artifact-read-failed',
            operation: 'read-json',
            path,
            cause,
            message: `${artifactName} could not be read as JSON: ${cause.message}`
        });
    }
}

function isSameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRepeatContract(manifest, baselineId) {
    const issues = [];
    const repeat = baselineId.endsWith('-repeat-01');
    const multiplier = manifest.request.retainedSampleMultiplier;
    if (multiplier !== (repeat ? 2 : 1)) {
        issues.push('manifest retained-sample multiplier does not match the baseline identity');
    }
    const repeatLink = manifest.request.repeatLink;
    if (!repeat && repeatLink !== null) {
        issues.push('primary manifest must not contain a repeat link');
    }
    if (
        repeat &&
        (repeatLink?.primaryBaselineId !== baselineId.replace(/-repeat-01$/, '') ||
            typeof repeatLink?.primarySummarySha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(repeatLink?.primarySummarySha256 ?? ''))
    ) {
        issues.push('repeat manifest must link to the exact primary summary');
    }
    if (!isSameJson(manifest.repeatLink, repeatLink)) {
        issues.push('manifest repeat link differs from its request');
    }
    return issues;
}

function validateManifest(manifest, command) {
    if (!isJsonObject(manifest)) {
        return ['manifest identity does not match the raw-evidence command'];
    }
    const issues = [];
    const request = manifest.request;
    const requestPresent = isJsonObject(request);
    if (
        manifest.schema !== 'rallar.rtc-baseline.manifest.v1' ||
        !requestPresent || request.schema !== 'rallar.rtc-baseline.capture-request.v1' ||
        request.baselineId !== command.baselineId || request.environmentId !== ENVIRONMENT_ID
    ) {
        issues.push('manifest identity does not match the raw-evidence command');
    }
    if (
        (requestPresent && !isSameJson(request.workloadIds, [WORKLOAD_ID])) ||
        !isSameJson(manifest.workloadIds, [WORKLOAD_ID]) ||
        !isSameJson(manifest.cases, [{ workloadId: WORKLOAD_ID, caseId: CASE_ID, inputKey: INPUT_KEY }]) ||
        (requestPresent && !isSameJson(request.conditionalEnvironmentDecisions, [])) ||
        !isSameJson(manifest.expectedCohorts, [])
    ) {
        issues.push('manifest changes the immutable RTC-B05 workload');
    }
    if (requestPresent) {
        issues.push(...validateRepeatContract(manifest, command.baselineId));
    }
    const multiplier = command.baselineId.endsWith('-repeat-01') ? 2 : 1;
    if (!isSameJson(manifest.outerAttempts, computeExpectedOuterAttempts(multiplier))) {
        issues.push('manifest outer process identities differ from the accepted RTC-B05 matrix');
    }
    if (
        Array.isArray(manifest.outerAttempts) && !manifest.outerAttempts.some(
            (entry) => isJsonObject(entry) && isRequestedOuterAttempt(entry, command)
        )
    ) {
        issues.push('manifest does not predeclare the requested RTC-B05 outer process identity');
    }
    return issues;
}

function isRequestedOuterAttempt(entry, command) {
    return entry.workloadId === WORKLOAD_ID && entry.caseId === command.caseId &&
        entry.inputKey === command.inputKey && entry.intendedPhase === command.intendedPhase &&
        entry.outerOrdinal === command.outerOrdinal;
}

function validateEnvironment(environment, manifest) {
    if (!isJsonObject(environment)) {
        return ['environment identity does not match the immutable manifest'];
    }
    const issues = [];
    if (
        environment.schema !== 'rallar.rtc-baseline.environment.v1' ||
        environment.baselineId !== manifest.request.baselineId ||
        environment.environmentId !== ENVIRONMENT_ID ||
        !isSameJson(environment.workloadIds, [WORKLOAD_ID]) ||
        !isSameJson(environment.repeatLink, manifest.repeatLink) ||
        !isSameJson(environment.conditionalEnvironmentDecisions, []) ||
        environment.observation === null
    ) {
        issues.push('environment identity does not match the immutable manifest');
    }
    const observation = environment.observation;
    if (
        !isJsonObject(observation) || !Array.isArray(observation.sourceHashes) ||
        !observation.sourceHashes.every((entry) => isJsonObject(entry) && typeof entry.sha256 === 'string')
    ) {
        issues.push(
            'environment changes the accepted RTC-B05 configuration or provenance: invalid-runtime-observation'
        );
    }
    else {
        issues.push(
            ...validateRtcDataChannelBrowserSoakRuntimeObservation(
                observation,
                manifest.request.baselineId
            ).map((issue) => `environment changes the accepted RTC-B05 configuration or provenance: ${issue.code}`)
        );
    }
    return issues;
}

/** @returns {Either<BrowserSoakAdmissionFailure, string>} */
function readDirectory(path, label) {
    try {
        if (!existsSync(path)) {
            return Either.ofLeft({ code: 'invalid-admission', issues: [`${label} directory does not exist`] });
        }
        const status = lstatSync(path);
        return status.isSymbolicLink() || !status.isDirectory()
            ? Either.ofLeft({ code: 'invalid-admission', issues: [`${label} must be a non-symlink directory`] })
            : Either.ofRight(path);
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return Either.ofLeft({
            code: 'artifact-read-failed',
            operation: 'read-directory',
            path,
            cause,
            message: `${label} directory could not be read: ${cause.message}`
        });
    }
}

/** @returns {Either<BrowserSoakAdmissionFailure, string>} */
function readRawOutputPath({ command, baselinePath, outerAttempt }) {
    const expectedRelativePath = toAcceptedRawRelativePath(
        outerAttempt.intendedPhase,
        outerAttempt.outerOrdinal
    );
    if (command.rawResultRelativePath !== expectedRelativePath) {
        return Either.ofLeft({
            code: 'invalid-admission',
            issues: [`raw output path must equal ${expectedRelativePath}`]
        });
    }
    const outputPath = join(baselinePath, expectedRelativePath);
    try {
        return existsSync(outputPath)
            ? Either.ofLeft({
                code: 'invalid-admission',
                issues: [`raw output already exists at ${expectedRelativePath}`]
            })
            : Either.ofRight(outputPath);
    }
    catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return Either.ofLeft({
            code: 'artifact-read-failed',
            operation: 'read-output-path',
            path: outputPath,
            cause,
            message: `raw output path could not be read at ${expectedRelativePath}: ${cause.message}`
        });
    }
}

function readRawCaptureContext(command, baselineRootPath) {
    const baselinePath = join(baselineRootPath, command.baselineId);
    for (
        const [path, label] of [
            [baselineRootPath, 'baseline root'],
            [baselinePath, 'baseline'],
            [join(baselinePath, 'artifacts'), 'artifact'],
            [join(baselinePath, 'artifacts/staging'), 'staging']
        ]
    ) {
        const directory = readDirectory(path, label);
        if (directory.left !== undefined) {
            return Either.ofLeft(directory.left);
        }
    }
    const manifestRead = readJson(join(baselinePath, 'manifest.json'), 'manifest');
    if (manifestRead.left !== undefined) {
        return Either.ofLeft(manifestRead.left);
    }
    const manifest = manifestRead.right;
    const manifestIssues = validateManifest(manifest, command);
    if (manifestIssues.length > 0) {
        return Either.ofLeft({ code: 'invalid-admission', issues: manifestIssues });
    }
    const outerAttempt = manifest.outerAttempts.find((entry) => isRequestedOuterAttempt(entry, command));
    const outputPath = readRawOutputPath({ command, baselinePath, outerAttempt });
    if (outputPath.left !== undefined) {
        return Either.ofLeft(outputPath.left);
    }
    const environmentRead = readJson(join(baselinePath, 'environment.json'), 'environment');
    if (environmentRead.left !== undefined) {
        return Either.ofLeft(environmentRead.left);
    }
    const environment = environmentRead.right;
    const environmentIssues = validateEnvironment(environment, manifest);
    return environmentIssues.length > 0
        ? Either.ofLeft({ code: 'invalid-admission', issues: environmentIssues })
        : Either.ofRight({ outerAttempt, outputPath: outputPath.right, runtimeObservation: environment.observation });
}

function toCliAdmissionError(failure) {
    if (Array.isArray(failure) || failure.code === 'invalid-admission') {
        const issues = Array.isArray(failure) ? failure : failure.issues;
        return new Error(`RTC-B05: ${issues.join('; ')}`);
    }
    return new Error(`RTC-B05: ${failure.message}`, { cause: failure.cause });
}

async function measureBrowserLifecycle(iterations, iterationIdPrefix, dependencies) {
    const browser = await dependencies.launchBrowser({ headless: true });
    try {
        const page = await browser.newPage();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        const readHeapUsed = async () => {
            await cdp.send('HeapProfiler.collectGarbage');
            const metrics = await cdp.send('Performance.getMetrics');
            return metrics.metrics?.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? null;
        };
        await page.setContent('<!doctype html><title>RTC DataChannel soak</title>');
        await installPageLifecycleOperations(page);
        const heapBefore = await readHeapUsed();
        const startedAt = performance.now();
        const soak = await runPageLifecycle(page, { iterationCount: iterations, iterationIdPrefix });
        const durationMs = performance.now() - startedAt;
        const heapAfter = await readHeapUsed();
        return {
            durationMs,
            heap: {
                beforeBytes: heapBefore,
                afterBytes: heapAfter,
                deltaBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore
            },
            soak
        };
    }
    finally {
        await browser.close();
    }
}

async function installPageLifecycleOperations(page) {
    await installPageLifecycleNamespace(page);
    await installPageLifecycleWait(page);
    await installPageLifecycleState(page);
    await installPageLifecycleOpen(page);
    await installPageLifecycleClose(page);
    await installPageLifecycleIteration(page);
}

async function installPageLifecycleNamespace(page) {
    await page.evaluate(() => {
        globalThis.rtcB05 = {};
    });
}

async function installPageLifecycleWait(page) {
    await page.evaluate(() => {
        globalThis.rtcB05.waitFor = async (predicate, timeoutMs = 5000) => {
            const started = performance.now();
            while (performance.now() - started < timeoutMs) {
                if (predicate()) {
                    return true;
                }
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
            }
            return false;
        };
    });
}

async function installPageLifecycleState(page) {
    await page.evaluate(() => {
        globalThis.rtcB05.createIterationState = (index) => {
            const pcA = new RTCPeerConnection({ iceServers: [] });
            const pcB = new RTCPeerConnection({ iceServers: [] });
            const events = [];
            let channelB;
            let messageReceived = false;
            pcA.onicecandidate = (event) => {
                if (event.candidate) {
                    void pcB.addIceCandidate(event.candidate);
                }
            };
            pcB.onicecandidate = (event) => {
                if (event.candidate) {
                    void pcA.addIceCandidate(event.candidate);
                }
            };
            const channelA = pcA.createDataChannel(`soak-${index}`);
            pcB.ondatachannel = (event) => {
                channelB = event.channel;
                channelB.onopen = () => events.push('remote-open');
                channelB.onclose = () => events.push('remote-close');
                channelB.onerror = () => events.push('remote-error');
                channelB.onmessage = () => {
                    messageReceived = true;
                    events.push('remote-message');
                };
            };
            channelA.onopen = () => events.push('local-open');
            channelA.onclose = () => events.push('local-close');
            channelA.onerror = () => events.push('local-error');
            return {
                pcA,
                pcB,
                channelA,
                events,
                channelB: () => channelB,
                messageReceived: () => messageReceived
            };
        };
    });
}

async function installPageLifecycleOpen(page) {
    await page.evaluate(() => {
        globalThis.rtcB05.openChannels = async (state) => {
            const startedAt = performance.now();
            const offer = await state.pcA.createOffer();
            await state.pcA.setLocalDescription(offer);
            await state.pcB.setRemoteDescription(offer);
            const answer = await state.pcB.createAnswer();
            await state.pcB.setLocalDescription(answer);
            await state.pcA.setRemoteDescription(answer);
            const opened = await globalThis.rtcB05.waitFor(
                () => state.channelA.readyState === 'open' && state.channelB()?.readyState === 'open'
            );
            return { opened, durationMs: performance.now() - startedAt };
        };
    });
}

async function installPageLifecycleClose(page) {
    await page.evaluate(() => {
        globalThis.rtcB05.sendAndClose = async (state, index) => {
            state.channelA.send(JSON.stringify({ index, ok: true }));
            await globalThis.rtcB05.waitFor(state.messageReceived);
            const startedAt = performance.now();
            state.channelA.close();
            const closed = await globalThis.rtcB05.waitFor(
                () => state.channelA.readyState === 'closed' && state.channelB()?.readyState === 'closed'
            );
            return { closed, durationMs: performance.now() - startedAt };
        };
    });
}

async function installPageLifecycleIteration(page) {
    await page.evaluate(() => {
        globalThis.rtcB05.runIteration = async (index, iterationIdPrefix) => {
            const state = globalThis.rtcB05.createIterationState(index);
            let opened = false;
            let closed = false;
            let openDurationMs = null;
            let closeDurationMs = null;
            let failure = null;
            try {
                const open = await globalThis.rtcB05.openChannels(state);
                opened = open.opened;
                openDurationMs = open.durationMs;
                if (opened) {
                    const close = await globalThis.rtcB05.sendAndClose(state, index);
                    closed = close.closed;
                    closeDurationMs = close.durationMs;
                }
            }
            catch (error) {
                failure = error instanceof Error ? error.message : String(error);
                state.events.push('iteration-error');
            }
            finally {
                if (state.channelA.readyState !== 'closed') {
                    state.channelA.close();
                }
                if (state.channelB() && state.channelB().readyState !== 'closed') {
                    state.channelB().close();
                }
                state.pcA.close();
                state.pcB.close();
                await new Promise((resolveTask) => setTimeout(resolveTask, 0));
            }
            return {
                index,
                iterationId: `${iterationIdPrefix}-iteration-${String(index).padStart(3, '0')}`,
                opened,
                closed,
                messageReceived: state.messageReceived(),
                events: state.events,
                localState: state.channelA.readyState,
                remoteState: state.channelB()?.readyState ?? 'missing',
                pcAState: state.pcA.connectionState,
                pcBState: state.pcB.connectionState,
                openDurationMs,
                closeDurationMs,
                failure
            };
        };
    });
}

async function runPageLifecycle(page, input) {
    return page.evaluate(async ({ iterationCount, iterationIdPrefix }) => {
        const results = [];
        try {
            for (let index = 1; index <= iterationCount; index += 1) {
                results.push(await globalThis.rtcB05.runIteration(index, iterationIdPrefix));
            }
            return {
                iterations: iterationCount,
                results,
                openedCount: results.filter(({ opened }) => opened).length,
                closedCount: results.filter(({ closed }) => closed).length,
                messageReceivedCount: results.filter(({ messageReceived }) => messageReceived).length,
                localErrorCount: results.filter(({ events }) => events.includes('local-error')).length,
                remoteErrorCount: results.filter(({ events }) => events.includes('remote-error')).length
            };
        }
        finally {
            delete globalThis.rtcB05;
        }
    }, input);
}

function createAcceptedSample({ command, context, measurement, argumentsList, createdAt }) {
    const sampleIdentity = {
        sampleId: context.outerAttempt.sampleIds[0],
        workloadId: WORKLOAD_ID,
        caseId: CASE_ID,
        inputKey: INPUT_KEY,
        intendedPhase: command.intendedPhase,
        outerOrdinal: command.outerOrdinal,
        innerOrdinal: 1
    };
    const identity = {
        baselineId: command.baselineId,
        workloadId: WORKLOAD_ID,
        caseId: CASE_ID,
        inputKey: INPUT_KEY,
        intendedPhase: command.intendedPhase,
        outerOrdinal: command.outerOrdinal
    };
    return computeRtcDataChannelBrowserSoakSample(
        {
            schema: 'rallar.rtc-baseline.sample.v1',
            identity: sampleIdentity,
            outcome: 'not-run',
            evidenceClass: 'native-browser',
            metrics: [],
            rawEvidence: {
                createdAt,
                identity,
                input: { iterations: ACCEPTED_ITERATIONS },
                producerCommand: {
                    executable: 'node',
                    arguments: [SCRIPT_PATH, ...argumentsList]
                },
                ...measurement
            },
            rawReferences: [],
            issues: [],
            runtimeObservation: context.runtimeObservation
        },
        command.baselineId
    );
}

function toExternalAttempt({ command, context, measurement, argumentsList, createdAt }) {
    const sample = createAcceptedSample({
        command,
        context,
        measurement,
        argumentsList,
        createdAt
    });
    return {
        schema: 'rallar.rtc-baseline.external-attempt.v1',
        locator: {
            workloadId: WORKLOAD_ID,
            caseId: CASE_ID,
            inputKey: INPUT_KEY,
            environmentId: ENVIRONMENT_ID,
            intendedPhase: command.intendedPhase,
            outerOrdinal: command.outerOrdinal,
            rawResultRelativePath: command.rawResultRelativePath
        },
        producerExitStatus: 0,
        producerFacts: {
            databaseUrl: 'absent',
            allScenariosPresent: false,
            allScenariosRaw: null,
            retentionSoakPresent: false,
            retentionSoakRaw: null,
            retentionCyclesPresent: false,
            retentionCyclesRaw: null,
            iceModePresent: false,
            iceModeRaw: null
        },
        sampleOutcomes: [{ identity: sample.identity, outcome: sample.outcome, issues: sample.issues }],
        samples: [sample],
        issues: sample.issues
    };
}

function writeJson(path, value, createNew) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: createNew ? 'wx' : 'w'
    });
}

export async function runRtcDataChannelBrowserSoakCli(argumentsList, overrides = {}) {
    const parsedCommand = parseCommand(argumentsList);
    if (parsedCommand.left !== undefined) {
        throw toCliAdmissionError(parsedCommand.left);
    }
    const command = parsedCommand.right;
    const dependencies = {
        baselineRootPath: overrides.baselineRootPath ?? DEFAULT_BASELINE_ROOT,
        launchBrowser: overrides.launchBrowser ?? ((options) => chromium.launch(options)),
        nowUtc: overrides.nowUtc ?? (() => new Date().toISOString())
    };
    if (command.mode === 'diagnostic') {
        const measurement = await measureBrowserLifecycle(
            command.iterations,
            'diagnostic',
            dependencies
        );
        const output = {
            createdAt: dependencies.nowUtc(),
            input: { iterations: command.iterations },
            ...measurement
        };
        mkdirSync(dirname(command.outputPath), { recursive: true });
        writeJson(command.outputPath, output, false);
        return { mode: command.mode, outputPath: command.outputPath, output };
    }
    const captureContext = readRawCaptureContext(command, dependencies.baselineRootPath);
    if (captureContext.left !== undefined) {
        throw toCliAdmissionError(captureContext.left);
    }
    const context = captureContext.right;
    const measurement = await measureBrowserLifecycle(
        ACCEPTED_ITERATIONS,
        context.outerAttempt.sampleIds[0],
        dependencies
    );
    const createdAt = dependencies.nowUtc();
    const output = toExternalAttempt({
        command,
        context,
        measurement,
        argumentsList,
        createdAt
    });
    writeJson(context.outputPath, output, true);
    return { mode: command.mode, outputPath: context.outputPath, output };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
    try {
        const result = await runRtcDataChannelBrowserSoakCli(process.argv.slice(2));
        console.log(`Wrote ${result.outputPath}`);
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
