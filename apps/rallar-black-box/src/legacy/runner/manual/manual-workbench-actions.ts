import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import {
    type ManualActionHistoryEntry,
    type ManualWorkbenchAction,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import {
    toManualRtcDeliveryMatrixCommands,
    toManualRtcNackProbeCommands
} from '../../../manual-workbench/manual-rtc-probe-commands.ts';
import { toManualWorkbenchCommands } from '../../../manual-workbench/manual-workbench-commands.ts';
import type { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import type { ManualRallarWorkbenchOptions } from './manual-rallar-workbench-options.ts';
import { toManualActionLabel } from './to-manual-action-label.ts';

export namespace ManualWorkbenchActions {
    export interface Input extends ManualRallarWorkbenchOptions {
        readonly values: ManualWorkbenchValues;
        readonly sequence: number;
        readonly payloadResult: Either<string, RallarMessagePayload>;
        readonly recipeText: string;
        readonly negativeRecipeText: string;
        readonly lifetime: { readonly active: boolean; };
        readonly setSequence: React.Dispatch<React.SetStateAction<number>>;
        readonly setHistory: React.Dispatch<React.SetStateAction<readonly ManualActionHistoryEntry[]>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly runManualCommands: typeof rallarBlackBoxRuntimeStore.runManualCommands;
        nowMs(): number;
        createRequestId(): string;
    }
}
export class ManualWorkbenchActions {
    private readonly input: ManualWorkbenchActions.Input;
    constructor(input: ManualWorkbenchActions.Input) {
        this.input = input;
    }
    private readonly runManualCommandSet = async (
        label: string,
        commands: readonly RallarBlackBoxTestCommand[],
        startSequence: number
    ): Promise<void> => {
        if (!this.input.lifetime.active) {
            return;
        }
        const entry: ManualActionHistoryEntry = {
            actionId: `manual-action-${startSequence}`,
            label,
            commandIds: commands.map(
                (command) => command.commandId ?? command.kind
            ),
            commands: redactRallarBlackBoxValue(
                commands,
                uiRedactionOptions(this.input.state, this.input.authSession, [this.input.values.rallarPassword])
            ),
            atEpochMs: this.input.nowMs()
        };

        this.input.setSequence((current) => current + commands.length + 1);
        this.input.setHistory((current) => [...current, entry].slice(-12));
        this.input.onSelectCommand(entry.commandIds.at(-1) ?? entry.commandIds[0]);

        try {
            await this.input.runManualCommands(
                commands,
                label
            );
        }
        catch (error) {
            if (!this.input.lifetime.active) {
                return;
            }
            this.input.setLocalError(
                error instanceof Error ? error.message : String(error)
            );
        }
    };

    public readonly runManualAction = async (
        action: ManualWorkbenchAction
    ): Promise<void> => {
        if (!this.input.lifetime.active) {
            return;
        }
        this.input.setLocalError(undefined);
        const payloadError = this.input.payloadResult.foldLeft((error) => error);
        if (action === 'send' && payloadError !== undefined) {
            this.input.setLocalError(payloadError);
            return;
        }
        const selectedGroupId = this.input.values.groupId.trim();
        if (
            selectedGroupId &&
            ['configure', 'join', 'connect', 'send'].includes(action) &&
            this.input.globalValues.roomId !== selectedGroupId
        ) {
            this.input.onGlobalValueChange('roomId', selectedGroupId);
        }

        const label = toManualActionLabel(action);
        const startSequence = this.input.sequence;
        const commands = toManualWorkbenchCommands({
            action: action,
            values: this.input.values,
            payload: this.input.payloadResult.fold(() => null, (payload) => payload),
            sequence: startSequence,
            requestId: this.input.createRequestId()
        });
        await this.runManualCommandSet(label, commands, startSequence);
    };

    public readonly runRtcMatrix = async (
        transport: Extract<ManualWorkbenchTransport, 'realtime' | 'messages.rtc'>
    ): Promise<void> => {
        if (!this.input.lifetime.active) {
            return;
        }
        this.input.setLocalError(undefined);
        await this.input.payloadResult.fold(
            async (error) => this.input.setLocalError(error),
            async (payload) => {
                const startSequence = this.input.sequence;
                const commands = toManualRtcDeliveryMatrixCommands({
                    values: this.input.values,
                    payload,
                    sequence: startSequence,
                    transport,
                    requestId: this.input.createRequestId()
                });
                await this.runManualCommandSet(`RTC ${transport} delivery matrix`, commands, startSequence);
            }
        );
    };

    public readonly runRtcNackProbe = async (): Promise<void> => {
        if (!this.input.lifetime.active) {
            return;
        }
        this.input.setLocalError(undefined);
        await this.input.payloadResult.fold(
            async (error) => this.input.setLocalError(error),
            async (payload) => {
                const startSequence = this.input.sequence;
                const commands = toManualRtcNackProbeCommands(this.input.values, payload, startSequence);
                await this.runManualCommandSet('RTC not-yet-in-sync probe', commands, startSequence);
            }
        );
    };

    public readonly copyRecipeSnippet = (): Promise<void> => this.copyText(this.input.recipeText);
    public readonly copyNegativeRecipe = (): Promise<void> => this.copyText(this.input.negativeRecipeText);
    public readonly copyRtcMatrixRecipe = (): Promise<void> =>
        this.input.payloadResult.fold(
            async (error) => {
                if (this.input.lifetime.active) {
                    this.input.setLocalError(error);
                }
            },
            (payload) => this.copyText(this.createRtcMatrixRecipeText(payload))
        );

    private createRtcMatrixRecipeText(payload: RallarMessagePayload): string {
        const realtime = toManualRtcDeliveryMatrixCommands({
            values: this.input.values,
            payload,
            sequence: 1,
            transport: 'realtime',
            requestId: this.input.createRequestId()
        });
        const messages = toManualRtcDeliveryMatrixCommands({
            values: this.input.values,
            payload,
            sequence: realtime.length + 2,
            transport: 'messages.rtc',
            requestId: this.input.createRequestId()
        });
        return JSON.stringify(
            {
                schemaVersion: 1,
                recipeId: 'manual-rtc-delivery-matrix',
                name: 'Manual RTC delivery matrix',
                description: 'Direct, multicast, and broadcast delivery over realtime and messages.rtc.',
                continueOnFailure: false,
                commands: [...realtime, ...messages]
            },
            null,
            2
        );
    }

    private async copyText(text: string): Promise<void> {
        if (!(this.input.lifetime.active)) {
            return;
        }
        this.input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        if (this.input.lifetime.active) {
            written.foldLeft(this.input.setLocalError);
        }
    }
}
