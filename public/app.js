const VF = VexFlow;

const statusEl = document.getElementById('status');
const deviceSelect = document.getElementById('deviceSelect');
const tempoInput = document.getElementById('tempo');
const timeSigSelect = document.getElementById('timeSig');
const logEl = document.getElementById('log');
const notationEl = document.getElementById('notation');

const CHORD_WINDOW_MS = 60;
const IDLE_FLUSH_MS = 900;
const REST_MIN_BEATS = 0.5;
const EPS = 1e-6;

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const DURATIONS = [
  { beats: 4, code: 'w', dotted: false },
  { beats: 3, code: 'h', dotted: true },
  { beats: 2, code: 'h', dotted: false },
  { beats: 1.5, code: 'q', dotted: true },
  { beats: 1, code: 'q', dotted: false },
  { beats: 0.75, code: '8', dotted: true },
  { beats: 0.5, code: '8', dotted: false },
  { beats: 0.375, code: '16', dotted: true },
  { beats: 0.25, code: '16', dotted: false },
];
const MIN_BEATS = 0.25;
const MAX_BEATS = 4;

// events: { treble: [vexKeys], bass: [vexKeys], beats: number }; both empty = rest
let events = [];
let currentChord = null; // { onsetTime, notes: Map(pitch -> {vexKey, display}), released: Set, lastNoteOffTime, allReleased }
let lastChordReleaseTime = null;

function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.textContent = (line + '\n' + logEl.textContent).split('\n').slice(0, 100).join('\n');
}

function midiToKey(pitch) {
  const octave = Math.floor(pitch / 12) - 1;
  const name = NOTE_NAMES[pitch % 12];
  return { vexKey: `${name}/${octave}`, display: `${name.toUpperCase()}${octave}` };
}

function quarterMs() {
  return 60000 / (Number(tempoInput.value) || 120);
}

function quantizeNoteBeats(rawBeats) {
  const ratio = Math.min(Math.max(rawBeats, MIN_BEATS), MAX_BEATS);
  let best = DURATIONS[0];
  let bestDist = Infinity;
  for (const cand of DURATIONS) {
    if (cand.dotted && cand.beats < 0.5) continue;
    const dist = Math.abs(Math.log2(ratio) - Math.log2(cand.beats));
    if (dist < bestDist) { bestDist = dist; best = cand; }
  }
  return best.beats;
}

function quantizeRestBeats(rawBeats) {
  return Math.min(Math.round(rawBeats / MIN_BEATS) * MIN_BEATS, MAX_BEATS);
}

function decomposeBeats(beats) {
  const parts = [];
  let remaining = beats;
  for (const d of DURATIONS) {
    while (remaining >= d.beats - EPS) {
      parts.push(d);
      remaining -= d.beats;
    }
  }
  return parts;
}

function beatsLabel(beats) {
  return decomposeBeats(beats).map((d) => d.code + (d.dotted ? '.' : '')).join('+');
}

function splitChordByClef(notesMap) {
  const treble = [];
  const bass = [];
  for (const [pitch, info] of notesMap.entries()) {
    (pitch >= 60 ? treble : bass).push(info.vexKey);
  }
  return { treble, bass };
}

function timingLabel(rawBeats, beats) {
  const diff = beats - rawBeats;
  const sign = diff >= 0 ? '+' : '';
  return `played ${(rawBeats * quarterMs()).toFixed(0)}ms = ${rawBeats.toFixed(2)} beats → ${beatsLabel(beats)} (${beats} beats, ${sign}${diff.toFixed(2)})`;
}

function pushRest(rawBeats) {
  const beats = quantizeRestBeats(rawBeats);
  if (beats < MIN_BEATS - EPS) return;
  events.push({ treble: [], bass: [], beats });
  log(`Rest: ${timingLabel(rawBeats, beats)}`);
}

function pushChord(chord, rawBeats) {
  const beats = quantizeNoteBeats(rawBeats);
  const { treble, bass } = splitChordByClef(chord.notes);
  events.push({ treble, bass, beats });
  const names = [...chord.notes.values()].map((n) => n.display).join(' ');
  log(`${names}: ${timingLabel(rawBeats, beats)}`);
  return beats;
}

