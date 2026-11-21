/** The budget of a timer that retries one send: its window, how many attempts it may charge, and how many it has. */
export interface ALOutboundAttemptBudget {
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly attempts: number;
}

export type ALOutboundAttemptDeadline =
    | Readonly<{ kind: 'exhausted'; }>
    | Readonly<{ kind: 'wait' | 'retry'; next: Readonly<{ attempts: number; deadlineAtMs: number; }>; }>;

/**
 * What a deadline of a timer that retries a send does. An attempt whose copy is still queued for its carrier charges
 * nothing and waits a whole timeout more: no frame left, so nothing went unanswered. One whose copy left and drew no
 * answer is charged and retried, until the budget is spent.
 */
export function computeALOutboundAttemptDeadline(input: {
    readonly budget: ALOutboundAttemptBudget;
    readonly held: boolean;
    readonly nowMs: number;
}): ALOutboundAttemptDeadline {
    const { budget, nowMs } = input;
    if (input.held) {
        return { kind: 'wait', next: { attempts: budget.attempts, deadlineAtMs: nowMs + budget.timeoutMs } };
    }
    if (budget.attempts >= budget.maxAttempts) {
        return { kind: 'exhausted' };
    }
    return { kind: 'retry', next: { attempts: budget.attempts + 1, deadlineAtMs: nowMs + budget.timeoutMs } };
}
