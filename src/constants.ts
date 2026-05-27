/** Shared constants ported 1:1 from the Python server (the behavioral spec). */

/** Fallback default (4/4). Tools that care about meter read the live sig at
 * call time and compute beats/bar = numerator × 4 / denominator. */
export const BEATS_PER_BAR = 4;

/** Round note times to avoid LOM denormal issues. */
export const TIME_QUANTUM = 1e-6;

/** Sleep after fire-and-forget mutations so Live applies them before we poll. */
export const LIVE_TICK_MS = 150;
// Generous: complex preset racks (.adg instrument racks) can take several
// seconds to fully load, during which Live can't even answer the device-count
// poll. The poll tolerates QueryTimeout and keeps waiting until this deadline.
export const LOAD_TIMEOUT_MS = 10000;
export const LOAD_POLL_MS = 100;
/**
 * Drum kits are multisampled and can take many seconds to load (big packs like
 * Drum Machines), during which Live is too busy to answer the poll query.
 */
export const DRUM_KIT_LOAD_TIMEOUT_MS = 20000;

/**
 * Allowlist of built-in Live 12 Suite instruments. Keys are lowercase
 * identifiers exposed to callers; values are the exact names of items under
 * app.browser.instruments (the AbletonOSC load_instrument handler matches by
 * name).
 */
export const INSTRUMENT_MAP: Record<string, string> = {
  // Synths & physical-modeling instruments
  operator: "Operator",
  wavetable: "Wavetable",
  drift: "Drift",
  meld: "Meld",
  analog: "Analog",
  electric: "Electric",
  tension: "Tension",
  collision: "Collision",
  // Samplers
  simpler: "Simpler",
  sampler: "Sampler",
  impulse: "Impulse",
  drum_sampler: "Drum Sampler",
  // Racks & routing (empty containers)
  drum_rack: "Drum Rack", // empty rack; use load_drum_kit for a kit
  instrument_rack: "Instrument Rack",
  external_instrument: "External Instrument",
  // Drum Synths (individual percussion synths)
  ds_kick: "DS Kick",
  ds_snare: "DS Snare",
  ds_hh: "DS HH",
  ds_clap: "DS Clap",
  ds_tom: "DS Tom",
  ds_cymbal: "DS Cymbal",
  ds_fm: "DS FM",
  ds_clang: "DS Clang",
};

/**
 * Live's RecordingQuantization enum (what Clip.quantize accepts). Values
 * verified empirically against Live 12 (1-8 valid; 0/9+ raise "Invalid
 * quantization"). The combo grids (1/8+1/8T = 4, 1/16+1/16T = 7) are valid in
 * Live but omitted from the friendly map.
 */
export const QUANTIZE_GRID: Record<string, number> = {
  "1/4": 1,
  "1/8": 2,
  "1/8T": 3,
  "1/16": 5,
  "1/16T": 6,
  "1/32": 8,
};

// AbletonOSC's get/remove notes use a wide default range to mean "everything".
export const ALL_PITCH_START = 0;
export const ALL_PITCH_SPAN = 128;
export const ALL_BEAT_START = -8192.0;
export const ALL_BEAT_SPAN = 16384.0;
