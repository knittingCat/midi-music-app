const VF = VexFlow;

const statusEl = document.getElementById('status');
const deviceSelect = document.getElementById('deviceSelect');
const tempoInput = document.getElementById('tempo');
const timeSigSelect = document.getElementById('timeSig');
const logEl = document.getElementById('log');
const notationEl = document.getElementById('notation');

const STRIKE_MS = 75;         // notes this close together are one chord no matter what
const CHORD_GAP_MS = 160;     // max gap between successive notes of a rolled chord
const CHORD_HOLD_MS = 150;    // earlier chord notes must stay held this long after a new one
const PAUSE_MS = 3000;
const REST_MIN_BEATS = 0.5;
const RUN_TOLERANCE = 1.5;    // intervals within this ratio of the run's average share its value
const TRIPLET_VALUES = [1 / 3, 2 / 3]; // eighth-note and quarter-note triplets
const TRIPLET_BIAS = 0.05;    // log2 margin a triplet fit must beat the straight fit by
const TRIPLET_EVENNESS = 1.3; // every note of a triplet run must be within this ratio of the run's average
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

// notesPlayed: raw performance, [{ pitch, vexKey, display, velocity, onset, release|null }]
// chords (derived): [{ onsetTime, releaseTime|null, notes: Map(pitch -> {vexKey, display, velocity}) }]
// events (derived): { treble: [vexKeys], bass: [vexKeys], beats, rawBeats, tupletId? }; both empty = rest
let notesPlayed = [];
let chords = [];
let events = [];
const heldNotes = new Map();
let loggedChords = 0;

const autoTempoToggle = document.getElementById('autoTempo');
const metronomeToggle = document.getElementById('metronome');

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

function nearestBeats(rawBeats, allowed) {
  const ratio = Math.min(Math.max(rawBeats, MIN_BEATS), MAX_BEATS);
  let best = allowed[0];
  let bestDist = Infinity;
  for (const beats of allowed) {
    const dist = Math.abs(Math.log2(ratio) - Math.log2(beats));
    if (dist < bestDist) { bestDist = dist; best = beats; }
  }
  return best;
}

const NOTE_VALUES = DURATIONS.filter((d) => !(d.dotted && d.beats < 0.5)).map((d) => d.beats);

