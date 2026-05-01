// Stockfish Web Worker wrapper for the Chrome extension
// Loads Stockfish.js from CDN inside the worker
try {
  importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
} catch(e) {
  postMessage('info string Failed to load Stockfish engine');
}
