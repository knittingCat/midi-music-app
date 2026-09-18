# midi-music-app

Plug in a MIDI keyboard, play, and watch your notes appear as sheet music on a grand staff in real time, with a sampled piano sounding as you play. Play it back with the notes highlighted as they sound, and save the result as MusicXML, MIDI, PDF, or MP3.

## Install

### With tlib (recommended)

```bash
tlib install knittingCat/midi-music-app
```

That gives you two commands: `midi-music-app` (start) and `midi-music-app-stop` (stop). To pick up a new version later:

```bash
tlib update knittingCat/midi-music-app
```

(On a tlib without the `update` command, run `tlib install knittingCat/midi-music-app` again instead.)

See [Bluegrayfoo/TLIB](https://github.com/Bluegrayfoo/TLIB) for TLIB itself.

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

Then open http://localhost:3000 in **Chrome or Edge** (Web MIDI is not supported in Safari or Firefox), allow MIDI access when prompted, click once anywhere on the page so the browser will allow audio, and play.

## Controls

| Control | Purpose |
|---|---|
| MIDI input | Choose which device to listen to |
| Tempo | Reference BPM used to quantize durations (and for playback / MP3) |
| Set by playing | Play three bars of quarter notes (left hand, bass clef); tempo is the median of beats 3–12, shown with its range so you can retake it before it's applied |
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
- Rhythm comes from the time between note onsets, snapped to the nearest value from whole to 16th (including dotted) at the tempo you set. A gap of at least an eighth note between releasing a key and pressing the next one becomes a rest; shorter gaps are treated as legato.
- Notes at or above middle C go on the treble staff; everything below goes on the bass staff. Notes that cross a barline are split and tied.
- The log under the score shows, for every note, how long you actually held it versus how it was written, so you can see how far off the quantization was and adjust the tempo.
- The last chord you play is finalized automatically after ~1 s of silence, or immediately with **Finalize current chord**.

## Credits

- Notation: [VexFlow](https://github.com/vexflow/vexflow) (MIT)
- MIDI file writing: [midi-writer-js](https://github.com/grimmdude/MidiWriterJS) (MIT)
- MP3 encoding: [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0)
- Piano samples: FluidR3_GM acoustic grand piano from [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (MIT), vendored in `public/vendor/` so the app works offline
