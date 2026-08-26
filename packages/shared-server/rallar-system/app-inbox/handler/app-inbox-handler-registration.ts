import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AppInboxMessageContext, AppInboxType } from '../app-inbox-contracts.ts';

export interface AppInboxHandlerRegistration<Command, Result> {
    readonly type: AppInboxType;
    readonly decodeCommand: (value: JsonWireValue) => Command;
    readonly encodeResult: (result: Result) => JsonWireValue;
    readonly handle: (
        command: Command,
        context: AppInboxMessageContext<Result>
    ) => Promise<Result>;
}
