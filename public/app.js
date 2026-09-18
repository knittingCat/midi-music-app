const VF = VexFlow;

const statusEl = document.getElementById('status');
const deviceSelect = document.getElementById('deviceSelect');
const tempoInput = document.getElementById('tempo');
const timeSigSelect = document.getElementById('timeSig');
const logEl = document.getElementById('log');
const notationEl = document.getElementById('notation');

const CHORD_WINDOW_MS = 60;
const REST_THRESHOLD_MS = 120;
const IDLE_FLUSH_MS = 900;

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const DURATION_CANDIDATES = [
  { beats: 4, code: 'w' },
  { beats: 2, code: 'h' },
  { beats: 1, code: 'q' },
  { beats: 0.5, code: '8' },
  { beats: 0.25, code: '16' },
];

// finalized events: { treble: [keys]|[], bass: [keys]|[], duration: 'w'|'h'|'q'|'8'|'16' }
let events = [];
let currentChord = null; // { onsetTime, notes: Map(pitch -> name), lastNoteOffTime, allReleased }
let lastChordReleaseTime = null;
let idleCheckTimer = null;

function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.textContent = (line + '\n' + logEl.textContent).split('\n').slice(0, 100).join('\n');
}

function midiToKey(pitch) {
  const octave = Math.floor(pitch / 12) - 1;
  const name = NOTE_NAMES[pitch % 12];
  return { vexKey: `${name}/${octave}`, display: `${name.toUpperCase()}${octave}` };
}

function quantizeToDuration(ms, tempoBpm) {
  const quarterMs = 60000 / tempoBpm;
  const ratio = Math.max(ms / quarterMs, 0.125);
  let best = DURATION_CANDIDATES[0];
  let bestDist = Infinity;
  for (const cand of DURATION_CANDIDATES) {
    const dist = Math.abs(Math.log2(ratio) - Math.log2(cand.beats));
    if (dist < bestDist) { bestDist = dist; best = cand; }
  }
  return best.code;
}

function durationBeats(code) {
  return DURATION_CANDIDATES.find((c) => c.code === code).beats;
}

function splitChordByClef(notesMap) {
  const treble = [];
  const bass = [];
  for (const [pitch, info] of notesMap.entries()) {
    (pitch >= 60 ? treble : bass).push(info.vexKey);
  }
  return { treble, bass };
}

function pushRestEvent(gapMs) {
  const tempo = Number(tempoInput.value) || 120;
  const code = quantizeToDuration(gapMs, tempo);
  events.push({ treble: [], bass: [], duration: code });
}

function finalizeChord(chord, durationMs) {
  const tempo = Number(tempoInput.value) || 120;
  const code = quantizeToDuration(durationMs, tempo);
  const { treble, bass } = splitChordByClef(chord.notes);
  events.push({ treble, bass, duration: code });
  const names = [...chord.notes.values()].map((n) => n.display).join(' ');
  log(`Note(s): ${names}  (${code})`);
}

function onNoteOn(pitch, velocity) {
  const now = performance.now();
  const { vexKey, display } = midiToKey(pitch);

  if (currentChord && !currentChord.allReleased && now - currentChord.onsetTime <= CHORD_WINDOW_MS) {
    currentChord.notes.set(pitch, { vexKey, display });
    render();
    return;
  }

  if (currentChord) {
    finalizeChord(currentChord, now - currentChord.onsetTime);
    lastChordReleaseTime = currentChord.lastNoteOffTime || now;
  }

  const gapStart = lastChordReleaseTime;
  if (gapStart != null) {
    const gap = now - gapStart;
    if (gap > REST_THRESHOLD_MS) pushRestEvent(gap);
  }

  currentChord = {
    onsetTime: now,
    notes: new Map([[pitch, { vexKey, display }]]),
    lastNoteOffTime: null,
    allReleased: false,
  };
  render();
}

function onNoteOff(pitch) {
  if (!currentChord || !currentChord.notes.has(pitch)) return;
  const now = performance.now();
  currentChord.lastNoteOffTime = now;
  const remaining = [...currentChord.notes.keys()];
  currentChord._released = currentChord._released || new Set();
  currentChord._released.add(pitch);
  if (remaining.every((p) => currentChord._released.has(p))) {
    currentChord.allReleased = true;
  }
}

