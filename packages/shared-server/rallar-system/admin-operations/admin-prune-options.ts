import type { AdminPruneCommand } from './AdminPruneExpiredWork.ts';

export type AdminPruneExpiredOptions = Readonly<{
  cutoffEpochMs: number;
  appData?: Readonly<{
    namespace?: string;
    storeName?: string;
  }>;
}>;

export function toAdminPruneExpiredOptions(command: AdminPruneCommand): AdminPruneExpiredOptions {
  if (command.appData === null) {
    return { cutoffEpochMs: command.capturedAtEpochMs };
  }
  return {
    cutoffEpochMs: command.capturedAtEpochMs,
    appData: {
      namespace: command.appData.namespace,
      ...(command.appData.storeName === null ? {} : { storeName: command.appData.storeName }),
    },
  };
}
