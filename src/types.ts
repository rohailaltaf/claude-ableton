/** Shared input shapes used across the chord engine and tools. */

export interface Note {
  pitch: number; // MIDI note number, 0-127 (60 = C4)
  start_beat: number; // beats from clip start
  duration_beat: number;
  velocity: number; // MIDI velocity, 1-127
  // Optional Live 11+ per-note properties. Omitted = Live defaults
  // (probability 1.0, velocity_deviation 0.0, release_velocity 64, mute false).
  mute?: boolean;
  probability?: number; // 0.0-1.0 chance the note plays
  velocity_deviation?: number; // random velocity range added on playback
  release_velocity?: number; // 0-127
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