function finalizeChord(chord, nextOnsetTime) {
  const q = quarterMs();
  const releaseTime = chord.allReleased ? chord.lastNoteOffTime : nextOnsetTime;
  const onsetToOnset = (nextOnsetTime - chord.onsetTime) / q;
  const gapBeats = (nextOnsetTime - releaseTime) / q;

  if (gapBeats >= REST_MIN_BEATS) {
    const noteBeats = pushChord(chord, (releaseTime - chord.onsetTime) / q);
    pushRest(onsetToOnset - noteBeats);
  } else {
    pushChord(chord, onsetToOnset);
  }
}

function finalizeHeldChord(chord) {
  pushChord(chord, (chord.lastNoteOffTime - chord.onsetTime) / quarterMs());
  lastChordReleaseTime = chord.lastNoteOffTime;
}

function onNoteOn(pitch) {
  const now = performance.now();
  const { vexKey, display } = midiToKey(pitch);

  if (currentChord && !currentChord.allReleased && now - currentChord.onsetTime <= CHORD_WINDOW_MS) {
    currentChord.notes.set(pitch, { vexKey, display });
    return;
  }

  if (currentChord) {
    finalizeChord(currentChord, now);
  } else if (lastChordReleaseTime != null) {
    const gapBeats = (now - lastChordReleaseTime) / quarterMs();
    if (gapBeats >= REST_MIN_BEATS) pushRest(gapBeats);
  }

  currentChord = {
    onsetTime: now,
    notes: new Map([[pitch, { vexKey, display }]]),
    released: new Set(),
    lastNoteOffTime: null,
    allReleased: false,
  };
  render();
}

function onNoteOff(pitch) {
  if (!currentChord || !currentChord.notes.has(pitch)) return;
  currentChord.lastNoteOffTime = performance.now();
  currentChord.released.add(pitch);
  if ([...currentChord.notes.keys()].every((p) => currentChord.released.has(p))) {
    currentChord.allReleased = true;
  }
}

function idleFlushCheck() {
  if (!currentChord || !currentChord.allReleased) return;
  if (performance.now() - currentChord.lastNoteOffTime > IDLE_FLUSH_MS) {
    finalizeHeldChord(currentChord);
    currentChord = null;
    render();
  }
}
setInterval(idleFlushCheck, 250);

document.getElementById('finalizeBtn').addEventListener('click', () => {
  if (!currentChord) return;
  if (!currentChord.allReleased) currentChord.lastNoteOffTime = performance.now();
  finalizeHeldChord(currentChord);
  currentChord = null;
  render();
});

document.getElementById('clearBtn').addEventListener('click', () => {
  stopPlayback();
  events = [];
  currentChord = null;
  lastChordReleaseTime = null;
  log('Cleared session.');
  render();
});

timeSigSelect.addEventListener('change', render);

// ---------- Measures ----------

function timeSigBeatsInQuarters() {
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  return num * (4 / den);
}

// slot: { treble, bass, code, dotted, tieToNext }
function groupIntoMeasures() {
  const capacity = timeSigBeatsInQuarters();
  const measures = [];
  let current = [];
  let acc = 0;

  events.forEach((ev, eventIndex) => {
    const isRest = ev.treble.length === 0 && ev.bass.length === 0;
    let remaining = ev.beats;
    while (remaining > EPS) {
      const chunk = Math.min(remaining, capacity - acc);
      const parts = decomposeBeats(chunk);
      const lastChunk = remaining - chunk <= EPS;
      parts.forEach((p, i) => {
        const lastPart = lastChunk && i === parts.length - 1;
        current.push({ treble: ev.treble, bass: ev.bass, code: p.code, dotted: p.dotted, tieToNext: !isRest && !lastPart, eventIndex });
      });
      acc += chunk;
      remaining -= chunk;
      if (acc >= capacity - EPS) {
        measures.push(current);
        current = [];
        acc = 0;
      }
    }
  });
  if (current.length) measures.push(current);
  return measures;
}

// ---------- Rendering ----------

function buildStaveNotes(slots, clef) {
  return slots.map((slot) => {
    const keys = slot[clef];
    const duration = slot.code + (slot.dotted ? 'd' : '');
    const note = keys.length === 0
      ? new VF.StaveNote({ keys: [clef === 'treble' ? 'b/4' : 'd/3'], duration: duration + 'r', clef })
      : new VF.StaveNote({ keys, duration, clef });
    if (slot.dotted) VF.Dot.buildAndAttach([note], { all: true });
    return note;
  });
}

