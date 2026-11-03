/** Install with Playwright addInitScript; counts distinct WebGL resources across all canvases in a document. */
export function observeBrowserWebGlContexts(): void {
    const contexts = new WeakSet<object>();
    let count = 0;
    HTMLCanvasElement.prototype.getContext = new Proxy(HTMLCanvasElement.prototype.getContext, {
        apply(target, canvas: HTMLCanvasElement, argumentsList: Parameters<HTMLCanvasElement['getContext']>) {
            const context = Reflect.apply(target, canvas, argumentsList);
            const kind = argumentsList[0];
            if (context && typeof kind === 'string' && kind.startsWith('webgl') && !contexts.has(context)) {
                contexts.add(context);
                document.documentElement.dataset.testWebglContexts = String(++count);
            }
            return context;
        }
    });
}
