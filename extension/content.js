// Content script for chess.com — detects board, runs Stockfish, draws arrows
(function() {
  'use strict';

  var arrowsEnabled = true;
  var autoAnalyze = true;
  var engineReady = false;
  var stockfish = null;
  var currentFEN = null;
  var arrowSvg = null;
  var boardEl = null;
  var boardRect = null;
  var boardOrientation = 'white';
  var lastBestMoves = [];
  var analysisInProgress = false;

  // Arrow colors
  var ARROW_COLORS = [
    { fill: 'rgba(100, 255, 218, 0.85)', stroke: '#64ffda' },  // Best move - teal
    { fill: 'rgba(15, 52, 96, 0.7)', stroke: '#0f3460' }       // 2nd best - blue
  ];

  // ── INIT ──
  function init() {
    initStockfish();
    observeBoard();
    setInterval(checkForBoardChanges, 500);

    chrome.runtime.onMessage.addListener(function(msg) {
      if (msg.type === 'toggleArrows') {
        arrowsEnabled = msg.enabled;
        if (!arrowsEnabled) clearArrows();
        else if (lastBestMoves.length > 0) drawArrows(lastBestMoves);
      }
      if (msg.type === 'toggleAuto') {
        autoAnalyze = msg.enabled;
        if (autoAnalyze && currentFEN) analyzePosition(currentFEN);
      }
      if (msg.type === 'requestState') {
        sendStatus();
        if (lastBestMoves.length > 0) {
          chrome.runtime.sendMessage({
            type: 'evalUpdate',
            eval: lastBestMoves[0] ? lastBestMoves[0].cp : 0,
            depth: lastBestMoves[0] ? lastBestMoves[0].depth : 0,
            moves: lastBestMoves.map(function(m) {
              return { san: m.san || m.uci, eval: m.evalStr || '' };
            })
          });
        }
      }
    });
  }

  // ── STOCKFISH ──
  function initStockfish() {
    try {
      var workerUrl = chrome.runtime.getURL('stockfish-worker.js');
      stockfish = new Worker(workerUrl);
      stockfish.onmessage = handleEngineMessage;
      stockfish.postMessage('uci');
      stockfish.postMessage('setoption name MultiPV value 2');
      stockfish.postMessage('setoption name Hash value 32');
      stockfish.postMessage('setoption name Threads value 1');
      stockfish.postMessage('isready');
      sendStatus('Loading Stockfish...', false);
    } catch(e) {
      sendStatus('Engine failed to load', false);
    }
  }

  var pendingLines = {};
  var currentDepth = 0;

  function handleEngineMessage(event) {
    var msg = typeof event === 'string' ? event : event.data;
    if (!msg) return;

    if (msg === 'readyok') {
      engineReady = true;
      sendStatus('Engine ready', true);
      if (autoAnalyze && currentFEN) analyzePosition(currentFEN);
    }

    if (msg.startsWith('info') && msg.indexOf('score') !== -1 && msg.indexOf(' pv ') !== -1) {
      parseInfoLine(msg);
    }

    if (msg.startsWith('bestmove')) {
      analysisInProgress = false;
      // Final update with accumulated lines
      finalizeBestMoves();
    }
  }

  function parseInfoLine(msg) {
    var mpvMatch = msg.match(/multipv (\d+)/);
    var depthMatch = msg.match(/depth (\d+)/);
    var scoreMatch = msg.match(/score (cp|mate) (-?\d+)/);
    var pvMatch = msg.match(/ pv (.+)/);
    if (!scoreMatch || !pvMatch) return;

    var mpv = mpvMatch ? parseInt(mpvMatch[1]) : 1;
    var depth = depthMatch ? parseInt(depthMatch[1]) : 0;
    var scoreType = scoreMatch[1];
    var scoreVal = parseInt(scoreMatch[2]);
    var pvMoves = pvMatch[1].trim().split(' ');

    // Flip score if black to move
    var isBlack = currentFEN && currentFEN.split(' ')[1] === 'b';
    if (isBlack) scoreVal = -scoreVal;

    var evalStr;
    if (scoreType === 'mate') {
      evalStr = scoreVal > 0 ? 'M' + Math.abs(scoreVal) : '-M' + Math.abs(scoreVal);
    } else {
      var pawns = scoreVal / 100;
      evalStr = pawns >= 0 ? '+' + pawns.toFixed(1) : pawns.toFixed(1);
    }

    pendingLines[mpv] = {
      uci: pvMoves[0],
      pv: pvMoves.slice(0, 5),
      cp: scoreType === 'mate' ? (scoreVal > 0 ? 99999 : -99999) : scoreVal,
      depth: depth,
      evalStr: evalStr,
      san: uciToReadable(pvMoves[0])
    };

    currentDepth = depth;

    // Live update to popup on line 1
    if (mpv === 1) {
      var moves = [];
      for (var k = 1; k <= 2; k++) {
        if (pendingLines[k]) {
          moves.push({ san: pendingLines[k].san || pendingLines[k].uci, eval: pendingLines[k].evalStr });
        }
      }
      chrome.runtime.sendMessage({
        type: 'evalUpdate',
        eval: scoreType === 'mate' ? evalStr : scoreVal,
        depth: depth,
        moves: moves
      });
    }
  }

  function finalizeBestMoves() {
    lastBestMoves = [];
    for (var i = 1; i <= 2; i++) {
      if (pendingLines[i]) lastBestMoves.push(pendingLines[i]);
    }
    if (arrowsEnabled && lastBestMoves.length > 0) {
      drawArrows(lastBestMoves);
    }
  }

  function analyzePosition(fen) {
    if (!engineReady || !stockfish || analysisInProgress) return;
    analysisInProgress = true;
    pendingLines = {};
    stockfish.postMessage('stop');
    stockfish.postMessage('position fen ' + fen);
    stockfish.postMessage('go depth 18 movetime 2000');
  }

  function uciToReadable(uci) {
    if (!uci || uci.length < 4) return uci;
    var from = uci.slice(0, 2);
    var to = uci.slice(2, 4);
    var promo = uci[4] ? '=' + uci[4].toUpperCase() : '';
    return from + to + promo;
  }

  // ── BOARD DETECTION ──
  function observeBoard() {
    // Try to find the chess.com board element
    findBoard();
    // Also use MutationObserver for dynamic loading
    var observer = new MutationObserver(function() {
      if (!boardEl) findBoard();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function findBoard() {
    // chess.com uses wc-chess-board or chess-board element
    boardEl = document.querySelector('wc-chess-board') ||
              document.querySelector('chess-board') ||
              document.querySelector('.board');
    if (boardEl) {
      detectOrientation();
      createArrowOverlay();
      extractFEN();
    }
  }

  function detectOrientation() {
    if (!boardEl) return;
    // chess.com flipped board has a class or attribute
    var isFlipped = boardEl.classList.contains('flipped') ||
                    boardEl.getAttribute('data-orientation') === 'black';
    boardOrientation = isFlipped ? 'black' : 'white';
  }

  function checkForBoardChanges() {
    if (!boardEl) {
      findBoard();
      return;
    }
    detectOrientation();
    var newFEN = extractFEN();
    if (newFEN && newFEN !== currentFEN) {
      currentFEN = newFEN;
      clearArrows();
      if (autoAnalyze && engineReady) {
        analyzePosition(currentFEN);
      }
    }
  }

  function extractFEN() {
    if (!boardEl) return null;
    // Try to get FEN from various chess.com sources
    // 1. Check for data attribute
    var fen = boardEl.getAttribute('data-fen');
    if (fen) return fen;

    // 2. Check chess.com's game controller
    if (window.chesscom && window.chesscom.game) {
      return window.chesscom.game.getFEN ? window.chesscom.game.getFEN() : null;
    }

    // 3. Parse from piece positions on the board
    return parseBoardPieces();
  }

  function parseBoardPieces() {
    if (!boardEl) return null;
    // chess.com pieces are <div class="piece XX square-YZ">
    var pieces = boardEl.querySelectorAll('.piece');
    if (pieces.length === 0) return null;

    var board = [];
    for (var r = 0; r < 8; r++) {
      board[r] = [];
      for (var f = 0; f < 8; f++) {
        board[r][f] = '';
      }
    }

    pieces.forEach(function(el) {
      var classes = el.className.split(' ');
      var pieceType = null;
      var squareNum = null;

      classes.forEach(function(cls) {
        if (cls.length === 2 && /^[wb][prnbqk]$/.test(cls)) {
          pieceType = cls;
        }
        var sqMatch = cls.match(/^square-(\d)(\d)$/);
        if (sqMatch) {
          squareNum = { file: parseInt(sqMatch[1]) - 1, rank: parseInt(sqMatch[2]) - 1 };
        }
      });

      if (pieceType && squareNum) {
        var fenChar = pieceType[1];
        if (pieceType[0] === 'w') fenChar = fenChar.toUpperCase();
        board[7 - squareNum.rank][squareNum.file] = fenChar;
      }
    });

    // Convert to FEN
    var fenRows = [];
    for (var r = 0; r < 8; r++) {
      var row = '';
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        if (board[r][f] === '') {
          empty++;
        } else {
          if (empty > 0) { row += empty; empty = 0; }
          row += board[r][f];
        }
      }
      if (empty > 0) row += empty;
      fenRows.push(row);
    }

    // We can't determine whose turn it is from pieces alone, default to white
    return fenRows.join('/') + ' w KQkq - 0 1';
  }

  // ── ARROW DRAWING ──
  function createArrowOverlay() {
    if (arrowSvg) arrowSvg.remove();
    if (!boardEl) return;

    arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.id = 'chess-analysis-arrows';
    arrowSvg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;';

    // Add arrowhead marker defs
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    for (var i = 0; i < ARROW_COLORS.length; i++) {
      var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrowhead-' + i);
      marker.setAttribute('markerWidth', '4');
      marker.setAttribute('markerHeight', '4');
      marker.setAttribute('refX', '2.5');
      marker.setAttribute('refY', '2');
      marker.setAttribute('orient', 'auto');
      var polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', '0 0, 4 2, 0 4');
      polygon.setAttribute('fill', ARROW_COLORS[i].fill);
      marker.appendChild(polygon);
      defs.appendChild(marker);
    }
    arrowSvg.appendChild(defs);

    // Ensure board has position:relative for overlay
    var boardStyle = window.getComputedStyle(boardEl);
    if (boardStyle.position === 'static') {
      boardEl.style.position = 'relative';
    }
    boardEl.appendChild(arrowSvg);
  }

  function drawArrows(moves) {
    if (!arrowSvg || !boardEl) return;
    // Clear existing arrows
    var existing = arrowSvg.querySelectorAll('.analysis-arrow');
    existing.forEach(function(el) { el.remove(); });

    boardRect = boardEl.getBoundingClientRect();
    var sqSize = boardRect.width / 8;

    for (var i = 0; i < Math.min(moves.length, 2); i++) {
      var uci = moves[i].uci;
      if (!uci || uci.length < 4) continue;

      var fromFile = uci.charCodeAt(0) - 97;
      var fromRank = parseInt(uci[1]) - 1;
      var toFile = uci.charCodeAt(2) - 97;
      var toRank = parseInt(uci[3]) - 1;

      // Adjust for board orientation
      var x1, y1, x2, y2;
      if (boardOrientation === 'white') {
        x1 = (fromFile + 0.5) * sqSize;
        y1 = (7 - fromRank + 0.5) * sqSize;
        x2 = (toFile + 0.5) * sqSize;
        y2 = (7 - toRank + 0.5) * sqSize;
      } else {
        x1 = (7 - fromFile + 0.5) * sqSize;
        y1 = (fromRank + 0.5) * sqSize;
        x2 = (7 - toFile + 0.5) * sqSize;
        y2 = (toRank + 0.5) * sqSize;
      }

      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'analysis-arrow');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', ARROW_COLORS[i].stroke);
      line.setAttribute('stroke-width', i === 0 ? sqSize * 0.18 : sqSize * 0.12);
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('opacity', i === 0 ? '0.9' : '0.6');
      line.setAttribute('marker-end', 'url(#arrowhead-' + i + ')');
      arrowSvg.appendChild(line);
    }
  }

  function clearArrows() {
    if (!arrowSvg) return;
    var existing = arrowSvg.querySelectorAll('.analysis-arrow');
    existing.forEach(function(el) { el.remove(); });
  }

  // ── MESSAGING ──
  function sendStatus(text, ready) {
    try {
      chrome.runtime.sendMessage({
        type: 'statusUpdate',
        status: text || (engineReady ? 'Engine ready' : 'Loading...'),
        ready: ready !== undefined ? ready : engineReady
      });
    } catch(e) {}
  }

  // ── START ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
