// main.js
const myWorker = new Worker('worker.js');

// Send data til workeren
const numberToCalculate = 40;
myWorker.postMessage(numberToCalculate);
console.log('Hovedtråd: Melding sendt til worker');

// Lytt etter svar fra bakgrunnstråden
myWorker.onmessage = function (e) {
    console.log('Hovedtråd: Mottok resultat: ' + e.data);
    alert('Beregning ferdig! Svar: ' + e.data);
};

// Håndter eventuelle feil
myWorker.onerror = function (error) {
    console.error('Worker-feil:', error.message);
};