function idleFlushCheck() {
  if (!currentChord || !currentChord.allReleased) return;
  const now = performance.now();
  if (now - currentChord.lastNoteOffTime > IDLE_FLUSH_MS) {
    const durationMs = currentChord.lastNoteOffTime - currentChord.onsetTime;
    finalizeChord(currentChord, durationMs);
    lastChordReleaseTime = currentChord.lastNoteOffTime;
    currentChord = null;
    render();
  }
}
idleCheckTimer = setInterval(idleFlushCheck, 250);

document.getElementById('finalizeBtn').addEventListener('click', () => {
  if (!currentChord) return;
  const now = performance.now();
  finalizeChord(currentChord, now - currentChord.onsetTime);
  lastChordReleaseTime = currentChord.lastNoteOffTime || now;
  currentChord = null;
  render();
});

document.getElementById('clearBtn').addEventListener('click', () => {
  events = [];
  currentChord = null;
  lastChordReleaseTime = null;
  log('Cleared session.');
  render();
});

// ---------- Rendering ----------

function timeSigBeatsInQuarters() {
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  return num * (4 / den);
}

function groupIntoMeasures() {
  const measureCapacity = timeSigBeatsInQuarters();
  const measures = [];
  let current = [];
  let acc = 0;
  for (const ev of events) {
    current.push(ev);
    acc += durationBeats(ev.duration);
    if (acc >= measureCapacity - 1e-6) {
      measures.push(current);
      current = [];
      acc = 0;
    }
  }
  if (current.length) measures.push(current);
  return measures;
}

function buildStaveNotes(measureEvents, clef) {
  return measureEvents.map((ev) => {
    const keys = ev[clef];
    if (keys.length === 0) {
      return new VF.StaveNote({ keys: [clef === 'treble' ? 'b/4' : 'd/3'], duration: ev.duration + 'r' });
    }
    return new VF.StaveNote({ keys, duration: ev.duration, clef });
  });
}

function render() {
  notationEl.innerHTML = '';
  const measures = groupIntoMeasures();
  if (measures.length === 0) return;

  const MEASURES_PER_ROW = 4;
  const MEASURE_WIDTH = 220;
  const ROW_HEIGHT = 200;
  const rows = Math.ceil(measures.length / MEASURES_PER_ROW);
  const width = Math.min(measures.length, MEASURES_PER_ROW) * MEASURE_WIDTH + 40;
  const height = rows * ROW_HEIGHT + 40;

  const renderer = new VF.Renderer(notationEl, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();

  measures.forEach((measureEvents, i) => {
    const col = i % MEASURES_PER_ROW;
    const row = Math.floor(i / MEASURES_PER_ROW);
    const x = 20 + col * MEASURE_WIDTH;
    const y = 20 + row * ROW_HEIGHT;
    const w = MEASURE_WIDTH - (col === MEASURES_PER_ROW - 1 ? 20 : 0);

    const trebleStave = new VF.Stave(x, y, w);
    const bassStave = new VF.Stave(x, y + 90, w);
    if (col === 0) {
      trebleStave.addClef('treble');
      bassStave.addClef('bass');
      if (i === 0) {
        trebleStave.addTimeSignature(timeSigSelect.value);
        bassStave.addTimeSignature(timeSigSelect.value);
      }
    }
    trebleStave.setContext(ctx).draw();
    bassStave.setContext(ctx).draw();
    new VF.StaveConnector(trebleStave, bassStave).setType('brace').setContext(ctx).draw();
    new VF.StaveConnector(trebleStave, bassStave).setType('singleLeft').setContext(ctx).draw();

    const trebleNotes = buildStaveNotes(measureEvents, 'treble');
    const bassNotes = buildStaveNotes(measureEvents, 'bass');

    const [num, den] = timeSigSelect.value.split('/').map(Number);
    const trebleVoice = new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false);
    trebleVoice.addTickables(trebleNotes);
    const bassVoice = new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false);
    bassVoice.addTickables(bassNotes);

    new VF.Formatter().joinVoices([trebleVoice]).format([trebleVoice], w - 50);
    new VF.Formatter().joinVoices([bassVoice]).format([bassVoice], w - 50);
    trebleVoice.draw(ctx, trebleStave);
    bassVoice.draw(ctx, bassStave);
  });
}

// ---------- Web MIDI ----------

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || '';
}

function attachInput(input) {
  input.onmidimessage = (msg) => {
    const [status, data1, data2] = msg.data;
    const command = status & 0xf0;
    if (command === 0x90 && data2 > 0) {
      onNoteOn(data1, data2);
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      onNoteOff(data1);
    }
  };
  setStatus(`Connected: ${input.name}`, 'connected');
  log(`Listening on "${input.name}"`);
}

