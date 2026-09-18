const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const HOST = '127.0.0.1';
const PID_FILE = path.join(os.homedir(), '.midi-music-app.pid');
const MAX_PORT_TRIES = 20;

function requestedPort() {
  const flag = process.argv.indexOf('--port');
  if (flag !== -1 && process.argv[flag + 1]) return Number(process.argv[flag + 1]);
  return Number(process.env.PORT) || 3000;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/vexflow.js', express.static(path.join(__dirname, 'node_modules/vexflow/build/cjs/vexflow.js')));
app.use('/vendor/midiwriter.js', express.static(path.join(__dirname, 'node_modules/midi-writer-js/browser/midiwriter.js')));
app.use('/vendor/lame.min.js', express.static(path.join(__dirname, 'node_modules/lamejs/lame.min.js')));

function cleanupPidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').split(' ')[0] === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

function listen(port, triesLeft) {
  const server = app.listen(port, HOST, (err) => {
    if (err) return;
    fs.writeFileSync(PID_FILE, `${process.pid} ${port}\n`);
    console.log(`MIDI transcriber running at http://localhost:${port}`);
    if (port !== requestedPort()) console.log(`(port ${requestedPort()} was busy)`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      listen(port + 1, triesLeft - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`Ports ${requestedPort()}–${port} are all in use. Try: midi-music-app --port 8080`);
      process.exit(1);
    } else {
      throw err;
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanupPidFile();
    process.exit(0);
  });
}
process.on('exit', cleanupPidFile);

listen(requestedPort(), MAX_PORT_TRIES);