// A dotted eighth only makes sense paired with a sixteenth; otherwise it is a
// slightly long eighth or a short quarter.
function quantizeNoteBeats(rawBeats, nextRawBeats) {
  const pairedWithSixteenth = nextRawBeats != null && nextRawBeats <= 0.4;
  return nearestBeats(rawBeats, pairedWithSixteenth ? NOTE_VALUES : NOTE_VALUES.filter((b) => b !== 0.75));
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

function tripletCode(beats) {
  return beats < 0.5 ? '8' : 'q';
}

function beatsLabel(beats, triplet = false) {
  if (triplet) return tripletCode(beats) + 't';
  return decomposeBeats(beats).map((d) => d.code + (d.dotted ? '.' : '')).join('+');
}

function splitChordByClef(notesMap) {
  const treble = [];
  const bass = [];
  const velocities = {};
  for (const [pitch, info] of notesMap.entries()) {
    (pitch >= 60 ? treble : bass).push(info.vexKey);
    velocities[info.vexKey] = info.velocity ?? 100;
  }
  return { treble, bass, velocities };
}

function timingLabel(rawBeats, beats, triplet = false) {
  const diff = beats - rawBeats;
  const sign = diff >= 0 ? '+' : '';
  return `played ${(rawBeats * quarterMs()).toFixed(0)}ms = ${rawBeats.toFixed(2)} beats → ${beatsLabel(beats, triplet)} (${beats.toFixed(2)} beats, ${sign}${diff.toFixed(2)})`;
}

// ---------- Chord grouping ----------

function heldThrough(note, time) {
  return note.release == null || note.release >= time;
}

// Successive notes form one chord when they are struck together, or when the
// earlier notes are still being held when the next arrives and stay held a
// little longer. Trills and runs release each note as the next one starts.
function groupChords(notes) {
  const groups = [];
  let group = null;
  for (const note of notes) {
    const prev = group && group.list[group.list.length - 1];
    const gap = prev ? note.onset - prev.onset : Infinity;
    const joins = prev && !group.notes.has(note.pitch) && (
      gap <= STRIKE_MS ||
      (gap <= CHORD_GAP_MS && group.list.every((n) => heldThrough(n, note.onset + CHORD_HOLD_MS)))
    );
    if (joins) {
      group.list.push(note);
      group.notes.set(note.pitch, { vexKey: note.vexKey, display: note.display, velocity: note.velocity });
    } else {
      group = { onsetTime: note.onset, list: [note], notes: new Map([[note.pitch, { vexKey: note.vexKey, display: note.display, velocity: note.velocity }]]) };
      groups.push(group);
    }
  }
  for (const g of groups) {
    g.releaseTime = g.list.every((n) => n.release != null) ? Math.max(...g.list.map((n) => n.release)) : null;
  }
  return groups;
}

// ---------- Notation from chords ----------

function chordRaw(chord, nextOnsetTime) {
  const q = quarterMs();
  if (nextOnsetTime == null) {
    return { note: ((chord.releaseTime ?? chord.onsetTime + q) - chord.onsetTime) / q, rest: 0, legato: false };
  }
  const onsetToOnset = (nextOnsetTime - chord.onsetTime) / q;
  const releaseTime = chord.releaseTime ?? nextOnsetTime;
  const gapBeats = (nextOnsetTime - releaseTime) / q;
  if (gapBeats >= REST_MIN_BEATS) {
    return { note: (releaseTime - chord.onsetTime) / q, rest: onsetToOnset, legato: false };
  }
  return { note: onsetToOnset, rest: 0, legato: true };
}

// Group consecutive legato chords whose spacing stays within RUN_TOLERANCE of
// the run's running average, so a slightly uneven trill or scale is one run.
function findRuns(raws) {
  const runs = [];
  let run = null;
  raws.forEach((raw, i) => {
    const inRun = run && raw.legato && Math.abs(Math.log2(raw.note / (run.sum / run.count))) < Math.log2(RUN_TOLERANCE);
    if (inRun) {
      run.sum += raw.note;
      run.count++;
      run.end = i;
    } else {
      run = { start: i, end: i, sum: raw.note, count: 1 };
      runs.push(run);
      if (!raw.legato) run = null;
    }
  });
  return runs;
}

// Decide the value of every chord in a run. A run of three or more notes whose
// average spacing fits a triplet better than a straight value becomes triplet
// groups of three, as long as each group fits inside the current measure.
// Leftover notes (and groups that would cross a barline) get the straight value.
function planRun(run, raws, pos) {
  const avg = run.sum / run.count;
  const nextRaw = run.count === 1 ? raws[run.end + 1]?.note ?? null : null;
  const straight = quantizeNoteBeats(avg, nextRaw);
  const plan = new Array(run.count).fill(null).map(() => ({ beats: straight }));
  if (run.count < 3) return plan;

  const tri = nearestBeats(avg, TRIPLET_VALUES);
  const dStraight = Math.abs(Math.log2(avg / straight));
  const dTri = Math.abs(Math.log2(avg / tri));
  if (dTri + TRIPLET_BIAS >= dStraight) return plan;
  const members = raws.slice(run.start, run.end + 1).map((r) => r.note);
  if (members.some((b) => Math.abs(Math.log2(b / avg)) > Math.log2(TRIPLET_EVENNESS))) return plan;

  const capacity = timeSigBeatsInQuarters();
  const groupBeats = tri * 3;
  // Leftover notes take the nearest straight value; a group that would cross a
  // barline takes the straight value just below the triplet (its total is
  // closer to the group's real length than the value above would be).
  const plain = nearestBeats(avg, NOTE_VALUES.filter((b) => b !== 0.75));
  const squeezed = tri < 0.5 ? 0.25 : 0.5;
  let p = pos;
  for (let i = 0; i < run.count; i++) plan[i] = { beats: plain };
  for (let i = 0; i + 3 <= run.count; i += 3) {
    const inMeasure = p - Math.floor(p / capacity + EPS) * capacity;
    if (inMeasure + groupBeats <= capacity + EPS) {
      const tupletId = nextTupletId++;
      for (let k = 0; k < 3; k++) plan[i + k] = { beats: tri, tupletId };
      p += groupBeats;
    } else {
      for (let k = 0; k < 3; k++) plan[i + k] = { beats: squeezed };
      p += squeezed * 3;
    }
  }
  return plan;
}

let nextTupletId = 0;

function buildEvents(chordList) {
  const raws = chordList.map((c, i) => chordRaw(c, chordList[i + 1]?.onsetTime ?? null));
  nextTupletId = 0;
  const planFor = new Array(raws.length);
  const runs = findRuns(raws);
  const out = [];
  let pos = 0; // beats since the start, to keep triplet groups inside a measure
  let runIdx = 0;
  chordList.forEach((chord, i) => {
    if (runIdx < runs.length && runs[runIdx].start === i) {
      const run = runs[runIdx++];
      planRun(run, raws, pos).forEach((pl, k) => { planFor[run.start + k] = pl; });
    }
    const { treble, bass, velocities } = splitChordByClef(chord.notes);
    const raw = raws[i];
    const { beats, tupletId } = planFor[i];
    out.push({ treble, bass, velocities, beats, tupletId, rawBeats: raw.note, chordIndex: i });
    pos += beats;
    if (raw.rest) {
      const restRaw = raw.rest - beats;
      const restBeats = quantizeRestBeats(restRaw);
      if (restBeats >= MIN_BEATS - EPS) {
        out.push({ treble: [], bass: [], beats: restBeats, rawBeats: restRaw, chordIndex: i });
        pos += restBeats;
      }
    }
  });
  return out;
}

function rebuildEvents() {
  chords = groupChords(notesPlayed);
  const complete = chords.filter((c, i) => i < chords.length - 1 || c.releaseTime != null);
  events = buildEvents(complete);
  logNewChords(complete);
}

function logNewChords(complete) {
  const closed = Math.min(complete.length, chords.length - 1);
  for (let i = loggedChords; i < closed; i++) {
    const chord = complete[i];
    const names = [...chord.notes.values()].map((n) => n.display).join(' ');
    for (const ev of events.filter((e) => e.chordIndex === i)) {
      const isRest = ev.treble.length === 0 && ev.bass.length === 0;
      log(`${isRest ? 'Rest' : names}: ${timingLabel(ev.rawBeats, ev.beats, ev.tupletId != null)}`);
    }
  }
  loggedChords = Math.max(loggedChords, closed);
}

function requantize() {
  clearTimeout(redrawTimer);
  redrawTimer = null;
  rebuildEvents();
  render();
}

// Re-rendering the whole score is far too slow to do per MIDI message: a fast
// chord passage would queue every note-on behind the previous redraw and lag
// both the sound and the notation. Input handlers only record the note and
// ask for a redraw once the burst pauses (or REDRAW_MAX_WAIT_MS at the latest).
const REDRAW_IDLE_MS = 60;
const REDRAW_MAX_WAIT_MS = 250;
let redrawTimer = null;
let redrawDeadline = 0;

function requantizeSoon() {
  const now = performance.now();
  if (redrawTimer) clearTimeout(redrawTimer);
  else redrawDeadline = now + REDRAW_MAX_WAIT_MS;
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    if (autoTempoToggle.checked) applyAutoTempo();
    requantize();
  }, Math.max(0, Math.min(REDRAW_IDLE_MS, redrawDeadline - now)));
}