function layoutMeasures(measures, rowMaxWidth) {
  const rows = [];
  let row = [];
  let x = 0;
  measures.forEach((slots, i) => {
    const base = Math.max(120, 50 + slots.length * 36);
    const startOfRow = row.length === 0;
    let width = startOfRow ? base + 70 + (i === 0 ? 30 : 0) : base;
    if (!startOfRow && x + width > rowMaxWidth) {
      rows.push(row);
      row = [];
      x = 0;
      width = base + 70;
    }
    row.push({ slots, width, index: i, firstInRow: row.length === 0 });
    x += width;
  });
  if (row.length) rows.push(row);
  return rows;
}

let noteElements = [];

function render(rowMaxWidth) {
  notationEl.innerHTML = '';
  noteElements = [];
  const measures = groupIntoMeasures();
  if (measures.length === 0) return;

  const ROW_HEIGHT = 210;
  const rows = layoutMeasures(measures, rowMaxWidth || Math.max(600, notationEl.parentElement.clientWidth - 40));
  const width = Math.max(...rows.map((r) => r.reduce((s, m) => s + m.width, 0))) + 40;
  const height = rows.length * ROW_HEIGHT + 30;

  const renderer = new VF.Renderer(notationEl, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  notationEl.querySelector('svg').setAttribute('viewBox', `0 0 ${width} ${height}`);
  const ctx = renderer.getContext();
  const [num, den] = timeSigSelect.value.split('/').map(Number);

  const pendingTie = { treble: null, bass: null };

  rows.forEach((row, rowIdx) => {
    let x = 20;
    const y = 20 + rowIdx * ROW_HEIGHT;

    row.forEach((m) => {
      const trebleStave = new VF.Stave(x, y, m.width);
      const bassStave = new VF.Stave(x, y + 95, m.width);
      if (m.firstInRow) {
        trebleStave.addClef('treble');
        bassStave.addClef('bass');
        if (m.index === 0) {
          trebleStave.addTimeSignature(timeSigSelect.value);
          bassStave.addTimeSignature(timeSigSelect.value);
        }
      }
      trebleStave.setContext(ctx).draw();
      bassStave.setContext(ctx).draw();
      new VF.StaveConnector(trebleStave, bassStave).setType('brace').setContext(ctx).draw();
      new VF.StaveConnector(trebleStave, bassStave).setType('singleLeft').setContext(ctx).draw();

      const notes = {
        treble: buildStaveNotes(m.slots, 'treble'),
        bass: buildStaveNotes(m.slots, 'bass'),
      };
      const beams = {
        treble: VF.Beam.generateBeams(notes.treble),
        bass: VF.Beam.generateBeams(notes.bass),
      };
      const voices = {
        treble: new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false).addTickables(notes.treble),
        bass: new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false).addTickables(notes.bass),
      };

      new VF.Formatter().joinVoices([voices.treble]).joinVoices([voices.bass]).formatToStave([voices.treble, voices.bass], trebleStave);
      voices.treble.draw(ctx, trebleStave);
      voices.bass.draw(ctx, bassStave);
      beams.treble.forEach((b) => b.setContext(ctx).draw());
      beams.bass.forEach((b) => b.setContext(ctx).draw());

      m.slots.forEach((slot, i) => {
        (noteElements[slot.eventIndex] ||= []).push(notes.treble[i].getSVGElement(), notes.bass[i].getSVGElement());
      });

      ['treble', 'bass'].forEach((clef) => {
        m.slots.forEach((slot, i) => {
          if (slot[clef].length === 0) return;
          const indexes = slot[clef].map((_, k) => k);
          const note = notes[clef][i];
          if (i === 0 && pendingTie[clef]) {
            new VF.StaveTie({ lastNote: note, firstIndexes: indexes, lastIndexes: indexes }).setContext(ctx).draw();
            pendingTie[clef] = null;
          }
          if (!slot.tieToNext) return;
          if (i < m.slots.length - 1) {
            new VF.StaveTie({ firstNote: note, lastNote: notes[clef][i + 1], firstIndexes: indexes, lastIndexes: indexes }).setContext(ctx).draw();
          } else {
            new VF.StaveTie({ firstNote: note, firstIndexes: indexes, lastIndexes: indexes }).setContext(ctx).draw();
            pendingTie[clef] = note;
          }
        });
      });

      x += m.width;
    });
  });
}

