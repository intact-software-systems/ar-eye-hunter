import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import {
    createRtcB06LiveProducerCommand,
    createRtcB06ObservationDenoRuntime,
    runRtcB06LiveProducer,
    type RtcB06ObservationDenoRuntimeInput
} from '../../../baseline/observation/rtc-b06-observation-deno-runtime.ts';
import { createDenoRtcBaselineAdapters } from '../../../baseline/runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoPort } from '../../../baseline/runtime/rtc-baseline-deno-port.ts';
import { createRtcBaselineDenoRuntime } from '../../../baseline/runtime/rtc-baseline-deno-runtime.ts';
import { createRtcBaselineDenoObservation } from '../../../baseline/runtime/rtc-baseline-runtime-observation.ts';

const baselineId = '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3';

function attempt(caseId: 'default' | 'all-scenarios' | 'retention-100') {
    return {
        workloadId: 'RTC-B06' as const,
        caseId,
        inputKey: `e3-memory-${caseId}`,
        intendedPhase: 'retained' as const,
        outerOrdinal: 2,
        environmentId: 'E3-memory' as const,
        rawResultRelativePath: `artifacts/staging/rtc-b06-${caseId}-e3-memory-${caseId}-retained-002.json`
    };
}

describe('governed RTC-B06 producer evidence', () => {
    it.each(['private-root', 'intermediate-parent'] as const)('refuses a %s symlink before private allocation or child launch', async (location) => {
        const repositoryRoot = await mkdtemp(join(tmpdir(), 'rtc-allocation-repo-'));
        const external = await mkdtemp(join(tmpdir(), 'rtc-allocation-external-'));
        onTestFinished(async () => {
            await rm(repositoryRoot, { recursive: true, force: true });
            await rm(external, { recursive: true, force: true });
        });
        await writeFile(join(external, 'sentinel.txt'), 'outside stays untouched');
        const privateRoot = join(repositoryRoot, 'tmp/perf/rtc-b06-private-build');
        const link = location === 'private-root' ? privateRoot : join(privateRoot, baselineId, 'default');
        await mkdir(join(link, '..'), { recursive: true });
        await symlink(external, link);
        const events: string[] = [];
        let launched = false;
        const runtime = {
            ...filesystemProducerRuntime(events),
            command: async () => {
                launched = true;
                return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
            }
        };
        await expect(
            runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
                repositoryRoot,
                baselineId,
                attempt: attempt('default')
            })
        ).rejects.toThrow();
        expect(launched).toBe(false);
        expect(events.filter((event) => event.includes('/retained-2') && event.includes('rtc-b06-private-build'))).toEqual([]);
        expect(await readdir(external)).toEqual(['sentinel.txt']);
        expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('outside stays untouched');
    });

    it.each([0, 9])('creates and cleans a confined fresh real build leaf after injected child exit %s', async (code) => {
        const repositoryRoot = await mkdtemp(join(tmpdir(), 'rtc-allocation-repo-'));
        onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
        const buildRoot = join(repositoryRoot, 'tmp/perf/rtc-b06-private-build', baselineId, 'default/retained-2');
        const events: string[] = [];
        const runtime = {
            ...filesystemProducerRuntime(events),
            command: async () => {
                expect(JSON.parse(await readFile(join(buildRoot, 'owner.json'), 'utf8'))).toEqual({ baselineId, attempt: attempt('default') });
                expect(await readdir(join(buildRoot, 'output'))).toEqual([]);
                events.push('child-exited');
                return { code, stdout: new Uint8Array(), stderr: new Uint8Array() };
            }
        };
        expect(
            await runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
                repositoryRoot,
                baselineId,
                attempt: attempt('default')
            })
        ).toEqual({ exitStatus: code });
        expect(events.at(-1)).toBe(`remove:${buildRoot}`);
        expect(events.indexOf('child-exited')).toBeLessThan(events.indexOf(`remove:${buildRoot}`));
        await expect(lstat(buildRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves an occupied real unowned leaf without writing ownership or launching/removing it', async () => {
        const repositoryRoot = await mkdtemp(join(tmpdir(), 'rtc-allocation-repo-'));
        onTestFinished(() => rm(repositoryRoot, { recursive: true, force: true }));
        const buildRoot = join(repositoryRoot, 'tmp/perf/rtc-b06-private-build', baselineId, 'default/retained-2');
        await mkdir(buildRoot, { recursive: true });
        await writeFile(join(buildRoot, 'sentinel.txt'), 'unowned stays untouched');
        const events: string[] = [];
        let launched = false;
        const runtime = {
            ...filesystemProducerRuntime(events),
            command: async () => {
                launched = true;
                return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
            }
        };
        await expect(
            runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
                repositoryRoot,
                baselineId,
                attempt: attempt('default')
            })
        ).rejects.toThrow();
        expect(launched).toBe(false);
        expect(events.filter((event) => event.startsWith('remove:') || event.startsWith('write:'))).toEqual([]);
        expect(await readdir(buildRoot)).toEqual(['sentinel.txt']);
        expect(await readFile(join(buildRoot, 'sentinel.txt'), 'utf8')).toBe('unowned stays untouched');
    });

    it.each(['ancestor', 'leaf', 'leaf-directory'] as const)('refuses cleanup through a replaced %s after the injected child exits', async (replacement) => {
        const repositoryRoot = await mkdtemp(join(tmpdir(), 'rtc-allocation-repo-'));
        const external = await mkdtemp(join(tmpdir(), 'rtc-allocation-external-'));
        onTestFinished(async () => {
            await rm(repositoryRoot, { recursive: true, force: true });
            await rm(external, { recursive: true, force: true });
        });
        await writeFile(join(external, 'sentinel.txt'), 'outside stays untouched');
        const privateRoot = join(repositoryRoot, 'tmp/perf/rtc-b06-private-build');
        const buildRoot = join(privateRoot, baselineId, 'default/retained-2');
        const replaced = replacement === 'ancestor' ? privateRoot : buildRoot;
        const events: string[] = [];
        const runtime = {
            ...filesystemProducerRuntime(events),
            command: async () => {
                await rename(replaced, `${replaced}-original`);
                if (replacement === 'leaf-directory') {
                    await mkdir(replaced);
                    await writeFile(join(replaced, 'sentinel.txt'), 'unowned replacement');
                }
                else {
                    await symlink(external, replaced);
                }
                return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
            }
        };
        await expect(
            runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
                repositoryRoot,
                baselineId,
                attempt: attempt('default')
            })
        ).rejects.toThrow(replacement === 'leaf-directory' ? 'ownership changed' : 'not confined');
        expect(events.filter((event) => event.startsWith('remove:'))).toEqual([]);
        if (replacement === 'leaf-directory') {
            expect(await readFile(join(replaced, 'sentinel.txt'), 'utf8')).toBe('unowned replacement');
        }
        expect(await readdir(external)).toEqual(['sentinel.txt']);
        expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('outside stays untouched');
    });

    it('allocates an exclusive private build before the original environment-resolving child', async () => {
        const allocated: string[] = [];
        let arguments_: readonly string[] = [];
        await runRtcB06LiveProducer(
            {
                ...producerRuntime(),
                mkdir: async (path, options) => {
                    if (!options.recursive) {
                        allocated.push(path);
                    }
                },
                command: async (_executable, args) => {
                    arguments_ = args;
                    return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
                }
            },
            { writeStdout: async () => {}, writeStderr: async () => {} },
            {
                repositoryRoot: '/repository',
                baselineId,
                attempt: attempt('default')
            }
        );
        const buildRoot = `/repository/tmp/perf/rtc-b06-private-build/${baselineId}/default/retained-2`;
        expect(allocated).toContain(buildRoot);
        expect(arguments_).toContain(`RALLAR_BLACK_BOX_RTC_BUILD_ROOT=${buildRoot}`);
        expect(arguments_).toContain('NODE_ENV=production');
        expect(arguments_).toContain('npm_config_loglevel=silent');
    });

    it.each([0, 9])('removes only the owned private build after the original child exits with %s', async (code) => {
        const events: string[] = [];
        const result = await runRtcB06LiveProducer(
            {
                ...producerRuntime(),
                command: async () => {
                    events.push('child-exited');
                    return { code, stdout: new Uint8Array(), stderr: new Uint8Array() };
                },
                remove: async (path, options) => {
                    events.push(path);
                    expect(options.recursive).toBe(true);
                }
            },
            { writeStdout: async () => {}, writeStderr: async () => {} },
            {
                repositoryRoot: '/repository',
                baselineId,
                attempt: attempt('default')
            }
        );
        expect(result.exitStatus).toBe(code);
        expect(events).toEqual(['child-exited', `/repository/tmp/perf/rtc-b06-private-build/${baselineId}/default/retained-2`]);
    });

    it('cannot launch or remove an occupied private build root', async () => {
        let launched = false;
        const removed: string[] = [];
        const runtime = {
            ...producerRuntime(),
            mkdir: async (path: string) => {
                if (path.endsWith('/default/retained-2') && path.includes('/rtc-b06-private-build/')) {
                    throw new Error('occupied');
                }
            },
            command: async () => {
                launched = true;
                return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
            },
            remove: async (path: string) => {
                removed.push(path);
            }
        };
        await expect(
            runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
                repositoryRoot: '/repository',
                baselineId,
                attempt: attempt('default')
            })
        ).rejects.toThrow('occupied');
        expect(launched).toBe(false);
        expect(removed).toEqual([]);
    });

    it('retains an explicit launch failure log when the producer cannot start', async () => {
        const files = new Map<string, Uint8Array>();
        const runtime = {
            ...producerRuntime(),
            writeFile: async (path: string, bytes: Uint8Array) => {
                files.set(path, bytes);
            },
            command: async () => {
                throw new Error('spawn failed');
            }
        };
        await expect(
            runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
                repositoryRoot: '/repository',
                baselineId,
                attempt: attempt('default')
            })
        )
            .resolves.toEqual({ exitStatus: 1 });
        expect([...files].filter(([path]) => path.endsWith('.log')).map(([, bytes]) => new TextDecoder().decode(bytes))).toEqual(['', 'spawn failed']);
    });

    it.each([0, 9])('isolates recorder storage and preserves raw attempt output on exit %s', async (code) => {
        const files = new Map<string, Uint8Array>();
        const directories: string[] = [];
        let arguments_: readonly string[] = [];
        const runtime = {
            ...producerRuntime(),
            mkdir: async (path: string) => {
                directories.push(path);
            },
            writeFile: async (path: string, bytes: Uint8Array) => {
                files.set(path, bytes);
            },
            command: async (_executable: string, args: readonly string[]) => {
                arguments_ = args;
                return { code, stdout: new TextEncoder().encode('raw stdout'), stderr: new TextEncoder().encode('raw stderr') };
            }
        };
        const result = await runRtcB06LiveProducer(runtime, { writeStdout: async () => {}, writeStderr: async () => {} }, {
            repositoryRoot: '/repository',
            baselineId,
            attempt: attempt('default'),
            rtcCaptureMode: 'native'
        });
        expect(result).toEqual({ exitStatus: code });
        expect([...files].filter(([path]) => path.endsWith('.log')).map(([path, bytes]) => [path.split('/').at(-1), new TextDecoder().decode(bytes)])).toEqual([
            ['stdout.log', 'raw stdout'],
            [
                'stderr.log',
                'raw stderr'
            ]
        ]);
        expect(arguments_).toContain('--retries=0');
        expect(arguments_.some((arg) => arg.startsWith('--output=/repository/tmp/perf/rtc-b06-producer/'))).toBe(true);
        const storage = arguments_.find((arg) => arg.startsWith('RALLAR_BLACK_BOX_STORAGE_DIR='))?.split('=')[1];
        expect(storage).toBe(`/repository/tmp/perf/rtc-b06-recorder/${baselineId}/default/retained-2`);
        expect(directories).toContain(storage);
    });
});

