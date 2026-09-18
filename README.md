# midi-music-app

Plug in a MIDI keyboard, play, and watch your notes appear as sheet music on a grand staff in real time, with a sampled piano sounding as you play. Play it back with the notes highlighted as they sound, and save the result as MusicXML, MIDI, PDF, or MP3.

## Install

### With tlib (recommended)

[tlib](https://github.com/BlueGrayFoo/TLIB) is a small package manager that installs GitHub-hosted command repos onto your `PATH`. If you don't have it yet, set it up first:

```bash
git clone https://github.com/BlueGrayFoo/TLIB.git
cd TLIB
chmod +x ZSH.zsh tlibUpdater
ln -s "$(pwd)/ZSH.zsh" /usr/local/bin/tlib
ln -s "$(pwd)/tlibUpdater" /usr/local/bin/tlibUpdater
```

Then install this app:

```bash
tlib install knittingCat/midi-music-app
```

That gives you two commands: `midi-music-app` (start) and `midi-music-app-stop` (stop). Run `tlib install knittingCat/midi-music-app` again any time to update.

### Without tlib

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/knittingCat/midi-music-app.git
cd midi-music-app
npm install
```

## Run

| | Start | Stop |
|---|---|---|
| With tlib | `midi-music-app` | `midi-music-app-stop` |
| Without tlib | `npm start` (from inside the cloned repo) | Ctrl+C |

Then open http://localhost:3000 in **Chrome or Edge** (Web MIDI is not supported in Safari or Firefox), allow MIDI access when prompted, click once anywhere on the page so the browser lets audio start, and play.

## Controls

| Control | Purpose |
|---|---|
| MIDI input | Choose which device to listen to |
| Tempo | Reference BPM used to quantize durations (and for playback / MP3) |
| Set by playing | Shows a C chord written as eight quarter notes; play along and the tempo is set from the median time between your chords |
| Time signature | Bar length used for measure breaks |
| Live piano sound | Hear a sampled piano as you play |
| Play / Stop | Play back the transcription; the notes light up as they sound |
| Finalize current chord | Commit the chord currently being held |
| Clear | Start a new session |
| Save as MusicXML | Score file for MuseScore, Finale, Sibelius, Dorico, etc. |
| Save as MIDI | Two-track (treble / bass) standard MIDI file |
| Save as PDF | Opens the print dialog with the score laid out for the page; choose "Save as PDF" |
| Save as MP3 | Renders the playback with the piano samples and encodes it in the browser |

## How it works

- The browser reads your keyboard through the Web MIDI API; the Node server just serves the page and the vendored libraries.
- Notes played within 60 ms of each other are grouped into a chord.
- Rhythm comes from the time between note onsets, snapped to the nearest value from whole to 16th (including dotted) at the tempo you set. A gap of at least an eighth note between releasing a key and pressing the next becomes a rest; shorter gaps are treated as legato.
- Notes at or above middle C go on the treble staff; everything below goes on the bass staff. Notes that cross a barline are split and tied.
- The log under the score shows, for every note, how long you actually held it versus what it was written as, so you can see how far off the quantization was and adjust the tempo.
- The last chord you play is finalized automatically after ~1 s of silence, or immediately with **Finalize current chord**.

## Credits

- Notation: [VexFlow](https://github.com/vexflow/vexflow) (MIT)
- MIDI file writing: [midi-writer-js](https://github.com/grimmdude/MidiWriterJS) (MIT)
- MP3 encoding: [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0)
- Piano samples: FluidR3_GM acoustic grand piano from [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (MIT), vendored in `public/vendor/` so the app works offline
