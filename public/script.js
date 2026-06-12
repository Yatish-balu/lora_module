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

let currentNode = '';

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

socket.on('receive-message', (data) => {
  const activeEmptyState = document.getElementById('empty-state');
  if (activeEmptyState) {
    activeEmptyState.remove();
  }
  
  const isSent = data.sender === currentNode;
  const messageClass = isSent ? 'sent' : 'received';
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${messageClass}`;
  
  let rssiHtml = '';
  if (data.rssi) {
    rssiHtml = `<span class="rssi-badge">📶 ${escapeHTML(data.rssi)} dBm</span>`;
  }
  
  const formattedTime = formatTime(data.timestamp);
  
  messageDiv.innerHTML = `
    <span class="message-text">${escapeHTML(data.text)}</span>
    <div class="message-meta">
      ${rssiHtml}
      <span class="message-time">${formattedTime}</span>
    </div>
  `;
  
  chatArea.appendChild(messageDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (text) {
    socket.emit('send-message', text);
    messageInput.value = '';
    messageInput.focus();
  }
});
