import { describe, expect, it, vi } from 'vitest';
import { createDenoRtcBaselineAdapters, type RtcBaselineDenoPort } from '../../../baseline/runtime/rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoObservation } from '../../../baseline/runtime/rtc-baseline-runtime-observation.ts';
function createRuntimeDouble() {
    const calls: string[] = [];
    const runtime: RtcBaselineDenoPort = {
        envGet: (name: string) => {
            calls.push(`env:${name}`);
            const values: Record<string, string> = { RTC_ALLOWED: 'yes', RALLAR_ICE_MODE: 'local' };
            return values[name];
        },
        build: { os: 'darwin', arch: 'aarch64' },
        version: { deno: '2.4.0' },
        pid: 321,
        hostname: () => 'runner-a',
        randomUuid: () => '00000000-0000-4000-8000-000000000001',
        kill: (processId: number, signal: number) => {
            calls.push(`kill:${processId}:${signal}`);
        },
        lstat: async (path: string) => {
            calls.push(`lstat:${path}`);
            return {
                isFile: true,
                isDirectory: false,
                isSymlink: false,
                dev: 10,
                ino: 20,
                size: 5
            };
        },
        open: async () => {
            throw new Error('unused');
        },
        mkdir: async (path: string, options?: { recursive?: boolean; }) => {
            calls.push(`mkdir:${path}:recursive=${String(options?.recursive)}`);
        },
        readFile: async (path: string) => {
            calls.push(`read:${path}`);
            return new TextEncoder().encode('bytes');
        },
        writeFile: async (path: string, _bytes: Uint8Array, options?: { createNew?: boolean; }) => {
            calls.push(`write:${path}:createNew=${String(options?.createNew)}`);
        },
        remove: async (path: string, options?: { recursive?: boolean; }) => {
            calls.push(`remove:${path}:recursive=${String(options?.recursive)}`);
        },
        readDir: async function* (path: string) {
            calls.push(`list:${path}`);
            yield { name: 'one', isFile: true, isDirectory: false, isSymlink: false };
        },
        command: async (executable: string, args: readonly string[]) => {
            calls.push(`run:${executable}:${args.join(',')}`);
            const stdout = executable === 'uname' ? '24.6.0\n' : executable === 'sysctl' ? 'Apple M4\n' : 'output\n';
            return { code: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() };
        },
        now: () => new Date('2026-08-07T10:00:00.000Z'),
        performanceNow: () => 123.5,
        systemMemoryInfo: () => ({ total: 17179869184 }),
        availableParallelism: () => 10,
        errors: {
            NotFound: class NotFound extends Error {},
            AlreadyExists: class AlreadyExists extends Error {},
            PermissionDenied: class PermissionDenied extends Error {}
        }
    };
    return {
        calls,
        runtime
    };
}
function captureRequest(environmentId: 'E1-local' | 'E5-remote') {
    const suffix = environmentId === 'E1-local' ? 'e1-local' : 'e5-remote';
    return {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId: `20260807-0123456789ab-${suffix}`,
        workloadIds: ['RTC-B01'] as const,
        environmentId,
        retainedSampleMultiplier: 1 as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    };
}
describe('RTC baseline Deno adapters', () => {
    it('provides local writer identity and conservative Deno process liveness', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);

        expect(adapters.writerLockRuntime.createOwnerToken()).toBe(
            '00000000-0000-4000-8000-000000000001'
        );
        expect(adapters.writerLockRuntime.readOwnerIdentity()).toEqual({
            hostname: 'runner-a',
            processId: 321
        });
        expect(await adapters.writerLockRuntime.readProcessLiveness(122)).toBe('alive');
        const NotFound = double.runtime.errors?.NotFound;
        if (!NotFound) {
            throw new Error('NotFound double is required.');
        }
        double.runtime.kill = () => {
            throw new NotFound();
        };
        expect(await adapters.writerLockRuntime.readProcessLiveness(123)).toBe('dead');
        double.runtime.kill = () => {
            throw new Error('unsupported signal probe');
        };
        expect(await adapters.writerLockRuntime.readProcessLiveness(124)).toBe('unknown');
        expect(double.calls).toContain('kill:122:0');
    });

    it('implements file, SHA-256, clock, runtime, host, and allowlisted environment adapters', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(double.calls).toEqual([]);
        expect(await adapters.filePort.readFile('/repo/value')).toEqual(
            new TextEncoder().encode('bytes')
        );
        expect(await adapters.sha256(new TextEncoder().encode('abc'))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        );
        expect(adapters.clock.nowUtc()).toBe('2026-08-07T10:00:00.000Z');
        expect(adapters.clock.monotonicNowMs()).toBe(123.5);
        expect(adapters.environment.readAllowlisted(['RTC_ALLOWED'])).toEqual({ RTC_ALLOWED: 'yes' });
        expect(double.calls.filter((call) => call.startsWith('env:'))).toEqual(['env:RTC_ALLOWED']);
        expect(await adapters.runtimeHost.read()).toEqual({
            deno: '2.4.0',
            os: 'darwin',
            kernel: '24.6.0',
            architecture: 'aarch64',
            logicalCpuCount: 10,
            cpuModel: 'Apple M4',
            totalMemoryBytes: 17179869184,
            executionContext: 'local'
        });
        expect(double.calls.filter((call) => call.startsWith('run:'))).toEqual([
            'run:uname:-r',
            'run:sysctl:-n,machdep.cpu.brand_string'
        ]);
    });
    it('reads branch and detached Git facts and preserves typed command failures', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(await adapters.git.readHeadCommit()).toEqual({ ok: true, value: 'output' });
        expect(await adapters.git.readHeadTree()).toEqual({ ok: true, value: 'output' });
        expect(await adapters.git.readRef()).toEqual({ ok: true, value: 'output' });
        expect(await adapters.git.readStatus()).toEqual({ ok: true, value: 'output\n' });
        expect(double.calls.filter((call) => call.startsWith('run:git:'))).toEqual([
            'run:git:rev-parse,HEAD',
            'run:git:rev-parse,HEAD^{tree}',
            'run:git:symbolic-ref,--short,-q,HEAD',
            'run:git:status,--porcelain=v1,--untracked-files=all'
        ]);
        const detachedDouble = createRuntimeDouble();
        detachedDouble.runtime.command = async (executable, arguments_) => {
            detachedDouble.calls.push(`run:${executable}:${arguments_.join(',')}`);
            return arguments_[0] === 'symbolic-ref'
                ? { code: 1, stdout: new Uint8Array(), stderr: new Uint8Array() }
                : {
                    code: 0,
                    stdout: new TextEncoder().encode(`${'a'.repeat(40)}\n`),
                    stderr: new Uint8Array()
                };
        };
        expect(await createDenoRtcBaselineAdapters(detachedDouble.runtime).git.readRef()).toEqual({
            ok: true,
            value: `detached@${'a'.repeat(40)}`
        });
        expect(detachedDouble.calls).toEqual([
            'run:git:symbolic-ref,--short,-q,HEAD',
            'run:git:rev-parse,HEAD'
        ]);
        const denied = await adapters.process.run({
            executable: 'bash',
            arguments: ['-lc', 'echo no']
        });
        expect(denied).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.executable',
                    code: 'executable-not-allowlisted',
                    message: 'Executable bash is not allowed by the RTC baseline protocol.'
                }
            ]
        });
        const failedDouble = createRuntimeDouble();
        failedDouble.runtime.command = async () => ({
            code: 5,
            stdout: new TextEncoder().encode('partial'),
            stderr: new TextEncoder().encode('bad ref')
        });
        const failed = createDenoRtcBaselineAdapters(failedDouble.runtime);
        expect(await failed.git.readHeadCommit()).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.process',
                    code: 'command-failed',
                    message: 'git exited with status 5.',
                    details: { exitStatus: 5, stdout: 'partial', stderr: 'bad ref' }
                }
            ]
        });
        failedDouble.runtime.command = async () => {
            throw new Error('git spawn denied');
        };
        expect(await failed.git.readHeadTree()).toEqual({
            ok: false,
            issues: [{ path: '$.process', code: 'command-threw', message: 'git spawn denied' }]
        });
    });
    it('hashes complete source and config files with literal path/kind provenance', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(
            await adapters.sourceConfigHashing.read([
                { path: 'scripts/perf/example.ts', kind: 'source' },
                { path: 'packages/shared-rtc-bench/deno.json', kind: 'config' }
            ])
        ).toEqual({
            ok: true,
            value: [
                {
                    path: 'scripts/perf/example.ts',
                    kind: 'source',
                    sha256: '277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9'
                },
                {
                    path: 'packages/shared-rtc-bench/deno.json',
                    kind: 'config',
                    sha256: '277089d91c0bdf4f2e6862ba7e4a07605119431f5d13f726dd352b06f1b206a9'
                }
            ]
        });
        expect(double.calls.filter((call) => call.startsWith('read:'))).toEqual([
            'read:scripts/perf/example.ts',
            'read:packages/shared-rtc-bench/deno.json'
        ]);
    });
    it('returns a typed source/config read failure without a partial hash list', async () => {
        const double = createRuntimeDouble();
        double.runtime.readFile = async (path) => {
            if (path === 'packages/shared-rtc-bench/deno.json') {
                throw new Error('config denied');
            }
            return new TextEncoder().encode('source');
        };
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(
            await adapters.sourceConfigHashing.read([
                { path: 'scripts/perf/example.ts', kind: 'source' },
                { path: 'packages/shared-rtc-bench/deno.json', kind: 'config' }
            ])
        ).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.files[1]',
                    code: 'file-read-failed',
                    message: 'config denied'
                }
            ]
        });
    });
    it('implements every filesystem operation with exact paths and typed failures', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        await adapters.filePort.inspectPath('/repo/a');
        await adapters.filePort.createDirectory('/repo/root', { recursive: true });
        await adapters.filePort.createDirectory('/repo/new', { recursive: false });
        await adapters.filePort.writeFileCreateNew('/repo/new/a', new Uint8Array([1]));
        await adapters.filePort.readFile('/repo/new/a');
        await adapters.filePort.removeFile('/repo/new/a');
        await adapters.filePort.removeDirectory('/repo/new');
        const entries = await adapters.filePort.listDirectory('/repo/new');
        expect(entries).toEqual([{ name: 'one', kind: 'file' }]);
        expect(double.calls).toEqual([
            'lstat:/repo/a',
            'mkdir:/repo/root:recursive=true',
            'mkdir:/repo/new:recursive=false',
            'write:/repo/new/a:createNew=true',
            'read:/repo/new/a',
            'remove:/repo/new/a:recursive=false',
            'remove:/repo/new:recursive=true',
            'list:/repo/new'
        ]);
        double.runtime.readFile = async () => {
            throw new Error('read denied');
        };
        const failed = createDenoRtcBaselineAdapters(double.runtime);
        await expect(failed.filePort.readFile('/repo/denied')).rejects.toThrow('read denied');
        expect(
            adapters.filePort.classifyError!(new double.runtime.errors!.AlreadyExists!('exists'))
        ).toBe('already-exists');
        expect(
            adapters.filePort.classifyError!(new double.runtime.errors!.PermissionDenied!('denied'))
        ).toBe('permission-denied');
    });
    it('reads Linux CPU facts without sysctl and propagates host failures', async () => {
        const double = createRuntimeDouble();
        double.runtime.build = { os: 'linux', arch: 'x86_64' };
        double.runtime.readFile = async (path) => {
            double.calls.push(`read:${path}`);
            return new TextEncoder().encode('processor : 0\nmodel name : AMD EPYC 7B13\n');
        };
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(await adapters.runtimeHost.read()).toEqual({
            deno: '2.4.0',
            os: 'linux',
            kernel: '24.6.0',
            architecture: 'x86_64',
            logicalCpuCount: 10,
            cpuModel: 'AMD EPYC 7B13',
            totalMemoryBytes: 17179869184,
            executionContext: 'local'
        });
        expect(double.calls.filter((call) => call.startsWith('run:'))).toEqual(['run:uname:-r']);
        expect(double.calls.filter((call) => call.startsWith('read:'))).toEqual(['read:/proc/cpuinfo']);
        double.runtime.command = async (executable) => ({
            code: executable === 'uname' ? 2 : 0,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode('host unavailable')
        });
        await expect(adapters.runtimeHost.read()).rejects.toThrow('uname exited with status 2.');
    });
    it('returns exact process output and typed nonzero/throw failures', async () => {
        const nonzeroDouble = createRuntimeDouble();
        nonzeroDouble.runtime.command = async () => ({
            code: 7,
            stdout: new TextEncoder().encode('partial'),
            stderr: new TextEncoder().encode('bad')
        });
        const nonzero = createDenoRtcBaselineAdapters(nonzeroDouble.runtime);
        expect(
            await nonzero.process.run({ executable: 'deno', arguments: ['check', 'file.ts'] })
        ).toEqual({
            ok: false,
            issues: [
                {
                    path: '$.process',
                    code: 'command-failed',
                    message: 'deno exited with status 7.',
                    details: { exitStatus: 7, stdout: 'partial', stderr: 'bad' }
                }
            ]
        });
        nonzeroDouble.runtime.command = async () => {
            throw new Error('spawn denied');
        };
        expect(await nonzero.process.run({ executable: 'git', arguments: ['status'] })).toEqual({
            ok: false,
            issues: [{ path: '$.process', code: 'command-threw', message: 'spawn denied' }]
        });
    });
    it('allows only the exhaustive protocol executable set', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(
            await Promise.all([
                adapters.process.run({ executable: 'deno', arguments: ['--version'] }),
                adapters.process.run({ executable: 'node', arguments: ['--version'] }),
                adapters.process.run({ executable: 'npm', arguments: ['--version'] }),
                adapters.process.run({ executable: 'git', arguments: ['--version'] }),
                adapters.process.run({ executable: 'uname', arguments: ['-r'] }),
                adapters.process.run({
                    executable: 'sysctl',
                    arguments: ['-n', 'machdep.cpu.brand_string']
                })
            ])
        ).toEqual([
            { ok: true, value: { exitStatus: 0, stdout: 'output\n', stderr: '' } },
            { ok: true, value: { exitStatus: 0, stdout: 'output\n', stderr: '' } },
            { ok: true, value: { exitStatus: 0, stdout: 'output\n', stderr: '' } },
            { ok: true, value: { exitStatus: 0, stdout: 'output\n', stderr: '' } },
            { ok: true, value: { exitStatus: 0, stdout: '24.6.0\n', stderr: '' } },
            { ok: true, value: { exitStatus: 0, stdout: 'Apple M4\n', stderr: '' } }
        ]);
    });
    it('persists actual runtime versions and redacted secret environment presence', async () => {
        const double = createRuntimeDouble();
        double.runtime.envGet = (name) => {
            double.calls.push(`env:${name}`);
            return name === 'DATABASE_URL' ? 'postgres://user:secret@db/name' : undefined;
        };
        const originalCommand = double.runtime.command;
        const output = (value: string) => ({
            code: 0,
            stdout: new TextEncoder().encode(value),
            stderr: new Uint8Array()
        });
        double.runtime.command = async (executable, arguments_) => {
            if (executable === 'node' && arguments_[0] === '--version') {
                return output('v24.4.1\n');
            }
            if (executable === 'npm') {
                return output('11.4.2\n');
            }
            if (executable === 'node' && arguments_[1]?.includes('package.json')) {
                return output('1.55.0\n');
            }
            if (executable === 'node' && arguments_[1]?.includes('execFileSync')) {
                return output('Chromium 139.0.7258.5\n');
            }
            return originalCommand(executable, arguments_);
        };
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        const observed = await createRtcBaselineDenoObservation(adapters)(captureRequest('E1-local'));
        expect(observed.ok && observed.value.runtime).toEqual({
            node: 'v24.4.1',
            npm: '11.4.2',
            deno: '2.4.0',
            playwright: '1.55.0',
            chromium: 'Chromium 139.0.7258.5'
        });
        expect(observed.ok && observed.value.allowlistedEnvironment).toEqual({
            DATABASE_URL: 'present'
        });
        expect(JSON.stringify(observed)).not.toContain('postgres://user:secret');
        const distributed = await createRtcBaselineDenoObservation(adapters)(
            captureRequest('E5-remote')
        );
        expect([
            observed.ok && observed.value.host.executionContext,
            distributed.ok && distributed.value.host.executionContext
        ]).toEqual(['local', 'distributed']);
    });
    it('starts every worker through a fresh approved process invocation', async () => {
        const double = createRuntimeDouble();
        const adapters = createDenoRtcBaselineAdapters(double.runtime);
        expect(
            await Promise.all([
                adapters.freshWorker.run({ executable: 'deno', arguments: ['run', 'worker.ts'] }),
                adapters.freshWorker.run({ executable: 'node', arguments: ['worker.mjs'] })
            ])
        ).toEqual([
            { ok: true, value: { exitStatus: 0, stdout: 'output\n', stderr: '' } },
            { ok: true, value: { exitStatus: 0, stdout: 'output\n', stderr: '' } }
        ]);
        expect(double.calls.filter((call) => call.startsWith('run:'))).toEqual([
            'run:deno:run,worker.ts',
            'run:node:worker.mjs'
        ]);
    });
});
