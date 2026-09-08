import { Either } from '../../shared/resilience/Either.ts';

export interface ScenarioCliOptions {
    readonly config: string;
    readonly workingDirectory?: string;
    readonly replace?: string;
    readonly execution?: string;
    readonly dryRun?: boolean;
    readonly artifactDir?: string;
    readonly iterations?: string;
    readonly durationMs?: string;
    readonly delayMs?: string;
    readonly explain?: boolean;
    readonly validate?: boolean;
    readonly profile?: string;
    readonly strict?: boolean;
}

export type ScenarioCliCommand =
    | { readonly kind: 'help'; }
    | { readonly kind: 'run'; readonly options: ScenarioCliOptions; };

type ScenarioValueOption =
    | 'config'
    | 'workingDirectory'
    | 'replace'
    | 'execution'
    | 'artifactDir'
    | 'iterations'
    | 'durationMs'
    | 'delayMs'
    | 'profile';
type ScenarioFlagOption = 'dryRun' | 'explain' | 'validate' | 'strict';

type ScenarioOption =
    | { readonly kind: 'value'; readonly field: ScenarioValueOption; }
    | { readonly kind: 'flag'; readonly field: ScenarioFlagOption; };

export const scenarioCliHelp = [
    '',
    'Example calls:',
    '  $ scenario-generate --config config.json',
    '  $ scenario-generate -c config.json',
    '  $ scenario-generate -c config.json -e dry',
    '  $ scenario-generate -c config.json --dry-run',
    '  $ scenario-generate -c config.json --explain',
    '  $ scenario-generate -c config.json --validate --strict',
    '  $ scenario-generate -c config.json --artifact-dir .artifacts/black-box-run',
    '  $ scenario-generate -c config.json --iterations 10 --artifact-dir .artifacts/black-box-scale',
    '  $ scenario-generate -c config.json -n',

    '  $ scenario-generate --config config.json --replace url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01',
    '  $ scenario-generate -c config.json -r url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01',

    '  $ scenario-generate -c config.json -w ./test-data -r url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01'
].join('\n');

const scenarioOptions: Readonly<Record<string, ScenarioOption>> = {
    '-c': { kind: 'value', field: 'config' },
    '--config': { kind: 'value', field: 'config' },
    '-w': { kind: 'value', field: 'workingDirectory' },
    '--workingDirectory': { kind: 'value', field: 'workingDirectory' },
    '-r': { kind: 'value', field: 'replace' },
    '--replace': { kind: 'value', field: 'replace' },
    '-e': { kind: 'value', field: 'execution' },
    '--execution': { kind: 'value', field: 'execution' },
    '--profile': { kind: 'value', field: 'profile' },
    '--validation-profile': { kind: 'value', field: 'profile' },
    '--artifact-dir': { kind: 'value', field: 'artifactDir' },
    '--artifacts': { kind: 'value', field: 'artifactDir' },
    '--record-dir': { kind: 'value', field: 'artifactDir' },
    '--iterations': { kind: 'value', field: 'iterations' },
    '--runs': { kind: 'value', field: 'iterations' },
    '--duration-ms': { kind: 'value', field: 'durationMs' },
    '--max-duration-ms': { kind: 'value', field: 'durationMs' },
    '--delay-ms': { kind: 'value', field: 'delayMs' },
    '--scale-delay-ms': { kind: 'value', field: 'delayMs' },
    '-n': { kind: 'flag', field: 'dryRun' },
    '--dry-run': { kind: 'flag', field: 'dryRun' },
    '--explain': { kind: 'flag', field: 'explain' },
    '--validate': { kind: 'flag', field: 'validate' },
    '--strict': { kind: 'flag', field: 'strict' }
};

export function parseScenarioCliOptions(args: readonly string[]): Either<Error, ScenarioCliCommand> {
    const values: Partial<Record<ScenarioValueOption, string>> = {};
    const flags: Partial<Record<ScenarioFlagOption, boolean>> = {};
    for (let index = 0; index < args.length; index++) {
        const [option, inlineValue] = args[index].split(/=(.*)/s, 2);
        if (option === '-h' || option === '--help') {
            return Either.ofRight({ kind: 'help' });
        }
        if (!Object.hasOwn(scenarioOptions, option)) {
            continue;
        }
        const definition = scenarioOptions[option];
        if (definition.kind === 'flag') {
            flags[definition.field] = true;
            if (definition.field === 'strict') {
                values.profile = 'strict';
            }
            continue;
        }
        const value = inlineValue ?? args[index + 1];
        if (inlineValue === undefined && (value === undefined || value.startsWith('-'))) {
            return Either.ofLeft(new Error('Missing value for ' + option));
        }
        values[definition.field] = value;
        if (inlineValue === undefined) {
            index++;
        }
    }
    return values.config
        ? Either.ofRight({ kind: 'run', options: { ...values, ...flags, config: values.config } })
        : Either.ofLeft(new Error('Missing required option: -c, --config <config>'));
}
