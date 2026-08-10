export type RtcTopologyDeliveryShutdownStep =
  | 'health-report'
  | 'queue-workers'
  | 'websockets'
  | 'background-tasks'
  | 'http';

interface RtcTopologyDeliveryHealthShutdownOptions {
  readonly healthFailure: Promise<never>;
  readonly onHealthFailure: (error: Error) => void;
  readonly stopQueueWorkers: () => void;
  readonly closeWebSockets: () => void;
  readonly stopBackgroundTasks: () => void | Promise<void>;
  readonly shutdownHttp: () => Promise<void>;
  readonly onShutdownStepFailure: (
    step: RtcTopologyDeliveryShutdownStep,
    error: Error,
  ) => void;
}

export async function stopApiOnRtcTopologyDeliveryHealthFailure(
  options: RtcTopologyDeliveryHealthShutdownOptions,
): Promise<void> {
  let healthError: Error;
  try {
    await options.healthFailure;
    return;
  } catch (error) {
    healthError = error instanceof Error
      ? error
      : new Error('RTC topology delivery health failed', { cause: error });
  }

  await runShutdownStep(
    'health-report',
    () => options.onHealthFailure(healthError),
    options.onShutdownStepFailure,
  );
  await runShutdownStep(
    'queue-workers',
    options.stopQueueWorkers,
    options.onShutdownStepFailure,
  );
  await runShutdownStep(
    'websockets',
    options.closeWebSockets,
    options.onShutdownStepFailure,
  );
  await runShutdownStep(
    'background-tasks',
    options.stopBackgroundTasks,
    options.onShutdownStepFailure,
  );
  await runShutdownStep(
    'http',
    options.shutdownHttp,
    options.onShutdownStepFailure,
  );
}

async function runShutdownStep(
  step: RtcTopologyDeliveryShutdownStep,
  action: () => void | Promise<void>,
  onFailure: RtcTopologyDeliveryHealthShutdownOptions['onShutdownStepFailure'],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    onFailure(
      step,
      error instanceof Error
        ? error
        : new Error(`RTC topology delivery shutdown step ${step} failed`, { cause: error }),
    );
  }
}
