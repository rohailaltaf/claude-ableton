/**
 * Chord parsing + voicing, ported 1:1 from the Python server.
 *
 * Chord symbols are parsed with `tonal` (replacing pychord); pitch classes
 * come from `tonal`'s `Note.chroma`. The smooth voice-leading algorithm is a
 * verbatim port, including Python's round-half-to-even so a given progression
 * lands on identical octaves in both implementations.
 */

import { Chord, Note as TonalNote } from "tonal";

/** Round half to even (matches Python's built-in `round`). */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1; // exact .5 → nearest even
}

/** Pitch class (0-11) for a note name, or throw on an unknown name. */
function pitchClass(name: string): number {
  const chroma = TonalNote.chroma(name);
  if (chroma === undefined) {
    throw new Error(`Unknown note name in chord components: ${name}`);
  }
  return chroma;
}

/**
 * Parse a chord symbol into component note names (e.g. "Cmaj7" → C, E, G, B).
 * Throws on an unparseable symbol (mirrors the Python ValueError path).
 */
export function chordComponents(symbol: string): string[] {
  const chord = Chord.get(symbol);
  if (chord.empty || chord.notes.length === 0) {
    throw new Error(`chord ${symbol} could not be parsed`);
  }
  return chord.notes;
}

/**
 * Convert chord components to MIDI pitches in root position.
 *
 * The root is placed at the given octave; subsequent chord tones ascend from
 * the root (bumped up an octave if their pitch class falls below the root).
 */
export function chordToMidi(components: string[], octave: number): number[] {
  const base = 12 * (octave + 1);
  const rootMidi = base + pitchClass(components[0]);
  const midiNotes = [rootMidi];
  for (const component of components.slice(1)) {
    let pitch = base + pitchClass(component);
    while (pitch < rootMidi) pitch += 12;
    midiNotes.push(pitch);
  }
  return midiNotes;
}

/**
 * Voice a chord's pitch classes with smooth voice-leading.
 *
 * With no previous chord, falls back to close root-position voicing from
 * `octave`. Otherwise each pitch class is placed in the octave nearest the
 * previous chord's centroid, so the progression stays in a stable register and
 * common tones barely move.
 */
export function voiceChordSmooth(
  components: string[],
  octave: number,
  prevNotes: number[] | null,
): number[] {
  const pcs = components.map(pitchClass);
  if (!prevNotes || prevNotes.length === 0) {
    return chordToMidi(components, octave);
  }
  const anchor = prevNotes.reduce((a, b) => a + b, 0) / prevNotes.length;
  const notes = pcs.map((pc) => pc + 12 * roundHalfEven((anchor - pc) / 12));
  return notes.map((n) => Math.trunc(n)).sort((a, b) => a - b);
}
