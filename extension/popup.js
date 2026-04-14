// Popup script — communicates with the content script on chess.com
var arrowsEnabled = true;
var autoAnalyze = true;

function toggleArrows() {
  arrowsEnabled = !arrowsEnabled;
  var el = document.getElementById('toggle-arrows');
  el.classList.toggle('active', arrowsEnabled);
  chrome.storage.local.set({ arrowsEnabled: arrowsEnabled });
  sendToContent({ type: 'toggleArrows', enabled: arrowsEnabled });
}

function toggleAuto() {
  autoAnalyze = !autoAnalyze;
  var el = document.getElementById('toggle-auto');
  el.classList.toggle('active', autoAnalyze);
  chrome.storage.local.set({ autoAnalyze: autoAnalyze });
  sendToContent({ type: 'toggleAuto', enabled: autoAnalyze });
}

function sendToContent(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg);
  });
}

// Listen for updates from content script
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'evalUpdate') {
    updateEvalDisplay(msg.eval, msg.depth, msg.moves);
  }
  if (msg.type === 'accuracyUpdate') {
    updateAccuracy(msg.white, msg.black);
  }
  if (msg.type === 'statusUpdate') {
    updateStatus(msg.status, msg.ready);
  }
});

function updateEvalDisplay(evalVal, depth, moves) {
  var evalEl = document.getElementById('eval-value');
  var depthEl = document.getElementById('eval-depth');
  var fillEl = document.getElementById('eval-fill');

  if (typeof evalVal === 'number') {
    var pawns = evalVal / 100;
    var text = pawns >= 0 ? '+' + pawns.toFixed(1) : pawns.toFixed(1);
    evalEl.textContent = text;
    evalEl.className = 'eval-value ' + (pawns >= 0 ? 'positive' : 'negative');

    var capped = Math.max(-1000, Math.min(1000, evalVal));
    var pct = 50 + (capped / 1000) * 45;
    fillEl.style.height = pct + '%';
  } else if (typeof evalVal === 'string' && evalVal.startsWith('M')) {
    evalEl.textContent = evalVal;
    evalEl.className = 'eval-value positive';
    fillEl.style.height = '95%';
  }

  depthEl.textContent = 'depth ' + (depth || 0);

  if (moves && moves.length >= 1) {
    document.getElementById('move1-san').textContent = moves[0].san || '—';
    document.getElementById('move1-eval').textContent = moves[0].eval || '';
  }
  if (moves && moves.length >= 2) {
    document.getElementById('move2-san').textContent = moves[1].san || '—';
    document.getElementById('move2-eval').textContent = moves[1].eval || '';
  }
}

function updateAccuracy(white, black) {
  var section = document.getElementById('accuracy-section');
  section.style.display = 'block';
  document.getElementById('acc-white').textContent = white != null ? white.toFixed(1) + '%' : '—';
  document.getElementById('acc-black').textContent = black != null ? black.toFixed(1) + '%' : '—';
}

function updateStatus(text, ready) {
  var dot = document.getElementById('status-dot');
  var textEl = document.getElementById('status-text');
  textEl.textContent = text;
  dot.className = 'status-dot ' + (ready ? 'ready' : 'loading');
}

// Init: load saved preferences
chrome.storage.local.get(['arrowsEnabled', 'autoAnalyze'], function(data) {
  if (data.arrowsEnabled === false) {
    arrowsEnabled = false;
    document.getElementById('toggle-arrows').classList.remove('active');
  }
  if (data.autoAnalyze === false) {
    autoAnalyze = false;
    document.getElementById('toggle-auto').classList.remove('active');
  }
});

// Request current state from content script
sendToContent({ type: 'requestState' });