function populateDevices(midiAccess) {
  deviceSelect.innerHTML = '';
  const inputs = [...midiAccess.inputs.values()];
  if (inputs.length === 0) {
    deviceSelect.innerHTML = '<option>No MIDI devices found</option>';
    setStatus('No MIDI devices found. Plug in your keyboard and reload.', 'error');
    return;
  }
  inputs.forEach((input, i) => {
    const opt = document.createElement('option');
    opt.value = input.id;
    opt.textContent = input.name;
    deviceSelect.appendChild(opt);
  });
  deviceSelect.onchange = () => {
    const chosen = inputs.find((inp) => inp.id === deviceSelect.value);
    if (chosen) attachInput(chosen);
  };
  attachInput(inputs[0]);
}

if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(
    (midiAccess) => {
      populateDevices(midiAccess);
      midiAccess.onstatechange = () => populateDevices(midiAccess);
    },
    () => setStatus('MIDI access denied.', 'error')
  );
} else {
  setStatus('Web MIDI is not supported in this browser. Use Chrome or Edge.', 'error');
}

// ---------- Export: MusicXML ----------

function durationToXmlType(code) {
  return { w: 'whole', h: 'half', q: 'quarter', 8: 'eighth', 16: '16th' }[code];
}
function durationToDivisions(code) {
  return { w: 16, h: 8, q: 4, 8: 2, 16: 1 }[code];
}
function vexKeyToPitch(vexKey) {
  const [name, octave] = vexKey.split('/');
  const step = name[0].toUpperCase();
  const alter = name.includes('#') ? 1 : 0;
  return { step, alter, octave };
}

function buildMusicXml() {
  const measures = groupIntoMeasures();
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  let measuresXml = '';

  measures.forEach((measureEvents, mi) => {
    let noteXml = '';
    const attrs = mi === 0
      ? `<attributes><divisions>4</divisions><time><beats>${num}</beats><beat-type>${den}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
      : '';

    ['treble', 'bass'].forEach((clef, clefIdx) => {
      const staffNum = clefIdx + 1;
      const voiceNum = staffNum;
      measureEvents.forEach((ev) => {
        const keys = ev[clef];
        const type = durationToXmlType(ev.duration);
        const dur = durationToDivisions(ev.duration);
        if (keys.length === 0) {
          noteXml += `<note><rest/><duration>${dur}</duration><voice>${voiceNum}</voice><type>${type}</type><staff>${staffNum}</staff></note>`;
        } else {
          keys.forEach((k, idx) => {
            const { step, alter, octave } = vexKeyToPitch(k);
            noteXml += `<note>${idx > 0 ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${dur}</duration><voice>${voiceNum}</voice><type>${type}</type><staff>${staffNum}</staff></note>`;
          });
        }
      });
      if (clefIdx === 0) noteXml += `<backup><duration>${measureEvents.reduce((s, ev) => s + durationToDivisions(ev.duration), 0)}</duration></backup>`;
    });

    measuresXml += `<measure number="${mi + 1}">${attrs}${noteXml}</measure>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">${measuresXml}</part>
</score-partwise>`;
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('exportMusicXml').addEventListener('click', () => {
  if (events.length === 0) { log('Nothing to export yet.'); return; }
  downloadBlob(buildMusicXml(), 'transcription.musicxml', 'application/vnd.recordare.musicxml+xml');
  log('Exported MusicXML.');
});

// ---------- Export: MIDI ----------

function vexKeyToMidiWriterPitch(vexKey) {
  const [name, octave] = vexKey.split('/');
  return `${name.replace('#', '#').toUpperCase()}${octave}`;
}

document.getElementById('exportMidi').addEventListener('click', () => {
  if (events.length === 0) { log('Nothing to export yet.'); return; }
  const tempo = Number(tempoInput.value) || 120;
  const tracks = ['treble', 'bass'].map((clef) => {
    const track = new MidiWriter.Track();
    track.setTempo(tempo);
    let pendingWait = [];
    events.forEach((ev) => {
      const keys = ev[clef];
      if (keys.length === 0) {
        pendingWait.push(ev.duration);
        return;
      }
      const pitches = keys.map(vexKeyToMidiWriterPitch);
      const noteEvent = new MidiWriter.NoteEvent({ pitch: pitches, duration: ev.duration, wait: pendingWait });
      track.addEvent(noteEvent);
      pendingWait = [];
    });
    return track;
  });
  const writer = new MidiWriter.Writer(tracks);
  downloadBlob(writer.buildFile(), 'transcription.mid', 'audio/midi');
  log('Exported MIDI.');
});

render();
