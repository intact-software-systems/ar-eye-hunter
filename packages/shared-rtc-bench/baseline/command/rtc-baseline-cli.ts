import { createDenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoRuntime } from '../runtime/rtc-baseline-deno-runtime.ts';
import {
  parseRtcBaselineCommand,
  type RtcBaselineParsedCommand,
} from './rtc-baseline-cli-grammar.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';

interface CliInput {
  args: readonly string[];
  envelope: RtcBaselineEnvelope;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

function captureRequest(command: Extract<RtcBaselineParsedCommand, { kind: 'initialize' }>) {
  return {
    schema: 'rallar.rtc-baseline.capture-request.v1',
    baselineId: command.baselineId,
    workloadIds: command.workloadIds,
    environmentId: command.environmentId,
    retainedSampleMultiplier: command.retainedSampleMultiplier,
    repeatLink: null,
    conditionalEnvironmentDecisions:
      command.conditionalEnvironmentDecision === null
        ? []
        : [command.conditionalEnvironmentDecision],
    ...(command.repeatOf === null ? {} : { repeatOf: command.repeatOf }),
  };
}

async function dispatch(envelope: RtcBaselineEnvelope, command: RtcBaselineParsedCommand) {
  if (command.kind === 'initialize') {
    return {
      kind: command.kind,
      result: await envelope.initializeBaseline(captureRequest(command)),
    };
  }
  if (command.kind === 'capture') {
    return {
      kind: command.kind,
      result: await envelope.captureWorkload({
        baselineId: command.baselineId,
        workloadId: command.workloadId,
      }),
    };
  }
  if (command.kind === 'list-external-attempts') {
    return {
      kind: command.kind,
      result: await envelope.readExternalAttempts({
        baselineId: command.baselineId,
        workloadId: command.workloadId,
      }),
    };
  }
  if (command.kind === 'record-browser') {
    const { kind: _kind, ...input } = command;
    return { kind: command.kind, result: await envelope.recordBrowser(input) };
  }
  if (command.kind === 'record-external') {
    const { kind: _kind, ...input } = command;
    return { kind: command.kind, result: await envelope.recordExternalAttempt(input) };
  }
  if (command.kind === 'record-external-cohort') {
    const { kind: _kind, ...input } = command;
    return {
      kind: command.kind,
      result: await envelope.recordExternalCohortAssertion(input),
    };
  }
  if (command.kind === 'repeat-required') {
    return {
      kind: command.kind,
      result: await envelope.readRepeatRequirement({ baselineId: command.baselineId }),
    };
  }
  if (command.kind === 'compare-paired') {
    const { kind: _kind, ...input } = command;
    return { kind: command.kind, result: await envelope.readPairedComparison(input) };
  }
  if (command.kind === 'validate') {
    return {
      kind: command.kind,
      result: await envelope.readBaselineValidation({ baselineId: command.baselineId }),
    };
  }
  return {
    kind: command.kind,
    result: await envelope.finalize({ baselineId: command.baselineId }),
  };
}

export async function runRtcBaselineCli(input: CliInput) {
  const parsed = parseRtcBaselineCommand(input.args);
  if (!parsed.ok) {
    input.writeStderr(`${JSON.stringify(parsed.issues)}\n`);
    return 64;
  }
  const dispatched = await dispatch(input.envelope, parsed.value);
  if (!dispatched.result.ok) {
    input.writeStderr(`${JSON.stringify(dispatched.result.issues)}\n`);
    return 1;
  }
  if (dispatched.kind === 'list-external-attempts') {
    for (const attempt of dispatched.result.value) {
      const columns = [
        attempt.caseId,
        attempt.intendedPhase,
        attempt.outerOrdinal,
        attempt.environmentId,
      ];
      input.writeStdout(`${columns.join('\t')}\n`);
    }
  } else if (dispatched.kind === 'repeat-required') {
    if (dispatched.result.value.workloadIds.length === 0) return 3;
    input.writeStdout(`${[...dispatched.result.value.workloadIds].sort().join(',')}\n`);
  } else if (dispatched.kind === 'compare-paired') {
    input.writeStdout(`${JSON.stringify(dispatched.result.value)}\n`);
    if (dispatched.result.value.outcome === 'inconclusive-still-noisy') return 2;
  }
  return 0;
}

function defaultRuntime() {
  const deno = Deno;
  return {
    get args() {
      return deno.args;
    },
    envGet: (name: string) => deno.env.get(name),
    cwd: () => deno.cwd(),
    get build() {
      return deno.build;
    },
    get version() {
      return deno.version;
    },
    get errors() {
      return deno.errors;
    },
    stat: (path: string) => deno.stat(path),
    lstat: (path: string) => deno.lstat(path),
    mkdir: (path: string, options?: { recursive?: boolean }) => deno.mkdir(path, options),
    readFile: (path: string) => deno.readFile(path),
    writeFile: (path: string, bytes: Uint8Array, options?: { createNew?: boolean }) =>
      deno.writeFile(path, bytes, options),
    remove: (path: string, options?: { recursive?: boolean }) => deno.remove(path, options),
    readDir: (path: string) => deno.readDir(path),
    async command(executable: string, arguments_: readonly string[]) {
      return new deno.Command(executable, { args: [...arguments_] }).output();
    },
    now: () => new Date(),
    performanceNow: () => performance.now(),
    systemMemoryInfo: () => deno.systemMemoryInfo(),
    availableParallelism: () => navigator.hardwareConcurrency,
  };
}

export function createDefaultRtcBaselineEnvelope() {
  return createRtcBaselineDenoRuntime(createDenoRtcBaselineAdapters(defaultRuntime()));
}

if (import.meta.main) {
  const deno = Deno;
  const code = await runRtcBaselineCli({
    args: deno.args,
    envelope: createDefaultRtcBaselineEnvelope(),
    writeStdout: (value) => deno.stdout.write(new TextEncoder().encode(value)),
    writeStderr: (value) => deno.stderr.write(new TextEncoder().encode(value)),
  });
  deno.exit(code);
}