// ---------- Tap tempo ----------

const TAP_RESET_MS = 2000;
const TAP_WINDOW = 8;
const tapTempoBtn = document.getElementById('tapTempoBtn');
let taps = [];
let tapResetTimer = null;

function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = [];
  taps.push(now);
  taps = taps.slice(-TAP_WINDOW);
  tapTempoBtn.classList.add('tapping');
  clearTimeout(tapResetTimer);
  tapResetTimer = setTimeout(() => {
    tapTempoBtn.classList.remove('tapping');
    tapTempoBtn.textContent = 'Tap tempo';
    if (taps.length > 1) log(`Tempo set to ${tempoInput.value} BPM by tapping.`);
    taps = [];
  }, TAP_RESET_MS);

  if (taps.length < 2) {
    tapTempoBtn.textContent = 'Tap…';
    return;
  }
  const avgMs = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  const bpm = Math.min(300, Math.max(20, Math.round(60000 / avgMs)));
  tempoInput.value = bpm;
  tapTempoBtn.textContent = `${bpm} BPM`;
}

tapTempoBtn.addEventListener('click', tapTempo);
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    tapTempo();
  }
});

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
      liveNoteOn(data1, data2);
      onNoteOn(data1);
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      liveNoteOff(data1);
      onNoteOff(data1);
    }
  };
  connectedName = input.name;
  refreshStatus();
  log(`Listening on "${input.name}"`);
}

let connectedName = null;
function refreshStatus() {
  if (!connectedName) return;
  const hint = audioCtx.state === 'suspended' ? ' — click anywhere on the page to enable sound' : '';
  setStatus(`Connected: ${connectedName}${hint}`, 'connected');
}

