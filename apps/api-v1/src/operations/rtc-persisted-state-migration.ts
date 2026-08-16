export const RTC_PERSISTED_STATE_MIGRATION_STEPS = [
  'topology-scalar-authority',
  'snapshot-keys',
  'publication-keys',
] as const;

export type RtcPersistedStateMigrationOptions = Readonly<{
  oldWritersStopped: true;
  dryRun: boolean;
}>;

export type RtcPersistedStateMigrationAction = Readonly<{
  name: string;
  run(): Promise<void>;
}>;

export type RtcPersistedStateMigrationResult = Readonly<{
  dryRun: boolean;
  completedSteps: readonly string[];
}>;

export function parseRtcPersistedStateMigrationArgs(
  args: readonly string[],
): RtcPersistedStateMigrationOptions {
  const supported = new Set(['--old-writers-stopped', '--dry-run']);
  const unexpected = args.filter((arg) => !supported.has(arg));
  if (unexpected.length > 0) {
    throw new Error(`Unknown RTC persisted-state migration argument: ${unexpected[0]}`);
  }
  if (!args.includes('--old-writers-stopped')) {
    throw new Error(
      'RTC persisted-state migration requires --old-writers-stopped acknowledgement',
    );
  }
  return {
    oldWritersStopped: true,
    dryRun: args.includes('--dry-run'),
  };
}

export async function executeRtcPersistedStateMigration(
  options: RtcPersistedStateMigrationOptions,
  actions: readonly RtcPersistedStateMigrationAction[],
): Promise<RtcPersistedStateMigrationResult> {
  if (options.oldWritersStopped !== true) {
    throw new Error('RTC persisted-state migration requires old writers stopped');
  }
  if (options.dryRun) {
    return {
      dryRun: true,
      completedSteps: actions.map(({ name }) => name),
    };
  }
  const completedSteps: string[] = [];
  for (const action of actions) {
    await action.run();
    completedSteps.push(action.name);
  }
  return { dryRun: false, completedSteps };
}