describe('RTC-B06 observation Deno runtime', () => {
    it.each(
        [
            [undefined, 'signaling'],
            ['off', 'off'],
            ['signaling', 'signaling'],
            ['native', 'native']
        ] as const
    )('seals producer capture %s against inherited Native capture', (rtcCaptureMode, expectedMode) => {
        const input = { repositoryRoot: '/repository', baselineId, attempt: attempt('default'), rtcCaptureMode };
        const command = createRtcB06LiveProducerCommand(input);
        const observedMode = execFileSync(command.executable, [
            ...command.arguments.slice(0, command.arguments.indexOf('npm')),
            process.execPath,
            '--eval',
            `process.stdout.write(JSON.stringify(Object.fromEntries(['RALLAR_BLACK_BOX_RTC_CAPTURE_MODE','DATABASE_URL','RALLAR_ICE_MODE','RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS','RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK','RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES'].map(name => [name, process.env[name] ?? null]))))`
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'native',
                DATABASE_URL: 'inherited',
                RALLAR_ICE_MODE: 'inherited',
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: 'inherited',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: 'inherited',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '999'
            }
        });

        expect(JSON.parse(observedMode)).toEqual({
            RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: expectedMode,
            DATABASE_URL: null,
            RALLAR_ICE_MODE: null,
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: null,
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: null,
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: null
        });
    });

    it.each([['default', '20'], ['all-scenarios', '20'], ['retention-100', '101']] as const)(
        'seals the %s child budget against inherited ICE input',
        (caseId, expectedRequests) => {
            const command = createRtcB06LiveProducerCommand({ repositoryRoot: '/repository', baselineId, attempt: attempt(caseId) });
            const child = execFileSync(command.executable, [
                ...command.arguments.slice(0, command.arguments.indexOf('npm')),
                process.execPath,
                '--eval',
                'process.stdout.write(process.env.RALLAR_ICE_RATE_LIMIT_REQUESTS ?? "unset")'
            ], { encoding: 'utf8', env: { ...process.env, RALLAR_ICE_RATE_LIMIT_REQUESTS: '999' } });
            expect(child).toBe(expectedRequests);
        }
    );

    it('records the finite case policies and hashes their real configuration owners in the existing observation', async () => {
        const adapters = createDenoRtcBaselineAdapters(producerRuntime());
        adapters.environment.readAllowlisted = () => ({
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
        });
        adapters.runtimeHost.read = async () => ({
            os: 'darwin',
            kernel: '24.6.0',
            architecture: 'arm64',
            logicalCpuCount: 10,
            cpuModel: 'Apple M4',
            totalMemoryBytes: 1,
            deno: '2.9.5',
            executionContext: 'local'
        });
        adapters.sourceConfigHashing.read = async (files) => ({
            ok: true,
            value: await Promise.all(files.map(async ({ path, kind }) => ({
                path,
                kind,
                sha256: createHash('sha256').update(await readFile(path)).digest('hex')
            })))
        });
        const observe = createRtcBaselineDenoObservation(adapters);
        const result = await observe({
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId,
            workloadIds: ['RTC-B06'],
            environmentId: 'E3-memory',
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: []
        });
        if (!result.ok) {
            throw new Error(JSON.stringify(result.issues));
        }
        expect(result.ok).toBe(true);
        expect(result.value.resolvedConfiguration.filter((entry) => entry.field === 'appServingMode').map((entry) => entry.value))
            .toEqual(['production', 'production', 'production']);
        for (
            const path of [
                'package.json',
                'package-lock.json',
                'apps/rallar-black-box/package.json',
                'apps/rallar-black-box/vite.config.ts',
                'node_modules/vite/package.json'
            ]
        ) {
            expect(result.value.sourceHashes.some((entry) => entry.path === path)).toBe(true);
        }

        expect(
            result.value.resolvedConfiguration.filter((entry) => entry.field.startsWith('iceRateLimit')).map((
                entry
            ) => [entry.caseKey.caseId, entry.field, entry.value, entry.source])
        ).toEqual([
            ['default', 'iceRateLimitRequests', 20, 'default'],
            ['default', 'iceRateLimitWindowMs', 60_000, 'default'],
            ['all-scenarios', 'iceRateLimitRequests', 20, 'default'],
            ['all-scenarios', 'iceRateLimitWindowMs', 60_000, 'default'],
            ['retention-100', 'iceRateLimitRequests', 101, 'default'],
            ['retention-100', 'iceRateLimitWindowMs', 60_000, 'default']
        ]);
        for (
            const path of [
                'apps/api-v1/resources/configuration/defaults-config.json',
                'apps/api-v1/resources/configuration/prod-in-memory-config.json',
                'apps/api-v1/src/configuration/read-api-v1-configuration-environment.ts',
                'apps/api-v1/src/configuration/decode-api-v1-configuration-source.ts',
                'apps/api-v1/src/configuration/read-api-v1-configuration.ts',
                'apps/rallar-black-box/playwright-full-stack-api-server.ts',
                'tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts',
                'apps/rallar-black-box/playwright.full-stack.config.ts',
                'packages/shared-rtc-bench/baseline/observation/rtc-b06-observation-deno-runtime.ts',
                'packages/shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts',
                'packages/shared-test/black-box-runner/fixtures/read-full-stack-rtc-ice-fixture-requests.ts'
            ]
        ) {
            expect(result.value.sourceHashes.find((entry) => entry.path === path)?.sha256).toBe(
                createHash('sha256').update(await readFile(path)).digest('hex')
            );
        }
        expect(JSON.parse(JSON.stringify(result.value)).resolvedConfiguration).toEqual(result.value.resolvedConfiguration);
    });

    it('keeps one admitted producer mode across cases, phases, ordinals and a repeat after caller mutation', async () => {
        const observed: string[] = [];
        const port = producerRuntime();
        const adapters = createDenoRtcBaselineAdapters(port);
        const input: RtcB06ObservationDenoRuntimeInput = {
            repositoryRoot: '/repository',
            rtcCaptureMode: 'off',
            runtime: {
                ...port,
                command: async (_executable: string, arguments_: readonly string[]) => {
                    observed.push(arguments_.find((argument) => argument.startsWith('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE=')) ?? '<unset>');
                    return { code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
                }
            },
            producerOutput: { writeStdout: async () => {}, writeStderr: async () => {} },
            adapters,
            envelope: createRtcBaselineDenoRuntime(adapters)
        };
        const runtime = createRtcB06ObservationDenoRuntime(input);
        await runtime.runLiveRtcProducer({ baselineId, attempt: attempt('default') });
        Object.assign(input, { rtcCaptureMode: 'native' });
        for (const caseId of ['default', 'all-scenarios', 'retention-100'] as const) {
            await runtime.runLiveRtcProducer({
                baselineId: `${baselineId}-repeat-01`,
                attempt: { ...attempt(caseId), intendedPhase: 'warmup', outerOrdinal: 1 }
            });
        }
        expect(observed).toEqual(Array(4).fill('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE=off'));
    });

    it('publishes captured producer output when the live matrix fails', async () => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const result = await runRtcB06LiveProducer(
            {
                ...producerRuntime(),
                command: async () => ({
                    code: 1,
                    stdout: new TextEncoder().encode('playwright failure\n'),
                    stderr: new TextEncoder().encode('receiver timed out\n')
                })
            },
            {
                writeStdout: async (bytes) => {
                    stdout.push(new TextDecoder().decode(bytes));
                },
                writeStderr: async (bytes) => {
                    stderr.push(new TextDecoder().decode(bytes));
                }
            },
            { repositoryRoot: '/repository', baselineId, attempt: attempt('default') }
        );

        expect(result).toEqual({ exitStatus: 1 });
        expect(stdout).toEqual(['playwright failure\n']);
        expect(stderr).toEqual([
            'RTC-B06 producer failed for default/retained/2 with exit status 1.\n',
            'receiver timed out\n'
        ]);
    });

    it('does not publish captured producer output from a successful matrix', async () => {
        const writes: Uint8Array[] = [];
        const result = await runRtcB06LiveProducer(
            {
                ...producerRuntime(),
                command: async () => ({
                    code: 0,
                    stdout: new TextEncoder().encode('normal output\n'),
                    stderr: new Uint8Array()
                })
            },
            {
                writeStdout: async (bytes) => {
                    writes.push(bytes);
                },
                writeStderr: async (bytes) => {
                    writes.push(bytes);
                }
            },
            { repositoryRoot: '/repository', baselineId, attempt: attempt('default') }
        );

        expect(result).toEqual({ exitStatus: 0 });
        expect(writes).toEqual([]);
    });

    it('enables only the all-scenarios flag for that case', () => {
        const command = createRtcB06LiveProducerCommand({
            repositoryRoot: '/repository',
            baselineId,
            attempt: attempt('all-scenarios')
        });

        expect(command.arguments).toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1');
        expect(command.arguments).not.toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1');
        expect(command.arguments).not.toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100');
        expect(command.arguments).toContain(
            'RALLAR_BLACK_BOX_RTC_INPUT_KEY=e3-memory-all-scenarios'
        );
    });

    it('enables exactly the governed 100-cycle retention configuration', () => {
        const command = createRtcB06LiveProducerCommand({
            repositoryRoot: '/repository',
            baselineId,
            attempt: attempt('retention-100')
        });

        expect(command.arguments).not.toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1');
        expect(command.arguments).toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1');
        expect(command.arguments).toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100');
        expect(command.arguments).toContain(
            'RALLAR_BLACK_BOX_RTC_CASE_ID=retention-100'
        );
    });
});

