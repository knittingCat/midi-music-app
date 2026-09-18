# midi-music-app

Plug in a MIDI keyboard, play, and watch your notes appear as sheet music on a grand staff in real time, with a sampled piano sounding as you play. Play it back with the notes highlighted as they sound, and save the result as MusicXML, MIDI, PDF, or MP3.

**Use it now: [https://midi-music-app.onrender.com/](https://midi-music-app.onrender.com/)** (Chrome or Edge, with a MIDI keyboard plugged in).

The whole app runs in the browser: `public/` is a self-contained static site (page, script, and vendored libraries), so it can be hosted anywhere static files can, or run locally through the small Node launcher.

## Hosted (static site)

The site above is deployed on Render from this repo's `main` branch and updates on every push. To host your own copy, deploy the `public/` directory as a static site — no build step. `render.yaml` in the repo is a [Render](https://render.com) blueprint that does exactly that (publish directory `./public`); creating a Static Site by hand with publish directory `public` and an empty build command works too. Web MIDI needs a secure context, which any `https://` host provides.

## Run locally

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

Requires [Node.js](https://nodejs.org) 18 or newer (only for the launcher; express is its one runtime dependency).

```bash
git clone https://github.com/knittingCat/midi-music-app.git
cd midi-music-app
npm install
```

### Start / stop

| | Start | Stop |
|---|---|---|
| With tlib | `midi-music-app` | `midi-music-app-stop` |
| Without tlib | `npm start` (from inside the cloned repo) | Ctrl+C |

The server binds to `127.0.0.1:3000`. If that port is busy it takes the next free one (up to 3020) and prints the URL it chose; you can also pick one with `midi-music-app --port 8080` or `PORT=8080 npm start`. `midi-music-app-stop` stops only this app's server, never whatever else might be on the port.

Then open http://localhost:3000 (or the hosted URL above) in **Chrome or Edge** (Web MIDI is not supported in Safari or Firefox), allow MIDI access when prompted, click once anywhere on the page so the browser will allow audio, and play.

## Controls

| Control | Purpose |
|---|---|
| MIDI input | Choose which device to listen to |
| Tempo | Reference BPM used to quantize durations (and for playback / MP3) |
| Tap tempo | Click the button (or press T) in time; the tempo updates live from the average of the current run, and a two-second pause starts a new run |
| Auto tempo | Detects the tempo from your playing (the BPM between 40 and 200 at which the gaps between your chords best fit simple note values, leaning toward moderate tempos) and re-quantizes everything already written when the estimate changes; it only moves when the new tempo fits clearly better, so it doesn't drift by a beat or two every note; disables the tempo field, tap tempo, and metronome while on |
| Metronome | Clicks on every beat at the set tempo, accented on beat 1; only available while auto tempo is off |
| Time signature | Bar length used for measure breaks |
| Live piano sound | Hear a sampled piano as you play |
| Play / Stop | Play back the transcription; the notes light up as they sound |
| Clear | Start a new session |
| Save as MusicXML | Score file for MuseScore, Finale, Sibelius, Dorico, etc. |
| Save as MIDI | Two-track (treble / bass) standard MIDI file |
| Save as PDF | Opens the print dialog with the score laid out for the page; choose "Save as PDF" |
| Save as MP3 | Renders the playback with the piano samples and encodes it in the browser |

## How it works

- The browser reads your keyboard through the Web MIDI API; nothing runs server-side. The Node launcher just serves `public/`.
- Runs of three or more evenly spaced notes that fit eighth- or quarter-note triplets better than any straight value are written as triplets; a triplet group never crosses a barline.
- Each row of the score is rendered separately and cached, so a new note only redraws the row it lands in.
- Notes struck within 75 ms are one chord. Beyond that, a note still joins the chord if the earlier notes are being held when it arrives (within 160 ms) and stay held at least 150 ms longer, so rolled or slightly uneven chords group correctly while trills and runs, which let go of each note as the next starts, stay separate. Grouping is re-derived from the raw notes, so it can settle once the keys come up.
- The raw performance (each chord's onset and release time) is kept, and the notation is derived from it, so changing the tempo — by typing, tapping, or auto tempo — re-quantizes everything already on the page.
- Rhythm comes from the time between chord onsets, snapped to the nearest value from whole to 16th at the current tempo. A run of notes whose spacing stays close to the run's average shares one value rather than flickering between eighths and sixteenths (so a slightly swung trill is still written evenly), and a dotted eighth is only written when it's paired with a sixteenth. A gap of at least an eighth note between releasing a key and pressing the next one becomes a rest; shorter gaps are treated as legato.
- Notes at or above middle C go on the treble staff; everything below goes on the bass staff. Notes that cross a barline are split and tied.
- The log under the score shows, for every note, how long you actually held it versus how it was written, so you can see how far off the quantization was and adjust the tempo.
- The last chord appears as soon as all its keys are released.

## Credits

Libraries are vendored in `public/vendor/` (refresh them from `node_modules` with `npm run vendor` after `npm update`):

- Notation: [VexFlow](https://github.com/vexflow/vexflow) (MIT)
- MIDI file writing: [midi-writer-js](https://github.com/grimmdude/MidiWriterJS) (MIT)
- MP3 encoding: [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0)
- Piano samples: FluidR3_GM acoustic grand piano from [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (MIT), vendored in `public/vendor/` so the app works offline
