// worker.js
self.onmessage = function(e) {
    const n = e.data;
    console.log("Worker: Starter beregning for " + n);

    const result = fibonacci(n);

    // Send resultatet tilbake til hovedtråden
    self.postMessage(result);
};

function fibonacci(num) {
    if (num <= 1) return num;
    return fibonacci(num - 1) + fibonacci(num - 2);
}
