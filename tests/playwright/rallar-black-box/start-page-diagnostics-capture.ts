import type { ConsoleMessage, Page } from '@playwright/test';

export type PageDiagnosticKind = 'pageerror' | 'console-error' | 'console-warning';

/** Still on absolute wall-clock time; `toPageDiagnosticsFile` relocates it against the cell's reference. */
export interface PageDiagnosticCaptureRecord {
    readonly agentId: string;
    readonly role: 'sender' | 'receiver';
    readonly atEpochMs: number;
    readonly kind: PageDiagnosticKind;
    readonly message: string;
    readonly stack?: string;
}

export interface PageDiagnosticsCapture {
    readonly agentId: string;
    readonly role: 'sender' | 'receiver';
    readonly pageCreatedAtEpochMs: number;
    records(): readonly PageDiagnosticCaptureRecord[];
    droppedCount(): number;
}

const RECORD_CAP_PER_PAGE = 200;
const MESSAGE_MAX_LENGTH = 1_000;
const CONSOLE_MESSAGE_KINDS: Readonly<Record<string, PageDiagnosticKind>> = {
    error: 'console-error',
    warning: 'console-warning'
};

/**
 * Attaches from the moment the page exists, so a `pageerror` or console line during the initial
 * navigation and login is captured too, not only once the agent finishes registering. Task 7's
 * pinned reading found the hosted ACK loss below `admitIncomingMessage` on the sender's carrier; this
 * capture is the harness-only addition it routed to the maintainer, so the next hosted red can say
 * where the ACK died instead of leaving no console or page evidence at all.
 */
export function startPageDiagnosticsCapture(
    page: Page,
    input: Readonly<{ agentId: string; role: 'sender' | 'receiver'; }>
): PageDiagnosticsCapture {
    const pageCreatedAtEpochMs = Date.now();
    const records: PageDiagnosticCaptureRecord[] = [];
    let droppedCount = 0;
    const capture = (kind: PageDiagnosticKind, message: string, stack: string | undefined): void => {
        if (records.length >= RECORD_CAP_PER_PAGE) {
            droppedCount += 1;
            return;
        }
        records.push({
            agentId: input.agentId,
            role: input.role,
            atEpochMs: Date.now(),
            kind,
            message: truncatePageDiagnosticText(message),
            ...(stack === undefined ? {} : { stack: truncatePageDiagnosticText(stack) })
        });
    };
    page.on('pageerror', (error) => capture('pageerror', error.message, error.stack));
    page.on('console', (message) => toConsoleCapture(message, capture));
    return {
        agentId: input.agentId,
        role: input.role,
        pageCreatedAtEpochMs,
        records: () => records,
        droppedCount: () => droppedCount
    };
}

function toConsoleCapture(
    message: ConsoleMessage,
    capture: (kind: PageDiagnosticKind, message: string, stack: string | undefined) => void
): void {
    const kind = CONSOLE_MESSAGE_KINDS[message.type()];
    if (kind !== undefined) {
        capture(kind, message.text(), undefined);
    }
}

function truncatePageDiagnosticText(value: string): string {
    return value.length > MESSAGE_MAX_LENGTH ? `${value.slice(0, MESSAGE_MAX_LENGTH)}…` : value;
}
