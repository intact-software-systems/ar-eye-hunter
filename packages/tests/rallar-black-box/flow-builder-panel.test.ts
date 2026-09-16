// @vitest-environment happy-dom
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FLOW_BUILDER_TEMPLATES,
    toTemplateFlowBuilderText
} from '../../../apps/rallar-black-box/src/flow-builder/flow-builder-templates.ts';
import { FlowBuilderPanel } from '../../../apps/rallar-black-box/src/legacy/runner/builder/flow-builder-panel.tsx';
import type { CommandCenterGlobalValues } from '../../../apps/rallar-black-box/src/legacy/shell/global-context-model.ts';

const runLabels = vi.hoisted(() => [] as string[]);
vi.mock('../../../apps/rallar-black-box/src/runtime-store.ts', () => ({
    rallarBlackBoxRuntimeStore: {
        executeManualCommands: async (_commands: readonly RallarBlackBoxTestCommand[], label: string) => {
            runLabels.push(label);
        }
    }
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const idleState: RallarBlackBoxTestState = { status: 'idle', commandHistory: [], events: [], failures: [], resultCache: {} };
const globalValues: CommandCenterGlobalValues = {
    apiBaseUrl: 'https://api.example.test',
    applicationId: 'primary-application',
    workspaceId: 'primary-workspace',
    clientId: 'primary-client',
    sessionId: 'primary-session',
    roomId: 'primary-room'
};

function result(commandId: string, ok: boolean): RallarBlackBoxTestResult {
    return {
        commandId,
        kind: 'http.request',
        status: ok ? 'ok' : 'failed',
        ok,
        startedAtEpochMs: 1_000,
        endedAtEpochMs: 1_010,
        durationMs: 10
    };
}

describe('flow builder panel preservation', () => {
    let root: Root;
    let container: HTMLDivElement;
    const selected: string[] = [];
    const copied: string[] = [];

    async function render(busy = false, state = idleState): Promise<void> {
        await act(async () =>
            root.render(createElement(FlowBuilderPanel, {
                state,
                authSession: undefined,
                globalValues,
                busy,
                onSelectCommand: (commandId) => selected.push(commandId)
            }))
        );
    }

    function buttons(selector: string): ReadonlyArray<readonly [string | null, boolean]> {
        return [...container.querySelectorAll<HTMLButtonElement>(`${selector} button`)].map((button) => [
            button.textContent,
            button.disabled
        ]);
    }

    function button(name: string): HTMLButtonElement {
        const match = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name);
        if (!match) {
            throw new Error(`Missing ${name} button`);
        }
        return match;
    }

    function editor(label: string): HTMLTextAreaElement {
        const match = [...container.querySelectorAll('label')]
            .find((candidate) => candidate.querySelector('span')?.textContent === label)
            ?.querySelector('textarea');
        if (!(match instanceof HTMLTextAreaElement)) {
            throw new Error(`Missing ${label} editor`);
        }
        return match;
    }

    function templateSelect(): HTMLSelectElement {
        const match = container.querySelector('select');
        if (!(match instanceof HTMLSelectElement)) {
            throw new Error('Missing template select');
        }
        return match;
    }

    async function edit(target: HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
        const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
        await act(async () => {
            Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, value);
            target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        });
    }

    async function click(name: string): Promise<void> {
        await act(async () => button(name).click());
    }

    function previewText(title: string): string | null | undefined {
        return [...container.querySelectorAll('.flow-builder-preview')]
            .find((section) => section.querySelector('h3')?.textContent === title)
            ?.querySelector('.json-block')?.textContent;
    }

    function stepRows(): ReadonlyArray<readonly [string | null | undefined, string | null | undefined, string | undefined]> {
        return [...container.querySelectorAll('.flow-step-row')].map((row) => [
            row.querySelector('strong')?.textContent,
            row.querySelector('.pill')?.textContent,
            row.querySelector('.pill')?.className
        ]);
    }

    beforeEach(() => {
        runLabels.length = 0;
        selected.length = 0;
        copied.length = 0;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
            copied.push(text);
        });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    it('renders the template toolbar, the step buttons, the editors and both previews for a valid flow', async () => {
        await render();

        expect({
            heading: [container.querySelector('.panel-heading .pill')?.textContent, container.querySelector('.panel-heading .pill')?.className],
            options: [...templateSelect().options].map((option) => [option.value, option.textContent]),
            template: [templateSelect().value, templateSelect().disabled],
            toolbar: buttons('.flow-builder-toolbar'),
            steps: buttons('.flow-builder-add-grid'),
            editors: [editor('Variables JSON').disabled, editor('Flow JSON').value === toTemplateFlowBuilderText(FLOW_BUILDER_TEMPLATES[0].templateId)],
            sections: [...container.querySelectorAll('.section-heading')].map((heading) => heading.textContent),
            validations: [...container.querySelectorAll('.schema-authoring-panel')].map((panel) => panel.className),
            error: container.querySelector('.workbench-error')?.textContent
        }).toEqual({
            heading: ['10 commands', 'pill good'],
            options: FLOW_BUILDER_TEMPLATES.map((template) => [template.templateId, template.label]),
            template: ['auth-rest-ws-rtc', false],
            toolbar: [['Normalize JSON', false], ['Run Flow', false], ['Copy SPA Recipe', false], ['Copy Runner Scenario', false]],
            steps: ['auth.login', 'rest.request', 'ws.open', 'ws.send', 'rtc.connect', 'rtc.send', 'wait', 'cleanup'].map((kind) => [`Add ${kind}`, false]),
            editors: [false, true],
            sections: ['Steps9 steps', 'SPA Recipe Previewflow-auth-rest-ws-rtc', 'Runner Scenario Previewblack-box-runner'],
            validations: ['schema-authoring-panel  warn', 'schema-authoring-panel  good'],
            error: undefined
        });
    });

    it('routes the toolbar, step buttons and editors to the controller', async () => {
        await render();
        await click('Copy SPA Recipe');
        await click('Copy Runner Scenario');
        const copies = [copied[0] === previewText('SPA Recipe Preview'), copied[1] === previewText('Runner Scenario Preview')];
        await click('Run Flow');
        await click('Add wait');
        const added = [JSON.parse(editor('Flow JSON').value).steps.at(-1).kind, container.querySelector('.section-heading span')?.textContent];
        const formatted = editor('Flow JSON').value;
        const compact = JSON.stringify(JSON.parse(formatted));
        await edit(editor('Flow JSON'), compact);
        await click('Normalize JSON');
        const normalized = [compact.includes('\n'), editor('Flow JSON').value.startsWith('{\n')];
        await edit(editor('Variables JSON'), '{"marker":"edited"}');
        await edit(templateSelect(), 'rtc-matrix');

        expect({
            copies,
            runLabels,
            added,
            normalized,
            template: [templateSelect().value, editor('Flow JSON').value === toTemplateFlowBuilderText('rtc-matrix')],
            variablesReset: editor('Variables JSON').value.includes('edited')
        }).toEqual({
            copies: [true, true],
            runLabels: ['Run Flow Builder'],
            added: ['wait', '10 steps'],
            normalized: [false, true],
            template: ['rtc-matrix', true],
            variablesReset: false
        });
    });

    it('disables the template, run, step buttons and editors while busy but keeps normalize and copies', async () => {
        await render(true);

        expect({
            template: templateSelect().disabled,
            toolbar: buttons('.flow-builder-toolbar'),
            steps: buttons('.flow-builder-add-grid').every(([, disabled]) => disabled),
            editors: [editor('Variables JSON').disabled, editor('Flow JSON').disabled]
        }).toEqual({
            template: true,
            toolbar: [['Normalize JSON', false], ['Run Flow', true], ['Copy SPA Recipe', false], ['Copy Runner Scenario', false]],
            steps: true,
            editors: [true, true]
        });
    });

    it('selects a step command, shows step expectations and marks a disabled step skipped', async () => {
        await render(false, {
            ...idleState,
            resultCache: {
                'flow-auth-login': result('flow-auth-login', true),
                'flow-create-group': result('flow-create-group', false),
                'flow-ws-close': result('flow-ws-close', true)
            }
        });
        await click('flow-create-group');
        const expectations = [...container.querySelectorAll('.flow-step-row')]
            .filter((row) => row.querySelector('.mini-json'))
            .map((row) => [row.querySelector('strong')?.textContent, Object.keys(JSON.parse(row.querySelector('.mini-json')?.textContent ?? '{}'))]);
        const flow = JSON.parse(editor('Flow JSON').value);
        await edit(editor('Flow JSON'), JSON.stringify({ ...flow, steps: [{ ...flow.steps[0], enabled: false }, ...flow.steps.slice(1)] }));

        expect({ selected, expectations, skipped: stepRows()[0] }).toEqual({
            selected: ['flow-create-group'],
            expectations: [['Login request', ['expect', 'extract']], ['Create group', ['expect']], ['Wait for evidence', ['expect']]],
            skipped: ['Configure runtime', 'skipped', expect.stringMatching(/^pill /)]
        });
    });

    it('derives each step status from the result cache, completed only when every command has a result', async () => {
        await render(false, {
            ...idleState,
            resultCache: {
                'flow-auth-login': result('flow-auth-login', true),
                'flow-create-group': result('flow-create-group', false),
                'flow-ws-close': result('flow-ws-close', true)
            }
        });

        expect({
            rows: stepRows().slice(0, 3),
            cleanup: stepRows().at(-1),
            links: [...container.querySelectorAll('.flow-step-row')].at(-1)?.querySelectorAll('button').length
        }).toEqual({
            rows: [['Configure runtime', 'pending', 'pill muted'], ['Login request', 'completed', 'pill good'], ['Create group', 'failed', 'pill bad']],
            cleanup: ['Cleanup', 'pending', 'pill muted'],
            links: 2
        });
    });

    it('shows an invalid flow as a parse error with no steps and disabled run and copies', async () => {
        await render();
        await edit(editor('Flow JSON'), '{');

        expect({
            heading: [container.querySelector('.panel-heading .pill')?.textContent, container.querySelector('.panel-heading .pill')?.className],
            error: Boolean(container.querySelector('.workbench-error')?.textContent),
            steps: [container.querySelector('.flow-step-list')?.textContent, container.querySelector('.section-heading span')?.textContent],
            recipeId: [...container.querySelectorAll('.section-heading span')][1]?.textContent,
            toolbar: buttons('.flow-builder-toolbar')
        }).toEqual({
            heading: ['invalid', 'pill bad'],
            error: true,
            steps: ['No valid flow loaded', '0 steps'],
            recipeId: '-',
            toolbar: [['Normalize JSON', false], ['Run Flow', true], ['Copy SPA Recipe', true], ['Copy Runner Scenario', true]]
        });
    });
});
