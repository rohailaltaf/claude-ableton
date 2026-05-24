/** Shared input shapes used across the chord engine and tools. */

export interface Note {
  pitch: number; // MIDI note number, 0-127 (60 = C4)
  start_beat: number; // beats from clip start
  duration_beat: number;
  velocity: number; // MIDI velocity, 1-127
}

export interface RhythmStep {
  start_beat: number;
  duration_beat: number;
}

export interface AutomationStep {
  start_beat: number; // beats from clip start
  length_beats: number; // length of the constant-value segment
  value: number; // parameter value during this segment
}