function onNoteOn(pitch, velocity) {
  const now = performance.now();
  const { vexKey, display } = midiToKey(pitch);
  const stillHeld = heldNotes.get(pitch);
  if (stillHeld) stillHeld.release = now;
  const note = { pitch, vexKey, display, velocity, onset: now, release: null };
  notesPlayed.push(note);
  heldNotes.set(pitch, note);
  requantizeSoon();
}

function onNoteOff(pitch) {
  const note = heldNotes.get(pitch);
  if (!note) return;
  note.release = performance.now();
  heldNotes.delete(pitch);
  requantizeSoon();
}

document.getElementById('clearBtn').addEventListener('click', () => {
  stopPlayback();
  notesPlayed = [];
  heldNotes.clear();
  chords = [];
  events = [];
  loggedChords = 0;
  log('Cleared session.');
  render();
});

timeSigSelect.addEventListener('change', render);
tempoInput.addEventListener('change', requantize);

// ---------- Auto tempo ----------

const TEMPO_MIN = 40;
const TEMPO_MAX = 200;
const TEMPO_PRIOR_CENTER = 100;
const TEMPO_PRIOR_WEIGHT = 0.5;
const TEMPO_SWITCH_GAIN = 1.15;  // only move the tempo when the fit improves by this factor
const IOI_RATIOS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const IOI_RATIO_PENALTY = { 0.25: 0.2, 0.5: 0.1, 0.75: 0.5, 1: 0, 1.5: 0.2, 2: 0.1, 3: 0.3, 4: 0.3 };
const MIN_IOIS_FOR_AUTO = 4;