function producerRuntime(): RtcBaselineDenoPort {
    return {
        envGet: () => undefined,
        build: { os: 'darwin', arch: 'arm64' },
        version: { deno: '2' },
        pid: 1,
        hostname: () => 'test',
        randomUuid: () => 'test',
        kill: () => {},
        lstat: async (path) => ({
            isFile: !path.startsWith('/repository'),
            isDirectory: path.startsWith('/repository'),
            isSymlink: false,
            dev: 1,
            ino: 1,
            size: 1
        }),
        open: async () => {
            throw new Error('No files may be opened by producer command construction');
        },
        mkdir: async () => {},
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        remove: async () => {},
        readDir: async function* () {},
        command: async () => ({ code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
        now: () => new Date('2026-08-16T10:00:00Z'),
        performanceNow: () => 0,
        systemMemoryInfo: () => ({ total: 1 }),
        availableParallelism: () => 1
    };
}

function filesystemProducerRuntime(events: string[]): RtcBaselineDenoPort {
    class NotFound extends Error {}
    return {
        ...producerRuntime(),
        errors: { NotFound },
        lstat: async (path) => {
            try {
                const info = await lstat(path);
                return {
                    isFile: info.isFile(),
                    isDirectory: info.isDirectory(),
                    isSymlink: info.isSymbolicLink(),
                    dev: info.dev,
                    ino: info.ino,
                    size: info.size
                };
            }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                    throw new NotFound();
                }
                throw error;
            }
        },
        mkdir: async (path, options) => {
            events.push(`mkdir:${path}`);
            await mkdir(path, options);
        },
        writeFile: async (path, bytes, options) => {
            events.push(`write:${path}`);
            await writeFile(path, bytes, { flag: options.createNew ? 'wx' : 'w' });
        },
        remove: async (path, options) => {
            events.push(`remove:${path}`);
            await rm(path, options);
        }
    };
}
