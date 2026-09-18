const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/vexflow.js', express.static(path.join(__dirname, 'node_modules/vexflow/build/cjs/vexflow.js')));
app.use('/vendor/midiwriter.js', express.static(path.join(__dirname, 'node_modules/midi-writer-js/browser/midiwriter.js')));
app.use('/vendor/lame.min.js', express.static(path.join(__dirname, 'node_modules/lamejs/lame.min.js')));

app.listen(PORT, () => {
  console.log(`MIDI transcriber running at http://localhost:${PORT}`);
});
