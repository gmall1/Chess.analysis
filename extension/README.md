# Chess Analysis Helper — Chrome Extension

A Chrome extension that provides **live Stockfish-powered analysis** with best-move arrow overlays directly on chess.com boards.

## Features

- **Live Best-Move Arrows** — Real-time arrow overlays showing the top 2 engine-recommended moves directly on the chess.com board
- **Mini Pop-Out Panel** — Click the extension icon to see evaluation, best moves, depth, and game accuracy
- **Auto-Analyze** — Automatically analyzes each position as moves are played
- **Stockfish Engine** — Powered by Stockfish.js running in a Web Worker (depth 18, MultiPV 2)

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository
5. Navigate to [chess.com](https://www.chess.com) and start a game — arrows will appear automatically

## How It Works

- The **content script** (`content.js`) runs on chess.com pages, detects the board element, extracts the current position (FEN), and sends it to Stockfish for analysis
- When Stockfish returns the best moves, SVG arrows are drawn on top of the board
- The **popup** (`popup.html`) shows a compact analysis panel with evaluation bar, best moves, and accuracy stats
- Toggle arrows and auto-analysis on/off from the popup

## Arrow Colors

| Arrow | Meaning |
|-------|---------|
| **Teal** (bright) | Best move (#1) |
| **Blue** (darker) | Second-best move (#2) |

## Privacy

- Runs entirely locally — no data is sent to any server
- Stockfish engine runs in a sandboxed Web Worker
- No account or login required
