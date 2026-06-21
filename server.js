const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const PORT = process.env.PORT || process.argv[3] || 3000;
const COM_PORT = process.env.COM_PORT || process.argv[2] || 'COM5';
const BAUD_RATE = parseInt(process.env.BAUD_RATE) || 115200;
const CURRENT_NODE = process.env.CURRENT_NODE || process.argv[4] || 'NODEA';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/mock-telemetry', (req, res) => {
  const line = req.query.line;
  if (line) {
    console.log(`[HTTP MOCK TELEMETRY]: ${line}`);
    // Simulate serial data receipt
    parser.emit('data', line);
    res.send(`Mocked line: ${line}`);
  } else {
    res.status(400).send('Provide a "line" query parameter, e.g., /mock-telemetry?line=Temp:24.5');
  }
});

const port = new SerialPort({
  path: COM_PORT,
  baudRate: BAUD_RATE,
  autoOpen: false
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

let isSerialConnected = false;
const activePeers = new Map(); // peerName -> lastSeenTimestamp
const pendingMessages = new Map(); // msgId -> timer
const peerSensors = new Map(); // peerName -> sensorsObj

function updatePeerStatus(peer) {
  const isNew = !activePeers.has(peer) || activePeers.get(peer) === 0;
  activePeers.set(peer, Date.now());
  if (isNew) {
    io.emit('peer-status', { peer, status: 'online', sensors: peerSensors.get(peer) || {} });
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

function parseSensorTelemetry(line) {
  // 1. Try parsing as JSON
  try {
    const data = JSON.parse(line);
    const keys = ['temp', 'temperature', 'vib', 'vibration', 'float', 'flame', 'smoke', 'accel'];
    if (Object.keys(data).some(k => keys.includes(k.toLowerCase()))) {
      return {
        temp: data.temp !== undefined ? data.temp : data.temperature,
        vibration: data.vibration !== undefined ? data.vibration : data.vib,
        float: data.float,
        flame: data.flame,
        smoke: data.smoke,
        accel: data.accel
      };
    }
  } catch (e) {}

  // 2. Try parsing with RegEx for key-value formats (e.g. "Temp: 24.5", "Float: 1", etc.)
  const telemetry = {};
  let matched = false;

  const tempMatch = line.match(/(?:temp(?:erature)?)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
  if (tempMatch) {
    telemetry.temp = parseFloat(tempMatch[1]);
    matched = true;
  }

  const vibMatch = line.match(/(?:vib(?:ration)?)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
  if (vibMatch) {
    const rawVal = vibMatch[1];
    telemetry.vibration = (rawVal === '1' || rawVal.toLowerCase() === 'true' || rawVal.toLowerCase() === 'danger' || rawVal.toLowerCase() === 'high') ? 1 : 0;
    matched = true;
  }

  const floatMatch = line.match(/(?:float)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
  if (floatMatch) {
    const rawVal = floatMatch[1];
    telemetry.float = (rawVal === '1' || rawVal.toLowerCase() === 'true' || rawVal.toLowerCase() === 'danger' || rawVal.toLowerCase() === 'high') ? 1 : 0;
    matched = true;
  }

  const flameMatch = line.match(/(?:flame)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
  if (flameMatch) {
    const rawVal = flameMatch[1];
    telemetry.flame = (rawVal === '1' || rawVal.toLowerCase() === 'true' || rawVal.toLowerCase() === 'danger' || rawVal.toLowerCase() === 'high') ? 1 : 0;
    matched = true;
  }

  const smokeMatch = line.match(/(?:smoke|gas)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
  if (smokeMatch) {
    const rawVal = smokeMatch[1];
    telemetry.smoke = (rawVal === '1' || rawVal.toLowerCase() === 'true' || rawVal.toLowerCase() === 'danger' || rawVal.toLowerCase() === 'high') ? 1 : 0;
    matched = true;
  }

  const accelMatch = line.match(/(?:accel(?:erometer)?|acc)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?(?:\s*,\s*[+-]?\d+(?:\.\d+)?){2}|[+-]?\d+(?:\.\d+)?)/i);
  if (accelMatch) {
    telemetry.accel = accelMatch[1];
    matched = true;
  } else {
    // Try matching individual X, Y, Z axes
    const xMatch = line.match(/x\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
    const yMatch = line.match(/y\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
    const zMatch = line.match(/z\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/i);
    if (xMatch || yMatch || zMatch) {
      const x = xMatch ? parseFloat(xMatch[1]) : 0;
      const y = yMatch ? parseFloat(yMatch[1]) : 0;
      const z = zMatch ? parseFloat(zMatch[1]) : 0;
      telemetry.accel = `${x}, ${y}, ${z}`;
      matched = true;
    }
  }

  if (matched) {
    return telemetry;
  }
  return null;
}

parser.on('data', (data) => {
  const line = data.trim();
  if (!line) return;

  // Broadcast raw line for the terminal feed
  io.emit('raw-telemetry-line', line);

  // Try to parse sensor data from the entire line first (robust to both old and new formats)
  const sensorData = parseSensorTelemetry(line);

  // Parse peer name and body payload if structured as: SENDER|BODY
  const parts = line.split('|');
  let sender = 'Unknown';
  let payload = line;
  let isProtocol = false;

  if (parts.length >= 2) {
    sender = parts[0];
    payload = parts[1];
    isProtocol = true;
  }

  // Ignore message echoes from ourselves, if any (except sensor updates)
  if (sender === CURRENT_NODE && !sensorData) return;

  if (isProtocol) {
    // Update peer online timestamp
    updatePeerStatus(sender);
  }

  // Try to parse sensor data from the payload or line
  if (sensorData) {
    peerSensors.set(sender, sensorData);
    io.emit('sensor-update', { peer: sender, sensors: sensorData });

    // Check thresholds and emit warnings
    const warnings = [];
    if (sensorData.temp > 40) warnings.push(`High Temperature: ${sensorData.temp}°C`);
    if (sensorData.vibration === 1) warnings.push(`Vibration Alert`);
    if (sensorData.float === 1) warnings.push(`Float Sensor Alert`);
    if (sensorData.flame === 1) warnings.push(`Flame detected`);
    if (sensorData.smoke === 1) warnings.push(`Smoke/Gas Alert`);

    if (warnings.length > 0) {
      io.emit('warning', {
        peer: sender,
        timestamp: new Date().toISOString(),
        reason: warnings.join(', ')
      });
    }
  }

  // Handle standard protocol chat messages
  if (isProtocol && !sensorData) {
    const typeOrText = parts[1];

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
        // Add a 50ms delay to allow the receiving STM32 to finish printing
        // the message and safely return to its RX loop state before it receives the ACK.
        setTimeout(() => {
          port.write(ackPacket, (err) => {
            if (err) {
              console.error(`Error sending ACK: ${err.message}`);
            }
          });
        }, 50);
      }
    }
  } else if (!sensorData) {
    // Non-protocol line - display it in the chat/telemetry feed
    const timestamp = new Date().toISOString();
    io.emit('receive-message', {
      id: 'telemetry-' + Date.now(),
      sender: 'Raw Data',
      text: line,
      rssi: null,
      timestamp
    });
  }
});

io.on('connection', (socket) => {
  socket.emit('node-info', CURRENT_NODE);
  socket.emit('status-change', isSerialConnected);

  // Send initial list of peers and their statuses
  const peerList = Array.from(activePeers.entries()).map(([peer, lastSeen]) => ({
    peer,
    status: (lastSeen > 0 && (Date.now() - lastSeen < 60000)) ? 'online' : 'offline',
    sensors: peerSensors.get(peer) || {}
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
