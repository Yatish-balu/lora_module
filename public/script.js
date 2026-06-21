const socket = io();

// ── State ──
let myNodeName      = 'NODEA';
const nodeStates    = new Map(); // peerName -> { status, sensors }
let activePeerName  = 'NODEB';   // Telemetry grid focuses on this peer
let sidebarMode     = 'serial';  // 'serial' or 'chat'
let warnCount       = 0;
let msgCount        = 0;
let alarmTimer      = null;
let isMuted         = false;

// ── DOM refs ──
const serialDot        = document.getElementById('serial-dot');
const serialLabel      = document.getElementById('serial-label');
const peersListEl      = document.getElementById('peers-list');
const serialLostBanner = document.getElementById('serial-lost-banner');
const alarmBanner      = document.getElementById('alarm-banner');
const alarmSensorsEl   = document.getElementById('alarm-active-sensors');
const telemetryGrid    = document.getElementById('telemetry-grid');

// Sidebar DOM
const sidebarTitle     = document.getElementById('sidebar-title');
const clearConsoleBtn  = document.getElementById('clear-console-btn');
const toggleViewBtn    = document.getElementById('toggle-view-btn');
const serialConsoleView = document.getElementById('serial-console-view');
const consoleLog       = document.getElementById('console-log');
const chatView         = document.getElementById('chat-view');

// Chat DOM
const messages         = document.getElementById('messages');
const emptyChat        = document.getElementById('empty-chat');
const msgInput         = document.getElementById('msg-input');
const sendBtn          = document.getElementById('send-btn');
const nodeNameBadge    = document.getElementById('node-name-badge');
const soundToggle      = document.getElementById('sound-toggle');
const soundIcon        = document.getElementById('sound-icon');

// ── Audio Generation Chime ──
function createBeepDataUri() {
  const sampleRate = 8000;
  const duration = 0.15; // 150ms
  const numSamples = sampleRate * duration;
  const buffer = new Uint8Array(44 + numSamples);
  
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      buffer[offset + i] = string.charCodeAt(i);
    }
  };
  
  const writeUint32 = (offset, value) => {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
    buffer[offset + 2] = (value >> 16) & 0xff;
    buffer[offset + 3] = (value >> 24) & 0xff;
  };
  
  const writeUint16 = (offset, value) => {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
  };
  
  writeString(0, 'RIFF');
  writeUint32(4, 36 + numSamples);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  writeUint32(16, 16);
  writeUint16(20, 1);
  writeUint16(22, 1);
  writeUint32(24, sampleRate);
  writeUint32(28, sampleRate);
  writeUint16(32, 1);
  writeUint16(34, 8);
  writeString(36, 'data');
  writeUint32(40, numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = 880; // A5 note chime
    const volume = Math.exp(-t * 15);
    const val = Math.floor(128 + 127 * Math.sin(2 * Math.PI * freq * t) * volume);
    buffer[44 + i] = val;
  }
  
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

const audio = new Audio(createBeepDataUri());