// How badly the inter-onset intervals fit simple note values at this BPM
function tempoCost(iois, bpm) {
  const beat = 60000 / bpm;
  let cost = TEMPO_PRIOR_WEIGHT * Math.abs(Math.log2(bpm / TEMPO_PRIOR_CENTER)) * iois.length;
  for (const ioi of iois) {
    const r = ioi / beat;
    let c = Infinity;
    for (const ratio of IOI_RATIOS) {
      const e = Math.log2(r / ratio);
      const v = e * e * 8 + IOI_RATIO_PENALTY[ratio];
      if (v < c) c = v;
    }
    cost += c;
  }
  return cost;
}

function estimateTempo(iois) {
  let best = null;
  let bestCost = Infinity;
  for (let bpm = TEMPO_MIN; bpm <= TEMPO_MAX; bpm++) {
    const cost = tempoCost(iois, bpm);
    if (cost < bestCost) { bestCost = cost; best = bpm; }
  }
  return best;
}

function chordIois() {
  const list = groupChords(notesPlayed);
  const iois = [];
  for (let i = 1; i < list.length; i++) {
    const ioi = list[i].onsetTime - list[i - 1].onsetTime;
    if (ioi < PAUSE_MS) iois.push(ioi);
  }
  return iois;
}

function applyAutoTempo() {
  const iois = chordIois();
  if (iois.length < MIN_IOIS_FOR_AUTO) return;
  const bpm = estimateTempo(iois);
  const current = Number(tempoInput.value) || 120;
  if (bpm === current) return;
  if (current >= TEMPO_MIN && current <= TEMPO_MAX && tempoCost(iois, current) <= TEMPO_SWITCH_GAIN * tempoCost(iois, bpm)) return;
  tempoInput.value = bpm;
  log(`Auto tempo: ${bpm} BPM — re-quantized ${iois.length + 1} chords.`);
}

function syncTempoControls() {
  const auto = autoTempoToggle.checked;
  tempoInput.disabled = auto;
  tapTempoBtn.disabled = auto;
  metronomeToggle.disabled = auto;
  if (auto) {
    metronomeToggle.checked = false;
    stopMetronome();
    applyAutoTempo();
  }
  requantize();
}
autoTempoToggle.addEventListener('change', syncTempoControls);

// ---------- Metronome ----------

const METRONOME_LOOKAHEAD_SEC = 0.1;
let metronomeTimer = null;
let metronomeNextBeat = 0;
let metronomeBeatIndex = 0;

function clickAt(time, accent) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + 0.05);
}

function metronomeTick() {
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  const beatSec = (quarterMs() / 1000) * (4 / den);
  while (metronomeNextBeat < audioCtx.currentTime + METRONOME_LOOKAHEAD_SEC) {
    clickAt(metronomeNextBeat, metronomeBeatIndex % num === 0);
    metronomeNextBeat += beatSec;
    metronomeBeatIndex++;
  }
}

function startMetronome() {
  unlockAudio();
  metronomeNextBeat = audioCtx.currentTime + 0.05;
  metronomeBeatIndex = 0;
  metronomeTick();
  metronomeTimer = setInterval(metronomeTick, 25);
}

function stopMetronome() {
  clearInterval(metronomeTimer);
  metronomeTimer = null;
}

metronomeToggle.addEventListener('change', () => {
  if (metronomeToggle.checked) startMetronome();
  else stopMetronome();
});

// ---------- Measures ----------

function timeSigBeatsInQuarters() {
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  return num * (4 / den);
}

