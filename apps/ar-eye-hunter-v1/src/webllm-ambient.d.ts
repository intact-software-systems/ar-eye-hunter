declare module '@mlc-ai/web-runtime' {
    export type Instance = unknown;
    export type DLDevice = unknown;
    export type NDArray = unknown;
    const runtime: unknown;
    export default runtime;
}

declare module '@mlc-ai/web-tokenizers' {
    export class Tokenizer {
        encode(input: string): number[];
        decode(input: readonly number[]): string;
    }
}

declare module '@mlc-ai/web-xgrammar' {
    export type StructuralTagLike = unknown;
}

declare namespace chrome {
    namespace runtime {
        type MessageSender = unknown;
        interface Port {
            name: string;
            disconnect(): void;
            postMessage(message: unknown): void;
        }
    }
}

interface ExtendableMessageEvent extends MessageEvent {
    waitUntil(promise: PromiseLike<unknown>): void;
}
