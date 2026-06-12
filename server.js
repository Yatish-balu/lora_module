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
    const text = parts[1];
    const rssi = parts[2] || null;
    const timestamp = new Date().toISOString();
    io.emit('receive-message', { sender, text, rssi, timestamp });
  }
});

io.on('connection', (socket) => {
  socket.emit('node-info', CURRENT_NODE);
  socket.emit('status-change', isSerialConnected);
  socket.on('send-message', (msgText) => {
    const packet = `${CURRENT_NODE}|${msgText}\r\n`;
    if (isSerialConnected) {
      port.write(packet, (err) => {
        if (err) {
          console.error(`Write error: ${err.message}`);
        }
      });
    }
    const timestamp = new Date().toISOString();
    io.emit('receive-message', {
      sender: CURRENT_NODE,
      text: msgText,
      rssi: null,
      timestamp
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  attemptSerialConnection();
});