// slot: { treble, bass, code, dotted, tieToNext, tupletId? }
function groupIntoMeasures() {
  const capacity = timeSigBeatsInQuarters();
  const measures = [];
  let current = [];
  let acc = 0;

  events.forEach((ev, eventIndex) => {
    const isRest = ev.treble.length === 0 && ev.bass.length === 0;
    if (ev.tupletId != null) {
      // buildEvents keeps triplet groups inside one measure, so no splitting here.
      current.push({ treble: ev.treble, bass: ev.bass, code: tripletCode(ev.beats), dotted: false, tieToNext: false, tupletId: ev.tupletId, eventIndex });
      acc += ev.beats;
      if (acc >= capacity - EPS) {
        measures.push(current);
        current = [];
        acc = 0;
      }
      return;
    }
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

// Returns one entry per slot. A triplet group that is silent on this clef
// collapses to a single plain rest, shared by all three of its slots.
function buildStaveNotes(slots, clef) {
  const restKey = clef === 'treble' ? 'b/4' : 'd/3';
  const collapsed = new Map(); // tupletId -> shared rest note
  return slots.map((slot, i) => {
    const keys = slot[clef];
    if (slot.tupletId != null && keys.length === 0) {
      const group = slots.filter((sl) => sl.tupletId === slot.tupletId);
      if (group.every((sl) => sl[clef].length === 0)) {
        if (!collapsed.has(slot.tupletId)) {
          collapsed.set(slot.tupletId, new VF.StaveNote({ keys: [restKey], duration: (slot.code === '8' ? 'q' : 'h') + 'r', clef }));
        }
        return collapsed.get(slot.tupletId);
      }
    }
    const duration = slot.code + (slot.dotted ? 'd' : '');
    const note = keys.length === 0
      ? new VF.StaveNote({ keys: [restKey], duration: duration + 'r', clef })
      : new VF.StaveNote({ keys, duration, clef });
    if (slot.dotted) VF.Dot.buildAndAttach([note], { all: true });
    return note;
  });
}

function uniqueNotes(staveNotes) {
  return [...new Set(staveNotes)];
}

// Slots sharing a tupletId are always three consecutive slots of one measure.
function buildTuplets(slots, staveNotes, clef) {
  const groups = new Map();
  slots.forEach((slot, i) => {
    if (slot.tupletId == null) return;
    if (!groups.has(slot.tupletId)) groups.set(slot.tupletId, []);
    groups.get(slot.tupletId).push(staveNotes[i]);
  });
  return [...groups.values()]
    .filter((notes) => uniqueNotes(notes).length === notes.length) // skip collapsed rest groups
    .map((notes) => new VF.Tuplet(notes, { numNotes: 3, notesOccupied: 2, location: clef === 'bass' ? VF.Tuplet.LOCATION_BOTTOM : VF.Tuplet.LOCATION_TOP }));
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

const ROW_HEIGHT = 210;
// Each row of the score is its own <svg>, cached by a key describing exactly
// what it shows. A new note usually only changes the last row, so a redraw
// costs one row instead of the whole score. Anything that re-quantizes
// everything (tempo change, auto tempo) changes every key and redraws all rows.
let rowCache = [];

function rowKey(row, rowMaxWidth, incomingTie) {
  return JSON.stringify([
    rowMaxWidth, timeSigSelect.value, incomingTie.treble, incomingTie.bass,
    row.map((m) => [m.index, m.width, m.firstInRow,
      m.slots.map((sl) => [sl.treble, sl.bass, sl.code, sl.dotted, sl.tieToNext, sl.tupletId ?? null, sl.eventIndex])]),
  ]);
}

function render(rowMaxWidth) {
  noteElements = [];
  const measures = groupIntoMeasures();
  if (measures.length === 0) {
    notationEl.innerHTML = '';
    rowCache = [];
    return;
  }

  const maxWidth = rowMaxWidth || Math.max(600, notationEl.parentElement.clientWidth - 40);
  const rows = layoutMeasures(measures, maxWidth);
  const width = Math.max(...rows.map((r) => r.reduce((s, m) => s + m.width, 0))) + 40;
  const incomingTie = { treble: false, bass: false };
  const nextCache = [];

  rows.forEach((row, rowIdx) => {
    const key = rowKey(row, maxWidth, incomingTie);
    let entry = rowCache[rowIdx];
    if (!entry || entry.key !== key) entry = { key, ...drawRow(row, incomingTie) };
    nextCache.push(entry);

    entry.svg.setAttribute('width', width);
    entry.svg.setAttribute('viewBox', `0 0 ${width} ${ROW_HEIGHT}`);
    if (notationEl.children[rowIdx] !== entry.svg) {
      notationEl.insertBefore(entry.svg, notationEl.children[rowIdx] || null);
    }
    entry.noteElements.forEach((els, eventIndex) => { (noteElements[eventIndex] ||= []).push(...els); });

    const last = row[row.length - 1].slots.at(-1);
    incomingTie.treble = last.tieToNext && last.treble.length > 0;
    incomingTie.bass = last.tieToNext && last.bass.length > 0;
  });
  while (notationEl.children.length > rows.length) notationEl.lastChild.remove();
  rowCache = nextCache;
}

// Draws one row into a fresh <svg>; returns { svg, noteElements: Map(eventIndex -> [elements]) }
function drawRow(row, incomingTie) {
  const holder = document.createElement('div');
  const renderer = new VF.Renderer(holder, VF.Renderer.Backends.SVG);
  renderer.resize(row.reduce((s, m) => s + m.width, 0) + 40, ROW_HEIGHT);
  const svg = holder.querySelector('svg');
  svg.style.display = 'block';
  svg.style.overflow = 'visible';
  const ctx = renderer.getContext();
  const [num, den] = timeSigSelect.value.split('/').map(Number);
  const rowNoteElements = new Map();
  const pendingTie = { ...incomingTie };
  let x = 20;
  const y = 20;

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
    const tuplets = {
      treble: buildTuplets(m.slots, notes.treble, 'treble'),
      bass: buildTuplets(m.slots, notes.bass, 'bass'),
    };
    const tickables = { treble: uniqueNotes(notes.treble), bass: uniqueNotes(notes.bass) };
    const beams = {
      treble: VF.Beam.generateBeams(tickables.treble),
      bass: VF.Beam.generateBeams(tickables.bass),
    };
    const voices = {
      treble: new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false).addTickables(tickables.treble),
      bass: new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false).addTickables(tickables.bass),
    };

    new VF.Formatter().joinVoices([voices.treble]).joinVoices([voices.bass]).formatToStave([voices.treble, voices.bass], trebleStave);
    voices.treble.draw(ctx, trebleStave);
    voices.bass.draw(ctx, bassStave);
    beams.treble.forEach((b) => b.setContext(ctx).draw());
    beams.bass.forEach((b) => b.setContext(ctx).draw());
    tuplets.treble.forEach((t) => t.setContext(ctx).draw());
    tuplets.bass.forEach((t) => t.setContext(ctx).draw());

    m.slots.forEach((slot, i) => {
      if (!rowNoteElements.has(slot.eventIndex)) rowNoteElements.set(slot.eventIndex, []);
      rowNoteElements.get(slot.eventIndex).push(notes.treble[i].getSVGElement(), notes.bass[i].getSVGElement());
    });

    ['treble', 'bass'].forEach((clef) => {
      m.slots.forEach((slot, i) => {
        if (slot[clef].length === 0) return;
        const indexes = slot[clef].map((_, k) => k);
        const note = notes[clef][i];
        if (i === 0 && pendingTie[clef]) {
          new VF.StaveTie({ lastNote: note, firstIndexes: indexes, lastIndexes: indexes }).setContext(ctx).draw();
          pendingTie[clef] = false;
        }
        if (!slot.tieToNext) return;
        if (i < m.slots.length - 1) {
          new VF.StaveTie({ firstNote: note, lastNote: notes[clef][i + 1], firstIndexes: indexes, lastIndexes: indexes }).setContext(ctx).draw();
        } else {
          new VF.StaveTie({ firstNote: note, firstIndexes: indexes, lastIndexes: indexes }).setContext(ctx).draw();
          pendingTie[clef] = true;
        }
      });
    });

    x += m.width;
  });

  return { svg, noteElements: rowNoteElements };
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
  requantize();
}

