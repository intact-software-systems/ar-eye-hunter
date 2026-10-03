import type { ALCheckpointWriter } from './al-checkpoint-writer.ts';

/** The browser session store's defaults: its checkpoint stores' interval target and recovery-lag bound. */
export const AL_CHECKPOINT_DEFAULT_SETTINGS: ALCheckpointWriter.Settings = { intervalMs: 1_000, lagBoundMs: 10_000 };
