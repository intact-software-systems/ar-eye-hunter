import type { RtcBaselineResult } from './rtc-baseline-contracts.ts';

export interface RtcBaselineCliIssue {
  path: string;
  code: string;
  message: string;
}
export type RtcBaselineCliOptions = Record<string, string>;

export function createRtcBaselineCliIssue(
  path: string,
  code: string,
  message: string,
): RtcBaselineCliIssue {
  return { path, code, message };
}

const issue = createRtcBaselineCliIssue;

export function parseRtcBaselineCommandOptions<K extends string>(input: {
  command: K;
  args: readonly string[];
  allowed: Readonly<Record<K, readonly string[]>>;
  required: Readonly<Record<K, readonly string[]>>;
}) {
  const options: RtcBaselineCliOptions = {};
  const issues: RtcBaselineCliIssue[] = [];
  input.args.forEach((argument, offset) => {
    const index = offset + 1;
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) {
      const option = argument.startsWith('--');
      issues.push(
        issue(
          `$.args[${index}]`,
          option ? 'two-token-option' : 'positional-argument',
          option
            ? 'Options must use one --name=value token.'
            : 'Positional arguments are not supported.',
        ),
      );
      return;
    }
    const name = match[1]!;
    if (!input.allowed[input.command].includes(name)) {
      issues.push(
        issue(
          `$.args[${index}]`,
          'unsupported-option',
          `Option --${name} is not supported by ${input.command}.`,
        ),
      );
    } else if (Object.hasOwn(options, name)) {
      issues.push(
        issue(`$.args[${index}]`, 'duplicate-option', `Option --${name} appears more than once.`),
      );
    } else options[name] = match[2]!;
  });
  for (const name of input.required[input.command]) {
    if (!Object.hasOwn(options, name)) {
      issues.push(issue(`$.${name}`, 'missing-option', `Required option --${name} is missing.`));
    }
  }
  return { options, issues };
}

export function parseRtcBaselineOneTokenOptions(
  args: readonly string[],
  allowedNames: readonly string[],
): RtcBaselineResult<Record<string, string>> {
  const value: Record<string, string> = {};
  const issues: ReturnType<typeof issue>[] = [];
  args.forEach((argument, index) => {
    if (!argument.startsWith('--')) {
      issues.push(
        issue(`$.args[${index}]`, 'positional-argument', 'Positional arguments are not supported.'),
      );
      return;
    }
    const equals = argument.indexOf('=');
    if (equals < 3) {
      issues.push(
        issue(`$.args[${index}]`, 'two-token-option', 'Options must use one --name=value token.'),
      );
      return;
    }
    const name = argument.slice(2, equals);
    if (!allowedNames.includes(name)) {
      issues.push(
        issue(`$.args[${index}]`, 'unsupported-option', `Option --${name} is not supported.`),
      );
    } else if (Object.hasOwn(value, name)) {
      issues.push(
        issue(`$.args[${index}]`, 'duplicate-option', `Option --${name} appears more than once.`),
      );
    } else {
      value[name] = argument.slice(equals + 1);
    }
  });
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

export function parseRtcBaselineBoundedInteger(
  ...input: readonly [value: string, name: string, minimum: number, maximum: number]
): RtcBaselineResult<number> {
  const [value, name, minimum, maximum] = input;
  if (!/^-?\d+$/.test(value)) {
    return {
      ok: false,
      issues: [issue(`$.${name}`, 'invalid-integer', `Option --${name} must be an integer.`)],
    };
  }
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum
    ? { ok: true, value: parsed }
    : {
        ok: false,
        issues: [
          issue(
            `$.${name}`,
            'integer-out-of-range',
            `Option --${name} must be between ${minimum} and ${maximum}.`,
          ),
        ],
      };
}

export function encodeRtcBaselineScalar(value: boolean | number | string): string {
  return String(value);
}

export function encodeRtcBaselineSampleIds(
  sampleIds: readonly string[],
): RtcBaselineResult<string> {
  const issues = sampleIds.flatMap((sampleId, index) =>
    sampleId.includes(',')
      ? [
          issue(
            `$.sampleIds[${index}]`,
            'invalid-sample-id-token',
            'Sample IDs may not contain commas.',
          ),
        ]
      : [],
  );
  return issues.length === 0 ? { ok: true, value: sampleIds.join(',') } : { ok: false, issues };
}

export function readRtcBaselineLiteral<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T {
  return allowed.find((candidate) => candidate === value) ?? allowed[0]!;
}

export function readRtcBaselineRequiredOption(value: string | undefined): string {
  return value ?? '';
}