function populateDevices(midiAccess) {
  deviceSelect.innerHTML = '';
  const inputs = [...midiAccess.inputs.values()];
  if (inputs.length === 0) {
    deviceSelect.innerHTML = '<option>No MIDI devices found</option>';
    setStatus('No MIDI devices found. Plug in your keyboard and reload.', 'error');
    return;
  }
  inputs.forEach((input) => {
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

// ---------- Playback ----------

const playBtn = document.getElementById('playBtn');
const liveSoundToggle = document.getElementById('liveSound');
const PIANO_SAMPLES = MIDI.Soundfont.acoustic_grand_piano;
const SHARP_TO_FLAT = { 'c#': 'Db', 'd#': 'Eb', 'f#': 'Gb', 'g#': 'Ab', 'a#': 'Bb' };
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
audioCtx.onstatechange = refreshStatus;
const sampleCache = new Map();
const liveVoices = new Map();
let activeSources = [];
let playbackEndTimer = null;
let isPlaying = false;

function vexKeyToSampleName(vexKey) {
  const [name, octave] = vexKey.split('/');
  const letter = SHARP_TO_FLAT[name] || name.toUpperCase();
  return `${letter}${octave}`;
}

async function loadSample(ctx, sampleName) {
  if (sampleCache.has(sampleName)) return sampleCache.get(sampleName);
  const dataUri = PIANO_SAMPLES[sampleName];
  if (!dataUri) return null;
  const bytes = await (await fetch(dataUri)).arrayBuffer();
  const buffer = await ctx.decodeAudioData(bytes);
  sampleCache.set(sampleName, buffer);
  return buffer;
}

Promise.all(Object.keys(PIANO_SAMPLES).map((n) => loadSample(audioCtx, n)))
  .then(() => log('Piano samples loaded.'));

function unlockAudio() {
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function liveNoteOn(pitch, velocity) {
  if (!liveSoundToggle.checked) return;
  unlockAudio();
  const buffer = sampleCache.get(vexKeyToSampleName(midiToKey(pitch).vexKey));
  if (!buffer) return;
  liveNoteOff(pitch);
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  source.buffer = buffer;
  gain.gain.value = Math.pow(velocity / 127, 1.5);
  source.connect(gain).connect(audioCtx.destination);
  source.start();
  liveVoices.set(pitch, { source, gain });
}

function liveNoteOff(pitch) {
  const voice = liveVoices.get(pitch);
  if (!voice) return;
  liveVoices.delete(pitch);
  const now = audioCtx.currentTime;
  voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
  voice.gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  voice.source.stop(now + 0.3);
}

const RELEASE_SEC = 0.25;

function scheduleSample(ctx, buffer, startAt, durationSec) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.setValueAtTime(1, startAt);
  gain.gain.setValueAtTime(1, startAt + durationSec);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + durationSec + RELEASE_SEC);
  source.connect(gain).connect(ctx.destination);
  source.start(startAt);
  source.stop(startAt + durationSec + RELEASE_SEC);
  return source;
}

async function ensureSamplesLoaded() {
  const neededKeys = new Set(events.flatMap((ev) => [...ev.treble, ...ev.bass]));
  await Promise.all([...neededKeys].map((k) => loadSample(audioCtx, vexKeyToSampleName(k))));
}

// Schedules every event into ctx; returns { sources, onsets: [{ index, at }], endAt }
function scheduleEvents(ctx, startAt) {
  const quarterSec = quarterMs() / 1000;
  const sources = [];
  const onsets = [];
  let t = startAt;
  events.forEach((ev, index) => {
    const durationSec = ev.beats * quarterSec;
    onsets.push({ index, at: t });
    for (const key of [...ev.treble, ...ev.bass]) {
      const buffer = sampleCache.get(vexKeyToSampleName(key));
      if (buffer) sources.push(scheduleSample(ctx, buffer, t, durationSec));
    }
    t += durationSec;
  });
  return { sources, onsets, endAt: t };
}

let highlightTimers = [];
let highlighted = [];

function setHighlight(eventIndex) {
  highlighted.forEach((el) => el.classList.remove('playing'));
  highlighted = noteElements[eventIndex] || [];
  highlighted.forEach((el) => el.classList.add('playing'));
  if (highlighted[0]) highlighted[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function clearHighlight() {
  highlightTimers.forEach(clearTimeout);
  highlightTimers = [];
  highlighted.forEach((el) => el.classList.remove('playing'));
  highlighted = [];
}

function stopPlayback() {
  clearTimeout(playbackEndTimer);
  playbackEndTimer = null;
  clearHighlight();
  for (const src of activeSources) {
    try { src.stop(); } catch (_) {}
  }
  activeSources = [];
  isPlaying = false;
  playBtn.innerHTML = '&#9654; Play';
}

async function startPlayback() {
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  isPlaying = true;
  playBtn.innerHTML = '&#9632; Stop';

  await ensureSamplesLoaded();
  if (!isPlaying) return;

  const startAt = audioCtx.currentTime + 0.05;
  const { sources, onsets, endAt } = scheduleEvents(audioCtx, startAt);
  activeSources = sources;
  const now = audioCtx.currentTime;
  highlightTimers = onsets.map(({ index, at }) => setTimeout(() => setHighlight(index), (at - now) * 1000));
  playbackEndTimer = setTimeout(stopPlayback, (endAt - audioCtx.currentTime) * 1000 + RELEASE_SEC * 1000);
}

playBtn.addEventListener('click', () => {
  if (isPlaying) { stopPlayback(); return; }
  if (events.length === 0) { log('Nothing to play yet.'); return; }
  startPlayback();
});

// ---------- Export: MusicXML ----------

const XML_DIVISIONS = 8;
const XML_TYPES = { w: 'whole', h: 'half', q: 'quarter', 8: 'eighth', 16: '16th' };

function slotDivisions(slot) {
  const base = DURATIONS.find((d) => d.code === slot.code && !d.dotted).beats;
  return Math.round(base * (slot.dotted ? 1.5 : 1) * XML_DIVISIONS);
}

function vexKeyToPitch(vexKey) {
  const [name, octave] = vexKey.split('/');
  return { step: name[0].toUpperCase(), alter: name.includes('#') ? 1 : 0, octave };
}

function buildMusicXml() {
  const measures = groupIntoMeasures();
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  const tieOpen = { treble: false, bass: false };
  let measuresXml = '';

  measures.forEach((slots, mi) => {
    let noteXml = '';
    const attrs = mi === 0
      ? `<attributes><divisions>${XML_DIVISIONS}</divisions><time><beats>${num}</beats><beat-type>${den}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
      : '';

    ['treble', 'bass'].forEach((clef, clefIdx) => {
      const staffNum = clefIdx + 1;
      slots.forEach((slot) => {
        const keys = slot[clef];
        const type = XML_TYPES[slot.code];
        const dur = slotDivisions(slot);
        const dot = slot.dotted ? '<dot/>' : '';
        if (keys.length === 0) {
          noteXml += `<note><rest/><duration>${dur}</duration><voice>${staffNum}</voice><type>${type}</type>${dot}<staff>${staffNum}</staff></note>`;
          return;
        }
        const tieStop = tieOpen[clef];
        const tieStart = slot.tieToNext;
        const tieTags = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
        const tiedTags = (tieStop || tieStart)
          ? `<notations>${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}</notations>`
          : '';
        keys.forEach((k, idx) => {
          const { step, alter, octave } = vexKeyToPitch(k);
          noteXml += `<note>${idx > 0 ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${dur}</duration>${tieTags}<voice>${staffNum}</voice><type>${type}</type>${dot}<staff>${staffNum}</staff>${tiedTags}</note>`;
        });
        tieOpen[clef] = tieStart;
      });
      if (clefIdx === 0) noteXml += `<backup><duration>${slots.reduce((s, slot) => s + slotDivisions(slot), 0)}</duration></backup>`;
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

const MIDI_TICKS_PER_QUARTER = 128;

function vexKeyToMidiWriterPitch(vexKey) {
  const [name, octave] = vexKey.split('/');
  return `${name.toUpperCase()}${octave}`;
}

// ---------- Export: PDF (via print) ----------

const PRINT_ROW_WIDTH = 720;

window.addEventListener('beforeprint', () => render(PRINT_ROW_WIDTH));
window.addEventListener('afterprint', () => render());

document.getElementById('exportPdf').addEventListener('click', () => {
  if (events.length === 0) { log('Nothing to export yet.'); return; }
  log('Choose "Save as PDF" as the destination in the print dialog.');
  window.print();
});

// ---------- Export: MP3 ----------

const exportMp3Btn = document.getElementById('exportMp3');

async function renderToAudioBuffer() {
  await ensureSamplesLoaded();
  const totalSec = events.reduce((s, ev) => s + ev.beats, 0) * (quarterMs() / 1000) + RELEASE_SEC + 0.5;
  const sampleRate = audioCtx.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate);
  scheduleEvents(offline, 0.05);
  return offline.startRendering();
}

function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeMp3(buffer) {
  const encoder = new lamejs.Mp3Encoder(2, buffer.sampleRate, 160);
  const left = floatToInt16(buffer.getChannelData(0));
  const right = floatToInt16(buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0));
  const chunks = [];
  const BLOCK = 1152;
  for (let i = 0; i < left.length; i += BLOCK) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK));
    if (chunk.length) chunks.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  return new Blob(chunks, { type: 'audio/mpeg' });
}

exportMp3Btn.addEventListener('click', async () => {
  if (events.length === 0) { log('Nothing to export yet.'); return; }
  exportMp3Btn.disabled = true;
  exportMp3Btn.textContent = 'Encoding…';
  try {
    const buffer = await renderToAudioBuffer();
    const blob = encodeMp3(buffer);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcription.mp3';
    a.click();
    URL.revokeObjectURL(url);
    log(`Exported MP3 (${(blob.size / 1024).toFixed(0)} KB).`);
  } catch (err) {
    log(`MP3 export failed: ${err.message}`);
  } finally {
    exportMp3Btn.disabled = false;
    exportMp3Btn.textContent = 'MP3';
  }
});

document.getElementById('exportMidi').addEventListener('click', () => {
  if (events.length === 0) { log('Nothing to export yet.'); return; }
  const tempo = Number(tempoInput.value) || 120;
  const tracks = ['treble', 'bass'].map((clef) => {
    const track = new MidiWriter.Track();
    track.setTempo(tempo);
    let pendingWait = [];
    events.forEach((ev) => {
      const ticks = 'T' + Math.round(ev.beats * MIDI_TICKS_PER_QUARTER);
      const keys = ev[clef];
      if (keys.length === 0) {
        pendingWait.push(ticks);
        return;
      }
      track.addEvent(new MidiWriter.NoteEvent({ pitch: keys.map(vexKeyToMidiWriterPitch), duration: ticks, wait: pendingWait }));
      pendingWait = [];
    });
    return track;
  });
  downloadBlob(new MidiWriter.Writer(tracks).buildFile(), 'transcription.mid', 'audio/midi');
  log('Exported MIDI.');
});

render();