// ── Utilities ──
function timeStr(iso) {
  return new Date(iso || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function genId() {
  return 'msg-' + Math.random().toString(36).slice(2, 9);
}

function escHtml(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Console logging helper ──
function appendConsoleLine(text, type = 'incoming') {
  const lineDiv = document.createElement('div');
  lineDiv.className = `console-line ${type}`;
  lineDiv.textContent = text;
  consoleLog.appendChild(lineDiv);
  consoleLog.scrollTop = consoleLog.scrollHeight;
  
  // Cap console lines
  while (consoleLog.children.length > 150) {
    consoleLog.removeChild(consoleLog.firstChild);
  }
}

// ── Sensor Helper Functions ──
function isAlert(key, value) {
  if (key === 'temp' && parseFloat(value) > 40) return true;
  if (key === 'vibration' && parseInt(value) === 1) return true;
  if (key === 'float' && parseInt(value) === 1) return true;
  if (key === 'flame' && parseInt(value) === 1) return true;
  if (key === 'smoke' && parseInt(value) === 1) return true;
  return false;
}

function formatSensorVal(key, value) {
  if (key === 'temp') return `${parseFloat(value).toFixed(1)} °C`;
  if (key === 'vibration') return parseInt(value) === 1 ? 'DANGER' : 'SAFE';
  if (key === 'float') return parseInt(value) === 1 ? 'DANGER' : 'SAFE';
  if (key === 'flame') return parseInt(value) === 1 ? 'DANGER' : 'SAFE';
  if (key === 'smoke') return parseInt(value) === 1 ? 'DANGER' : 'SAFE';
  if (key === 'accel') return value;
  return value;
}

// ── Telemetry Grid Renderer ──
function renderTelemetryGrid() {
  const state = nodeStates.get(activePeerName) || { status: 'offline', sensors: {} };
  const s = state.sensors || {};
  
  const tempVal = s.temp !== undefined ? s.temp : null;
  const vibVal = s.vibration !== undefined ? s.vibration : null;
  const floatVal = s.float !== undefined ? s.float : null;
  const flameVal = s.flame !== undefined ? s.flame : null;
  const smokeVal = s.smoke !== undefined ? s.smoke : null;
  const accelVal = s.accel !== undefined ? s.accel : null;

  telemetryGrid.innerHTML = `
    <!-- Card 1: Temp -->
    <div class="sensor-card temp">
      <div class="card-label">🌡️ TEMPERATURE</div>
      <div class="card-value">${tempVal !== null ? formatSensorVal('temp', tempVal) : '--'}</div>
      <div class="card-pill ${tempVal !== null && isAlert('temp', tempVal) ? 'danger' : 'safe'}">
        ${tempVal !== null && isAlert('temp', tempVal) ? 'DANGER: OVERHEAT' : 'SAFE'}
      </div>
    </div>

    <!-- Card 2: Vibration -->
    <div class="sensor-card vibration">
      <div class="card-label">📳 VIBRATION SENSOR</div>
      <div class="card-value">${vibVal !== null ? formatSensorVal('vibration', vibVal) : 'SAFE'}</div>
      <div class="card-pill ${vibVal !== null && isAlert('vibration', vibVal) ? 'danger' : 'safe'}">
        ${vibVal !== null && isAlert('vibration', vibVal) ? 'DANGER: VIBRATING' : 'SAFE'}
      </div>
    </div>

    <!-- Card 3: Float -->
    <div class="sensor-card float">
      <div class="card-label">🌊 FLOAT SENSOR</div>
      <div class="card-value">${floatVal !== null ? formatSensorVal('float', floatVal) : 'SAFE'}</div>
      <div class="card-pill ${floatVal !== null && isAlert('float', floatVal) ? 'danger' : 'safe'}">
        ${floatVal !== null && isAlert('float', floatVal) ? 'DANGER: FLOOD' : 'SAFE'}
      </div>
    </div>

    <!-- Card 4: Flame -->
    <div class="sensor-card flame">
      <div class="card-label">🔥 FLAME SENSOR</div>
      <div class="card-value">${flameVal !== null ? formatSensorVal('flame', flameVal) : 'SAFE'}</div>
      <div class="card-pill ${flameVal !== null && isAlert('flame', flameVal) ? 'danger' : 'safe'}">
        ${flameVal !== null && isAlert('flame', flameVal) ? 'DANGER: FIRE' : 'SAFE'}
      </div>
    </div>

    <!-- Card 5: Smoke -->
    <div class="sensor-card smoke">
      <div class="card-label">💨 SMOKE SENSOR</div>
      <div class="card-value">${smokeVal !== null ? formatSensorVal('smoke', smokeVal) : 'SAFE'}</div>
      <div class="card-pill ${smokeVal !== null && isAlert('smoke', smokeVal) ? 'danger' : 'safe'}">
        ${smokeVal !== null && isAlert('smoke', smokeVal) ? 'DANGER: SMOKE/GAS' : 'SAFE'}
      </div>
    </div>

    <!-- Card 6: Accelerometer -->
    <div class="sensor-card accel">
      <div class="card-label">📐 ACCELEROMETER</div>
      <div class="card-value" style="font-size: 1.5rem; margin-top: 10px; margin-bottom: 5px;">
        ${accelVal !== null ? formatSensorVal('accel', accelVal) : '0.00, 0.00, 1.00'}
      </div>
      <div class="card-pill safe">SAFE</div>
    </div>
  `;
}

// ── Alarm Loop & Warnings Checker ──
function checkAllPeerAlerts() {
  let anyAlert = false;
  const breachedSensors = [];

  for (const [peer, state] of nodeStates.entries()) {
    if (state.status === 'online' && state.sensors) {
      const s = state.sensors;
      if (s.temp !== undefined && s.temp > 40) breachedSensors.push('Temperature');
      if (s.vibration !== undefined && s.vibration === 1) breachedSensors.push('Vibration');
      if (s.float !== undefined && s.float === 1) breachedSensors.push('Float');
      if (s.flame !== undefined && s.flame === 1) breachedSensors.push('Flame');
      if (s.smoke !== undefined && s.smoke === 1) breachedSensors.push('Smoke');
    }
  }

  if (breachedSensors.length > 0) {
    anyAlert = true;
    alarmBanner.classList.remove('hidden');
    alarmSensorsEl.textContent = breachedSensors.join(', ');
  } else {
    alarmBanner.classList.add('hidden');
  }

  // Manage looping audio alarm
  if (anyAlert) {
    if (!alarmTimer) {
      if (!isMuted) {
        audio.play().catch(e => console.warn('Alarm audio block:', e.message));
      }
      alarmTimer = setInterval(() => {
        if (!isMuted) {
          audio.play().catch(e => console.warn('Alarm loop audio block:', e.message));
        }
      }, 20000);
    }
  } else {
    if (alarmTimer) {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
  }
}

// ── Update Peers Sub-header Bar ──
function updatePeersBar() {
  const activePeers = [...nodeStates.entries()]
    .filter(([peer, state]) => state.status === 'online')
    .map(([peer]) => peer);

  if (activePeers.length > 0) {
    peersListEl.textContent = activePeers.join(', ');
    // Auto-focus active remote peer for telemetry
    activePeerName = activePeers[0];
  } else {
    peersListEl.textContent = 'No active remote nodes detected';
  }
}

// ── Socket events ──
socket.on('node-info', (name) => {
  myNodeName = name;
  nodeNameBadge.textContent = name;
  document.title = `${name} — Mesh Network`;
  appendConsoleLine(`[SYSTEM] Local Node designated as ${name}.`, 'system');
});

socket.on('status-change', (connected) => {
  serialDot.classList.toggle('online', connected);
  serialLabel.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
  
  if (connected) {
    serialLostBanner.classList.add('hidden');
  } else {
    serialLostBanner.classList.remove('hidden');
  }
  appendConsoleLine(`[SYSTEM] Serial connection ${connected ? 'established' : 'lost'}.`, 'system');
});

socket.on('peer-status-list', (list) => {
  nodeStates.clear();
  list.forEach(({ peer, status, sensors }) => {
    nodeStates.set(peer, { status, sensors: sensors || {} });
  });
  updatePeersBar();
  renderTelemetryGrid();
  checkAllPeerAlerts();
});

socket.on('peer-status', ({ peer, status, sensors }) => {
  const existing = nodeStates.get(peer) || { sensors: {} };
  nodeStates.set(peer, { status, sensors: sensors || existing.sensors });
  updatePeersBar();
  renderTelemetryGrid();
  checkAllPeerAlerts();
});

socket.on('sensor-update', ({ peer, sensors }) => {
  const existing = nodeStates.get(peer) || { status: 'online' };
  existing.sensors = sensors;
  nodeStates.set(peer, existing);
  updatePeersBar();
  renderTelemetryGrid();
  checkAllPeerAlerts();
});

socket.on('raw-telemetry-line', (line) => {
  // Identify direction of the console line
  const isOutgoing = line.startsWith(`${myNodeName}|`) && !line.includes('|ACK|') && !line.includes('|PING');
  appendConsoleLine(line, isOutgoing ? 'outgoing' : 'incoming');
});

socket.on('receive-message', ({ id, sender, text, rssi, timestamp }) => {
  addMessage(id, sender, text, rssi, timestamp);
  // Log message in PuTTY console too
  appendConsoleLine(`[MSG RECEIVED] ${sender}: ${text} ${rssi ? `(${rssi} dBm)` : ''}`, 'incoming');
});

socket.on('message-status', ({ id, status, rssi }) => {
  const statusEl = document.getElementById(`status-${id}`);
  if (statusEl) {
    if (statusEl.classList.contains('delivered')) return;
    const labels = {
      sent:      '✓ Sent',
      delivered: '✓✓ Delivered',
      'no-ack':  '✓ Sent (no ACK)',
      failed:    '✗ Failed — serial error',
    };
    statusEl.className = `msg-status ${status}`;
    statusEl.textContent = labels[status] ?? status;
  }
  appendConsoleLine(`[MSG STATUS] ID ${id}: ${status} ${rssi ? `(${rssi} dBm)` : ''}`, 'system');
});

// ── Chat ──
function addMessage(id, sender, text, rssi, timestamp) {
  if (id && document.getElementById(`msg-wrap-${id}`)) return;

  const isOwn = sender === myNodeName;
  if (msgCount === 0) {
    const activeEmptyChat = document.getElementById('empty-chat');
    if (activeEmptyChat) activeEmptyChat.remove();
  }
  msgCount++;

  const div = document.createElement('div');
  div.className = `message ${isOwn ? 'own' : 'peer'}`;
  div.id = `msg-wrap-${id}`;
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-sender">${sender}</span>
      <span>${timeStr(timestamp)}</span>
      ${rssi ? `<span class="rssi-badge" id="rssi-${id}">${rssi} dBm</span>` : (id ? `<span class="rssi-badge" id="rssi-${id}"></span>` : '')}
    </div>
    <div class="msg-bubble">${escHtml(text)}</div>
    ${(id && isOwn) ? `<div class="msg-status sent" id="status-${id}">✓ Sent</div>` : ''}
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  
  if (!isOwn && !isMuted) {
    audio.play().catch(e => console.warn('Chime audio play block:', e.message));
  }
}

// ── Send chat message ──
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;
  const id = genId();
  socket.emit('send-message', { id, text });
  
  // Optimistically display the message
  addMessage(id, myNodeName, text, null, new Date().toISOString());
  msgInput.value = '';
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

// ── Sidebar view toggler ──
toggleViewBtn.addEventListener('click', () => {
  if (sidebarMode === 'serial') {
    // Switch to Chat View
    sidebarMode = 'chat';
    toggleViewBtn.textContent = 'Serial View';
    sidebarTitle.textContent = 'SECURE CHAT LINK';
    serialConsoleView.classList.add('hidden');
    clearConsoleBtn.classList.add('hidden');
    chatView.classList.remove('hidden');
  } else {
    // Switch to Serial View
    sidebarMode = 'serial';
    toggleViewBtn.textContent = 'Chat View';
    sidebarTitle.textContent = 'SERIAL STREAM (PUTTY FEED)';
    chatView.classList.add('hidden');
    serialConsoleView.classList.remove('hidden');
    clearConsoleBtn.classList.remove('hidden');
  }
});

// ── Clear console log ──
clearConsoleBtn.addEventListener('click', () => {
  consoleLog.innerHTML = '<div class="console-line system">[SYSTEM] Console log cleared.</div>';
});

// ── Sound control ──
if (soundToggle) {
  soundToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    if (isMuted) {
      soundToggle.classList.add('muted');
      soundToggle.title = 'Unmute Notifications';
      soundIcon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"></path>';
    } else {
      soundToggle.classList.remove('muted');
      soundToggle.title = 'Mute Notifications';
      soundIcon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"></path>';
    }
  });
}

// ── Initial Render ──
renderTelemetryGrid();
