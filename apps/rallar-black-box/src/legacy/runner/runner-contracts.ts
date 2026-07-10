export type CommandQueueRow = Readonly<{
    id: string;
    kind: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    timeoutMs?: number;
}>;

export type RunnerDistributedRunSelection = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    controlBaseUrl: string;
    controlToken?: string;
}>;