tapTempoBtn.addEventListener('click', tapTempo);
document.addEventListener('keydown', (e) => {
  if (tapTempoBtn.disabled) return;
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
      onNoteOn(data1, data2);
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
  gain.gain.value = velocityGain(velocity);
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

function velocityGain(velocity) {
  return Math.pow(velocity / 127, 1.5);
}

function scheduleSample(ctx, buffer, startAt, durationSec, velocity = 100) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  const level = velocityGain(velocity);
  gain.gain.setValueAtTime(level, startAt);
  gain.gain.setValueAtTime(level, startAt + durationSec);
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
      if (buffer) sources.push(scheduleSample(ctx, buffer, t, durationSec, ev.velocities?.[key]));
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

const XML_DIVISIONS = 24; // divisible by 8 (16ths, dotted 16ths) and 3 (triplets)
const XML_TYPES = { w: 'whole', h: 'half', q: 'quarter', 8: 'eighth', 16: '16th' };

function slotDivisions(slot) {
  const base = DURATIONS.find((d) => d.code === slot.code && !d.dotted).beats;
  return Math.round(base * (slot.dotted ? 1.5 : 1) * (slot.tupletId != null ? 2 / 3 : 1) * XML_DIVISIONS);
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
      slots.forEach((slot, si) => {
        const keys = slot[clef];
        const type = XML_TYPES[slot.code];
        const dur = slotDivisions(slot);
        const dot = slot.dotted ? '<dot/>' : '';
        const inTuplet = slot.tupletId != null;
        const timeMod = inTuplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
        const tupletStart = inTuplet && slots[si - 1]?.tupletId !== slot.tupletId;
        const tupletStop = inTuplet && slots[si + 1]?.tupletId !== slot.tupletId;
        const tupletTags = (tupletStart ? '<tuplet type="start"/>' : '') + (tupletStop ? '<tuplet type="stop"/>' : '');
        if (keys.length === 0) {
          noteXml += `<note><rest/><duration>${dur}</duration><voice>${staffNum}</voice><type>${type}</type>${dot}${timeMod}<staff>${staffNum}</staff>${tupletTags ? `<notations>${tupletTags}</notations>` : ''}</note>`;
          return;
        }
        const tieStop = tieOpen[clef];
        const tieStart = slot.tieToNext;
        const tieTags = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
        const tiedTags = (tieStop ? '<tied type="stop"/>' : '') + (tieStart ? '<tied type="start"/>' : '');
        keys.forEach((k, idx) => {
          const { step, alter, octave } = vexKeyToPitch(k);
          const notations = tiedTags + (idx === 0 ? tupletTags : '');
          noteXml += `<note>${idx > 0 ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${dur}</duration>${tieTags}<voice>${staffNum}</voice><type>${type}</type>${dot}${timeMod}<staff>${staffNum}</staff>${notations ? `<notations>${notations}</notations>` : ''}</note>`;
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

// ---------- Export: log + raw performance ----------

document.getElementById('exportLog').addEventListener('click', () => {
  const dump = {
    savedAt: new Date().toISOString(),
    tempo: Number(tempoInput.value),
    timeSignature: timeSigSelect.value,
    autoTempo: autoTempoToggle.checked,
    notes: notesPlayed.map((n) => ({
      note: n.display,
      velocity: n.velocity,
      onset: Math.round(n.onset),
      release: n.release == null ? null : Math.round(n.release),
    })),
    chords: chords.map((c) => ({
      onsetTime: Math.round(c.onsetTime),
      releaseTime: c.releaseTime == null ? null : Math.round(c.releaseTime),
      notes: [...c.notes.values()].map((n) => n.display),
    })),
    events: events.map((ev) => ({ treble: ev.treble, bass: ev.bass, beats: ev.beats, rawBeats: Number(ev.rawBeats.toFixed(3)) })),
    log: logEl.textContent.split('\n').filter(Boolean).reverse(),
  };
  const stamp = dump.savedAt.replace(/[:.]/g, '-');
  downloadBlob(JSON.stringify(dump, null, 2), `midi-music-app-log-${stamp}.json`, 'application/json');
  log('Saved log.');
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
    let cursor = 0; // beats; ticks are rounded from cumulative position so triplets don't drift
    events.forEach((ev) => {
      const startTick = Math.round(cursor * MIDI_TICKS_PER_QUARTER);
      cursor += ev.beats;
      const ticks = 'T' + (Math.round(cursor * MIDI_TICKS_PER_QUARTER) - startTick);
      const keys = ev[clef];
      if (keys.length === 0) {
        pendingWait.push(ticks);
        return;
      }
      const velocity = Math.round(keys.reduce((s, k) => s + (ev.velocities?.[k] ?? 100), 0) / keys.length);
      track.addEvent(new MidiWriter.NoteEvent({ pitch: keys.map(vexKeyToMidiWriterPitch), duration: ticks, wait: pendingWait, velocity: Math.round(velocity / 127 * 100) }));
      pendingWait = [];
    });
    return track;
  });
  downloadBlob(new MidiWriter.Writer(tracks).buildFile(), 'transcription.mid', 'audio/midi');
  log('Exported MIDI.');
});

render();
