# midi-music-app

Plug in a MIDI keyboard, play, and watch your notes appear as sheet music on a grand staff in real time. Export the result as MusicXML (for MuseScore, Finale, Sibelius, etc.) or as a MIDI file.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000 in **Chrome or Edge** (Web MIDI is not supported in Safari or Firefox). Allow MIDI access when prompted.

## How it works

- The browser reads your keyboard through the Web MIDI API; the Node server just serves the page and vendored libraries.
- Notes played within 60 ms of each other are grouped into a chord.
- Rhythm is inferred from the time between note onsets and snapped to the nearest note value (whole through 16th) at the tempo you set. Gaps longer than 120 ms become rests.
- Notes at or above middle C go on the treble staff; everything below goes on the bass staff.
- The last chord you play is finalized automatically after ~1 s of silence, or immediately with **Finalize current chord**.

## Controls

| Control | Purpose |
|---|---|
| MIDI input | Choose which device to listen to |
| Tempo | Reference BPM used to quantize durations |
| Time signature | Bar length used for measure breaks |
| Finalize current chord | Commit the chord currently being held |
| Clear | Start a new session |
| Export MusicXML / MIDI | Download the transcription |
