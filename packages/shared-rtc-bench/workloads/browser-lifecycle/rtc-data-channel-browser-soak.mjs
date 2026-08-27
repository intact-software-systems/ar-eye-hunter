import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

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

function fail(message) {
    throw new Error(`RTC-B05: ${message}`);
}

function readOptions(argumentsList) {
    const options = new Map();
    for (const [index, argument] of argumentsList.entries()) {
        if (!argument.startsWith('--') || !argument.includes('=')) {
            fail(`argument ${index + 1} must use --name=value syntax`);
        }
        const separator = argument.indexOf('=');
        const name = argument.slice(2, separator);
        if (options.has(name)) {
            fail(`option --${name} may appear only once`);
        }
        options.set(name, argument.slice(separator + 1));
    }
    return options;
}

function requiredOption(options, name) {
    const value = options.get(name);
    if (value === undefined || value.length === 0) {
        fail(`option --${name} is required`);
    }
    return value;
}

function boundedInteger({ value, name, minimum, maximum }) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        fail(`option --${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
}

function parseDiagnosticCommand(options) {
    const iterations = boundedInteger({
        value: options.get('iterations') ?? '25',
        name: 'iterations',
        minimum: 1,
        maximum: 10_000
    });
    return {
        mode: 'diagnostic',
        iterations,
        outputPath: options.get('out') ?? DEFAULT_DIAGNOSTIC_OUT
    };
}

function parseRawEvidenceCommand(options) {
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
            fail(`option --${name} cannot override the accepted raw-evidence workload`);
        }
    }
    const baselineId = requiredOption(options, 'baseline-id');
    if (!isRtcBrowserBaselineId(baselineId)) {
        fail('baseline ID does not match the accepted E2 browser grammar');
    }
    const intendedPhase = requiredOption(options, 'intended-phase');
    if (intendedPhase !== 'warmup' && intendedPhase !== 'retained') {
        fail('option --intended-phase must be warmup or retained');
    }
    return {
        mode: 'raw-evidence',
        baselineId,
        caseId: requiredOption(options, 'case-id'),
        inputKey: requiredOption(options, 'input-key'),
        intendedPhase,
        outerOrdinal: boundedInteger({
            value: requiredOption(options, 'outer-ordinal'),
            name: 'outer-ordinal',
            minimum: 1,
            maximum: 999
        }),
        rawResultRelativePath: requiredOption(options, 'out')
    };
}

function parseCommand(argumentsList) {
    const options = readOptions(argumentsList);
    return options.get('capture') === 'raw-evidence'
        ? parseRawEvidenceCommand(options)
        : parseDiagnosticCommand(options);
}

function pad(value) {
    return String(value).padStart(3, '0');
}

function acceptedSampleId(intendedPhase, outerOrdinal) {
    return [
        'rtc-b05-browser-data-channel-lifecycle-iterations-25',
        intendedPhase,
        pad(outerOrdinal),
        '001'
    ].join('-');
}

function acceptedRawRelativePath(intendedPhase, outerOrdinal) {
    return [
        'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25',
        intendedPhase,
        `${pad(outerOrdinal)}.json`
    ].join('-');
}

function expectedOuterAttempts(retainedSampleMultiplier) {
    const retainedCount = retainedSampleMultiplier === 1 ? 5 : 10;
    const attempt = (intendedPhase, outerOrdinal) => ({
        workloadId: WORKLOAD_ID,
        caseId: CASE_ID,
        inputKey: INPUT_KEY,
        environmentId: ENVIRONMENT_ID,
        intendedPhase,
        outerOrdinal,
        sampleIds: [acceptedSampleId(intendedPhase, outerOrdinal)]
    });
    return [
        attempt('warmup', 1),
        ...Array.from({ length: retainedCount }, (_, index) => attempt('retained', index + 1))
    ];
}

function readJson(path, artifactName) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        fail(
            `${artifactName} could not be read as JSON: ${error instanceof Error ? error.message : error}`
        );
    }
}

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function validateRepeatContract(manifest, baselineId) {
    const repeat = baselineId.endsWith('-repeat-01');
    const multiplier = manifest.request?.retainedSampleMultiplier;
    if (multiplier !== (repeat ? 2 : 1)) {
        fail('manifest retained-sample multiplier does not match the baseline identity');
    }
    const repeatLink = manifest.request?.repeatLink;
    if (!repeat && repeatLink !== null) {
        fail('primary manifest must not contain a repeat link');
    }
    if (
        repeat &&
        (repeatLink?.primaryBaselineId !== baselineId.replace(/-repeat-01$/, '') ||
            !/^[0-9a-f]{64}$/.test(repeatLink?.primarySummarySha256 ?? ''))
    ) {
        fail('repeat manifest must link to the exact primary summary');
    }
    if (!same(manifest.repeatLink, repeatLink)) {
        fail('manifest repeat link differs from its request');
    }
    return multiplier;
}

function validateManifest(manifest, command) {
    const request = manifest.request;
    if (
        manifest.schema !== 'rallar.rtc-baseline.manifest.v1' ||
        request?.schema !== 'rallar.rtc-baseline.capture-request.v1' ||
        request.baselineId !== command.baselineId ||
        request.environmentId !== ENVIRONMENT_ID
    ) {
        fail('manifest identity does not match the raw-evidence command');
    }
    if (
        !same(request.workloadIds, [WORKLOAD_ID]) ||
        !same(manifest.workloadIds, [WORKLOAD_ID]) ||
        !same(manifest.cases, [{ workloadId: WORKLOAD_ID, caseId: CASE_ID, inputKey: INPUT_KEY }]) ||
        !same(request.conditionalEnvironmentDecisions, []) ||
        !same(manifest.expectedCohorts, [])
    ) {
        fail('manifest changes the immutable RTC-B05 workload');
    }
    const multiplier = validateRepeatContract(manifest, command.baselineId);
    if (!same(manifest.outerAttempts, expectedOuterAttempts(multiplier))) {
        fail('manifest outer process identities differ from the accepted RTC-B05 matrix');
    }
    const outerAttempt = manifest.outerAttempts.find(
        (entry) =>
            entry.workloadId === WORKLOAD_ID &&
            entry.caseId === command.caseId &&
            entry.inputKey === command.inputKey &&
            entry.intendedPhase === command.intendedPhase &&
            entry.outerOrdinal === command.outerOrdinal
    );
    if (!outerAttempt) {
        fail('manifest does not predeclare the requested RTC-B05 outer process identity');
    }
    return outerAttempt;
}

function validateEnvironment(environment, manifest) {
    if (
        environment.schema !== 'rallar.rtc-baseline.environment.v1' ||
        environment.baselineId !== manifest.request.baselineId ||
        environment.environmentId !== ENVIRONMENT_ID ||
        !same(environment.workloadIds, [WORKLOAD_ID]) ||
        !same(environment.repeatLink, manifest.repeatLink) ||
        !same(environment.conditionalEnvironmentDecisions, []) ||
        environment.observation === null
    ) {
        fail('environment identity does not match the immutable manifest');
    }
    const observation = environment.observation;
    const issues = validateRtcDataChannelBrowserSoakRuntimeObservation(
        observation,
        manifest.request.baselineId
    );
    if (issues.length > 0) {
        fail(`environment changes the accepted RTC-B05 configuration or provenance: ${issues[0].code}`);
    }
    return observation;
}

function assertDirectory(path, label) {
    if (!existsSync(path)) {
        fail(`${label} directory does not exist`);
    }
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
        fail(`${label} must be a non-symlink directory`);
    }
}

function readRawCaptureContext(command, baselineRootPath) {
    const baselinePath = join(baselineRootPath, command.baselineId);
    assertDirectory(baselineRootPath, 'baseline root');
    assertDirectory(baselinePath, 'baseline');
    assertDirectory(join(baselinePath, 'artifacts'), 'artifact');
    assertDirectory(join(baselinePath, 'artifacts/staging'), 'staging');
    const manifest = readJson(join(baselinePath, 'manifest.json'), 'manifest');
    const outerAttempt = validateManifest(manifest, command);
    const expectedRelativePath = acceptedRawRelativePath(
        outerAttempt.intendedPhase,
        outerAttempt.outerOrdinal
    );
    if (command.rawResultRelativePath !== expectedRelativePath) {
        fail(`raw output path must equal ${expectedRelativePath}`);
    }
    const outputPath = join(baselinePath, expectedRelativePath);
    if (existsSync(outputPath)) {
        fail(`raw output already exists at ${expectedRelativePath}`);
    }
    const environment = readJson(join(baselinePath, 'environment.json'), 'environment');
    return {
        outerAttempt,
        outputPath,
        runtimeObservation: validateEnvironment(environment, manifest)
    };
}

async function measureBrowserLifecycle(iterations, iterationIdPrefix, dependencies) {
    const browser = await dependencies.launchBrowser({ headless: true });
    try {
        const page = await browser.newPage();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        const readHeapUsed = async () => {
            await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
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

function createAcceptedSample({ command, context, measurement, argumentsList, nowUtc }) {
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
                createdAt: nowUtc(),
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

function toExternalAttempt({ command, context, measurement, argumentsList, nowUtc }) {
    const sample = createAcceptedSample({
        command,
        context,
        measurement,
        argumentsList,
        nowUtc
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
    const command = parseCommand(argumentsList);
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
    const context = readRawCaptureContext(command, dependencies.baselineRootPath);
    const measurement = await measureBrowserLifecycle(
        ACCEPTED_ITERATIONS,
        context.outerAttempt.sampleIds[0],
        dependencies
    );
    const output = toExternalAttempt({
        command,
        context,
        measurement,
        argumentsList,
        nowUtc: dependencies.nowUtc
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
