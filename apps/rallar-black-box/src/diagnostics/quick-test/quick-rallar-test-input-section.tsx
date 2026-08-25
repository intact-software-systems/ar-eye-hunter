import { CollapsiblePanelSection } from '../../legacy/shared/CollapsiblePanelSection.tsx';
import type { QuickRallarTestViewModel, QuickRallarTransport } from './quick-rallar-contracts.ts';
interface QuickRallarTestInputSectionProps {
    readonly groupId: string;
    readonly model: QuickRallarTestViewModel;
}
export function QuickRallarTestInputSection({ groupId, model }: QuickRallarTestInputSectionProps) {
    return (
        <CollapsiblePanelSection
            title="Quick Test Inputs"
            meta={`${model.activeGroupId || '-'} / ${model.selectorLabel}`}
        >
            <div className="quick-rallar-context-grid">
                <label className="field">
                    <span>Group</span>
                    <input value={groupId} onChange={(event) => model.updateGroupId(event.target.value)} />
                </label>
                <label className="field">
                    <span>Transport</span>
                    <select
                        value={model.values.transport}
                        onChange={(event) => model.updateValue('transport', event.target.value as QuickRallarTransport)}
                    >
                        <option value="ws">WS group message</option>
                    </select>
                </label>
                <QuickRallarTestTextInput
                    label="Type ID"
                    value={model.values.typeId}
                    onChange={(value) => model.updateValue('typeId', value)}
                />
                <QuickRallarTestTextInput
                    label="Topic ID"
                    value={model.values.topicId}
                    onChange={(value) => model.updateValue('topicId', value)}
                />
                <QuickRallarTestTextInput
                    label="Context ID"
                    value={model.values.contextId}
                    onChange={(value) => model.updateValue('contextId', value)}
                />
                <QuickRallarTestTextInput
                    label="Resource ID"
                    value={model.values.resourceId}
                    onChange={(value) => model.updateValue('resourceId', value)}
                />
                <label className="field">
                    <span>Timeout</span>
                    <input
                        type="number"
                        min={0}
                        value={model.values.timeoutMs}
                        onChange={(event) => model.updateValue('timeoutMs', Number(event.target.value))}
                    />
                </label>
            </div>
        </CollapsiblePanelSection>
    );
}
interface QuickRallarTestTextInputProps {
    readonly label: string;
    readonly value: string;
    onChange(value: string): void;
}
function QuickRallarTestTextInput({ label, value, onChange }: QuickRallarTestTextInputProps) {
    return (
        <label className="field">
            <span>{label}</span>
            <input value={value} onChange={(event) => onChange(event.target.value)} />
        </label>
    );
}
