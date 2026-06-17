const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const PORT = 3000;
const COM_PORT = 'COM5';
const BAUD_RATE = 115200;
const CURRENT_NODE = 'NODEA';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const port = new SerialPort({
  path: COM_PORT,
  baudRate: BAUD_RATE,
  autoOpen: false
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

let isSerialConnected = false;
const activePeers = new Map(); // peerName -> lastSeenTimestamp
const pendingMessages = new Map(); // msgId -> timer

function updatePeerStatus(peer) {
  const isNew = !activePeers.has(peer) || activePeers.get(peer) === 0;
  activePeers.set(peer, Date.now());
  if (isNew) {
    io.emit('peer-status', { peer, status: 'online' });
  }
}

function trackMessageTimeout(msgId) {
  if (pendingMessages.has(msgId)) {
    clearTimeout(pendingMessages.get(msgId));
  }
  const timer = setTimeout(() => {
    pendingMessages.delete(msgId);
    io.emit('message-status', { id: msgId, status: 'failed' });
  }, 10000); // 10s timeout
  pendingMessages.set(msgId, timer);
}

// Timeout check running every 5 seconds
setInterval(() => {
  const now = Date.now();
  for (const [peer, lastSeen] of activePeers.entries()) {
    if (lastSeen > 0 && now - lastSeen >= 60000) {
      activePeers.set(peer, 0); // Mark offline
      io.emit('peer-status', { peer, status: 'offline' });
    }
  }
}, 5000);

// Broadcast periodic ping every 30 seconds
setInterval(() => {
  const pingPacket = `${CURRENT_NODE}|PING\r\n`;
  if (isSerialConnected) {
    port.write(pingPacket, (err) => {
      if (err) {
        console.error(`Error sending Ping: ${err.message}`);
      }
    });
  }
}, 30000);

function attemptSerialConnection() {
  if (port.isOpen) {
    return;
  }
  port.open((err) => {
    if (err) {
      console.log(`Failed to open serial port: ${err.message}`);
      isSerialConnected = false;
      io.emit('status-change', false);
      setTimeout(attemptSerialConnection, 5000);
    }
  });
}

port.on('open', () => {
  console.log(`Serial port connected`);
  isSerialConnected = true;
  io.emit('status-change', true);
});

port.on('close', () => {
  console.log(`Serial port closed`);
  isSerialConnected = false;
  io.emit('status-change', false);
  setTimeout(attemptSerialConnection, 5000);
});

port.on('error', (err) => {
  console.error(`Serial port error: ${err.message}`);
});

parser.on('data', (data) => {
  const line = data.trim();
  if (!line) return;
  const parts = line.split('|');
  if (parts.length >= 2) {
    const sender = parts[0];
    const typeOrText = parts[1];
    
    // Ignore message echoes from ourselves, if any
    if (sender === CURRENT_NODE) return;

    // Update peer online timestamp
    updatePeerStatus(sender);

    if (typeOrText === 'PING') {
      console.log(`Ping received from ${sender}`);
      return;
    }

    if (typeOrText === 'ACK') {
      const ackMsgId = parts[2];
      const rssi = parts[3] || null;
      console.log(`ACK received from ${sender} for message ${ackMsgId}`);
      if (pendingMessages.has(ackMsgId)) {
        clearTimeout(pendingMessages.get(ackMsgId));
        pendingMessages.delete(ackMsgId);
      }
      io.emit('message-status', { id: ackMsgId, status: 'delivered', rssi });
      return;
    }

    // Normal message packet
    let msgId = null;
    let text = typeOrText;
    let rssi = null;

    if (parts.length >= 3) {
      if (parts[2].startsWith('msg-')) {
        msgId = parts[2];
        rssi = parts[3] || null;
      } else {
        rssi = parts[2];
      }
    }

    const timestamp = new Date().toISOString();
    io.emit('receive-message', { id: msgId, sender, text, rssi, timestamp });

    // Send ACK back over serial if we have a msgId
    if (msgId) {
      const ackPacket = `${CURRENT_NODE}|ACK|${msgId}\r\n`;
      if (isSerialConnected) {
        port.write(ackPacket, (err) => {
          if (err) {
            console.error(`Error sending ACK: ${err.message}`);
          }
        });
      }
    }
  }
});

io.on('connection', (socket) => {
  socket.emit('node-info', CURRENT_NODE);
  socket.emit('status-change', isSerialConnected);

  // Send initial list of peers and their statuses
  const peerList = Array.from(activePeers.entries()).map(([peer, lastSeen]) => ({
    peer,
    status: (lastSeen > 0 && (Date.now() - lastSeen < 60000)) ? 'online' : 'offline'
  }));
  socket.emit('peer-status-list', peerList);

  // Testing helper to simulate incoming packets over serial
  socket.on('mock-serial-input', (line) => {
    console.log(`[MOCK SERIAL INPUT]: ${line}`);
    parser.emit('data', line);
  });

  socket.on('send-message', ({ id, text }) => {
    const packet = `${CURRENT_NODE}|${text}|${id}\r\n`;
    if (isSerialConnected) {
      port.write(packet, (err) => {
        if (err) {
          console.error(`Write error: ${err.message}`);
          io.emit('message-status', { id, status: 'failed' });
        } else {
          io.emit('message-status', { id, status: 'sent' });
          trackMessageTimeout(id);
        }
      });
    } else {
      io.emit('message-status', { id, status: 'failed' });
    }

    const timestamp = new Date().toISOString();
    io.emit('receive-message', {
      id,
      sender: CURRENT_NODE,
      text,
      rssi: null,
      timestamp
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  attemptSerialConnection();
});
