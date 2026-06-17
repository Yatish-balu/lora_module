const socket = io();

const nodeBadge = document.getElementById('node-badge');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const disconnectAlert = document.getElementById('disconnect-alert');
const chatArea = document.getElementById('chat-area');
const emptyState = document.getElementById('empty-state');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const soundToggle = document.getElementById('sound-toggle');
const soundIcon = document.getElementById('sound-icon');
const peersList = document.getElementById('peers-list');

let currentNode = '';
let isMuted = false;
const peersMap = new Map(); // peerName -> 'online' | 'offline'

function renderPeers() {
  if (peersMap.size === 0) {
    peersList.innerHTML = '<span class="no-peers">No active remote nodes detected</span>';
    return;
  }
  peersList.innerHTML = '';
  for (const [peer, status] of peersMap.entries()) {
    const badge = document.createElement('div');
    badge.className = `peer-badge ${status}`;
    badge.innerHTML = `
      <span class="peer-dot ${status}"></span>
      <span>${escapeHTML(peer)}</span>
      <span style="font-size: 0.65rem; font-weight: normal; margin-left: 2px;">
        (${status.toUpperCase()})
      </span>
    `;
    peersList.appendChild(badge);
  }
}

// Dynamically generate a clean 8-bit WAV audio URI for a notification ping
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
    const volume = Math.exp(-t * 15); // rapid decay for crisp beep
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

const SOUND_ON_PATH = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
const SOUND_MUTED_PATH = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';

if (soundToggle && soundIcon) {
  soundToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    if (isMuted) {
      soundIcon.innerHTML = `<path d="${SOUND_MUTED_PATH}"></path>`;
      soundToggle.title = 'Unmute Notifications';
    } else {
      soundIcon.innerHTML = `<path d="${SOUND_ON_PATH}"></path>`;
      soundToggle.title = 'Mute Notifications';
      // User interaction permits sound playback
      audio.play().catch(() => {});
    }
  });
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function formatTime(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return '';
  }
}

socket.on('node-info', (nodeName) => {
  currentNode = nodeName;
  nodeBadge.textContent = nodeName;
});

socket.on('status-change', (isConnected) => {
  if (isConnected) {
    statusIndicator.className = 'status-dot online';
    statusText.textContent = 'CONNECTED';
    disconnectAlert.style.display = 'none';
    messageInput.removeAttribute('disabled');
    sendButton.removeAttribute('disabled');
    messageInput.placeholder = 'Type your message...';
  } else {
    statusIndicator.className = 'status-dot offline';
    statusText.textContent = 'DISCONNECTED';
    disconnectAlert.style.display = 'block';
    messageInput.setAttribute('disabled', 'true');
    sendButton.setAttribute('disabled', 'true');
    messageInput.placeholder = 'Serial port disconnected...';
  }
});

socket.on('peer-status-list', (list) => {
  peersMap.clear();
  list.forEach(({ peer, status }) => {
    peersMap.set(peer, status);
  });
  renderPeers();
});

socket.on('peer-status', ({ peer, status }) => {
  peersMap.set(peer, status);
  renderPeers();
});

socket.on('message-status', ({ id, status, rssi }) => {
  const icon = document.getElementById(`status-icon-${id}`);
  if (icon) {
    icon.className = `msg-status-icon ${status}`;
    if (status === 'sending') {
      icon.textContent = '🕐';
    } else if (status === 'sent') {
      icon.textContent = '✓';
    } else if (status === 'delivered') {
      icon.textContent = '✓✓';
      if (rssi) {
        const meta = icon.closest('.message-meta');
        if (meta && !meta.querySelector('.rssi-badge')) {
          const rssiBadge = document.createElement('span');
          rssiBadge.className = 'rssi-badge';
          rssiBadge.innerHTML = `📶 ${escapeHTML(rssi)} dBm`;
          meta.insertBefore(rssiBadge, icon);
        }
      }
    } else if (status === 'failed') {
      icon.textContent = '✗';
    }
  }
});

socket.on('receive-message', (data) => {
  const activeEmptyState = document.getElementById('empty-state');
  if (activeEmptyState) {
    activeEmptyState.remove();
  }
  
  const isSent = data.sender === currentNode;
  const messageClass = isSent ? 'sent' : 'received';
  
  if (!isSent && !isMuted) {
    audio.play().catch(err => {
      console.warn('Audio playback failed or blocked:', err.message);
    });
  }
  
  // Check if we already have this message in DOM to avoid duplicates
  let messageDiv = data.id ? document.getElementById(`msg-div-${data.id}`) : null;
  if (messageDiv) return;
  
  messageDiv = document.createElement('div');
  if (data.id) {
    messageDiv.id = `msg-div-${data.id}`;
  }
  messageDiv.className = `message ${messageClass}`;
  
  let rssiHtml = '';
  if (data.rssi) {
    rssiHtml = `<span class="rssi-badge">📶 ${escapeHTML(data.rssi)} dBm</span>`;
  }
  
  const formattedTime = formatTime(data.timestamp);
  
  let statusHtml = '';
  if (isSent && data.id) {
    statusHtml = `<span class="msg-status-icon sending" id="status-icon-${data.id}">🕐</span>`;
  }
  
  messageDiv.innerHTML = `
    <span class="message-text">${escapeHTML(data.text)}</span>
    <div class="message-meta">
      ${rssiHtml}
      <span class="message-time">${formattedTime}</span>
      ${statusHtml}
    </div>
  `;
  
  chatArea.appendChild(messageDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (text) {
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    socket.emit('send-message', { id: msgId, text });
    messageInput.value = '';
    messageInput.focus();
  }
});
