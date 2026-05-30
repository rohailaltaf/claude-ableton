/**
 * All MCP tools, ported 1:1 from the Python server (src/claude_ableton/server.py).
 *
 * Numeric OSC args are wrapped with `i()` (int32) / `f()` (float32) exactly
 * where the Python source casts `int(...)` / `float(...)`, so the wire format
 * is identical.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type AbletonClient, f, i, QueryTimeout, type SendArg } from "./osc.js";
import {
  asBool,
  asNum,
  asStr,
  getClient,
  jsonResult,
  numDevices,
  sleep,
} from "./context.js";
import { chordComponents, chordToMidi, voiceChordSmooth } from "./chords.js";
import type { AutomationStep, Note } from "./types.js";
import {
  ALL_BEAT_SPAN,
  ALL_BEAT_START,
  ALL_PITCH_SPAN,
  ALL_PITCH_START,
  DRUM_KIT_LOAD_TIMEOUT_MS,
  INSTRUMENT_MAP,
  LIVE_TICK_MS,
  LOAD_POLL_MS,
  LOAD_TIMEOUT_MS,
  QUANTIZE_GRID,
  TIME_QUANTUM,
} from "./constants.js";

// --- Reusable zod shapes --------------------------------------------------

const noteSchema = z.object({
  pitch: z.number().int().describe("MIDI note number 0-127 (60 = C4)"),
  start_beat: z.number().describe("beats from clip start (>= 0)"),
  duration_beat: z.number().describe("beats (> 0)"),
  velocity: z.number().int().describe("MIDI velocity 1-127 (0 = note-off, rejected)"),
});

const rhythmStepSchema = z.object({
  start_beat: z.number(),
  duration_beat: z.number(),
});

const automationStepSchema = z.object({
  start_beat: z.number().describe("beats from clip start"),
  length_beats: z.number().describe("length of the constant-value segment"),
  value: z.number().describe("parameter value during this segment"),
});

// --- Helpers (ported) -----------------------------------------------------

function quantizeTime(beats: number): number {
  return Math.round(beats / TIME_QUANTUM) * TIME_QUANTUM;
}

function validateNote(note: Note, index: number): void {
  const { pitch, velocity, start_beat, duration_beat } = note;
  if (!(pitch >= 0 && pitch <= 127)) {
    throw new Error(`note[${index}]: pitch ${pitch} out of range 0-127`);
  }
  if (!(velocity >= 1 && velocity <= 127)) {
    throw new Error(
      `note[${index}]: velocity ${velocity} out of range 1-127 ` +
        "(0 means note-off and is not accepted)",
    );
  }
  if (start_beat < 0) {
    throw new Error(`note[${index}]: start_beat ${start_beat} must be >= 0`);
  }
  if (duration_beat <= 0) {
    throw new Error(`note[${index}]: duration_beat ${duration_beat} must be > 0`);
  }
}

interface CreateClipResult {
  track_index: number;
  clip_slot: number;
  length_beats: number;
  note_count: number;
}

async function createClipImpl(
  trackIndex: number,
  clipSlot: number,
  lengthBeats: number,
  notes: Note[] | null,
  name: string | null,
): Promise<CreateClipResult> {
  if (lengthBeats <= 0) {
    throw new Error(`length_beats must be > 0 (got ${lengthBeats})`);
  }
  const noteList = notes ?? [];
  noteList.forEach((n, idx) => validateNote(n, idx));

  const c = await getClient();

  const has = await c.query("/live/clip_slot/get/has_clip", [i(trackIndex), i(clipSlot)]);
  if (asBool(has[2])) {
    throw new Error(
      `clip_slot (${trackIndex}, ${clipSlot}) already contains a clip. ` +
        "Delete it first or pick another slot.",
    );
  }

  c.send("/live/clip_slot/create_clip", i(trackIndex), i(clipSlot), f(lengthBeats));
  await sleep(LIVE_TICK_MS);

  if (name) c.send("/live/clip/set/name", i(trackIndex), i(clipSlot), name);

  if (noteList.length) {
    const flat: SendArg[] = [i(trackIndex), i(clipSlot)];
    for (const n of noteList) {
      flat.push(
        i(n.pitch),
        f(quantizeTime(n.start_beat)),
        f(quantizeTime(n.duration_beat)),
        i(n.velocity),
        false, // mute
      );
    }
    c.send("/live/clip/add/notes", ...flat);
    await sleep(LIVE_TICK_MS);
  }

  return {
    track_index: trackIndex,
    clip_slot: clipSlot,
    length_beats: lengthBeats,
    note_count: noteList.length,
  };
}

/** Optional case-insensitive substring filter over a list of names. */
function applyFilter(children: string[], filter?: string): string[] {
  if (!filter) return children;
  const needle = filter.toLowerCase();
  return children.filter((c) => c.toLowerCase().includes(needle));
}

/** Auto-paginate a fork browser-node listing into a full {path, children}. */
async function listBrowserNode(
  address: string,
  path: string,
  filter?: string,
): Promise<{ path: string; children: string[] }> {
  const c = await getClient();
  const children: string[] = [];
  let offset = 0;
  for (;;) {
    // Reply shape: (path, offset, total_count, name1, name2, ...)
    const reply = await c.query(address, [path, i(offset)]);
    const total = Number(reply[2]);
    const page = reply.slice(3).map(asStr);
    children.push(...page);
    offset += page.length;
    if (page.length === 0 || offset >= total) break;
  }
  return { path, children: applyFilter(children, filter) };
}

/**
 * Poll a track's device count until it rises above `before`, tolerating
 * QueryTimeout — while Live loads a heavy preset/rack it's too busy to answer
 * the device-count query, which is NOT a failure. Returns the new device count,
 * or null if the deadline passes with no new device.
 */
async function waitForDeviceIncrease(
  c: AbletonClient,
  trackIndex: number,
  before: number,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(LOAD_POLL_MS);
    try {
      const count = await numDevices(c, trackIndex);
      if (count > before) return count;
    } catch (e) {
      if (e instanceof QueryTimeout) continue; // Live busy loading — keep waiting
      throw e;
    }
  }
  return null;
}

/** Shared zod field: optional case-insensitive name filter for list_* tools. */
const FILTER_FIELD = {
  filter: z
    .string()
    .optional()
    .describe("optional case-insensitive substring filter on the returned names"),
};

/**
 * Beats-per-bar at the project's current time signature. Live's clip beat unit
 * is always the quarter note, so bars→beats = numerator × (4 / denominator).
 * Examples: 4/4 → 4, 3/4 → 3, 6/8 → 3, 7/8 → 3.5, 5/4 → 5.
 */
async function beatsPerBar(c: AbletonClient): Promise<number> {
  const num = asNum((await c.query("/live/song/get/signature_numerator"))[0]);
  const den = asNum((await c.query("/live/song/get/signature_denominator"))[0]);
  return (num * 4) / den;
}

/** Live's denominator must be a power of two (1, 2, 4, 8, 16, 32, 64). */
function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Live.Song.Quantization enum — used for clip_trigger_quantization (global
 * launch) AND per-clip launch_quantization. Keys lowercase for forgiving match. */
const LAUNCH_QUANTIZATION: Record<string, number> = {
  none: 0, "8 bars": 1, "4 bars": 2, "2 bars": 3, "1 bar": 4,
  "1/2": 5, "1/2t": 6, "1/4": 7, "1/4t": 8, "1/8": 9, "1/8t": 10,
  "1/16": 11, "1/16t": 12, "1/32": 13,
};
function resolveQuant(grid: string): number {
  const v = LAUNCH_QUANTIZATION[grid.toLowerCase()];
  if (v === undefined) {
    throw new Error(
      `unknown grid ${JSON.stringify(grid)}; choose one of: ${Object.keys(LAUNCH_QUANTIZATION).join(", ")}`,
    );
  }
  return v;
}

/** Clip.launch_mode enum (Trigger=0, Gate=1, Toggle=2, Repeat=3). */
const CLIP_LAUNCH_MODE: Record<string, number> = {
  trigger: 0, gate: 1, toggle: 2, repeat: 3,
};

/** Clip.warp_mode enum: Beats=0, Tones=1, Texture=2, Re-Pitch=3, Complex=4, REX=5, Complex Pro=6. */
const WARP_MODE: Record<string, number> = {
  beats: 0, tones: 1, texture: 2, "re-pitch": 3, repitch: 3,
  complex: 4, rex: 5, "complex pro": 6,
};
function validateSig(numerator: number, denominator: number): void {
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 99) {
    throw new Error(`numerator ${numerator} must be an integer 1-99`);
  }
  if (!Number.isInteger(denominator) || !isPow2(denominator) || denominator > 64) {
    throw new Error(
      `denominator ${denominator} must be a power of 2 from 1, 2, 4, 8, 16, 32, 64`,
    );
  }
}

function flattenSteps(steps: AutomationStep[]): number[] {
  if (!steps.length) throw new Error("steps list is empty");
  const flat: number[] = [];
  steps.forEach((step, idx) => {
    const { start_beat, length_beats, value } = step;
    if (start_beat < 0) {
      throw new Error(`step[${idx}]: start_beat ${start_beat} must be >= 0`);
    }
    if (length_beats <= 0) {
      throw new Error(`step[${idx}]: length_beats ${length_beats} must be > 0`);
    }
    flat.push(start_beat, length_beats, value);
  });
  return flat;
}

interface MasterParamInfo {
  parameter_index: number;
  name: string;
  value: number;
  min: number;
  max: number;
}

async function readMasterDeviceParameters(deviceIndex: number): Promise<MasterParamInfo[]> {
  const c = await getClient();
  const reply = await c.query("/live/master_track/get/device/parameters", [i(deviceIndex)]);
  const out: MasterParamInfo[] = [];
  for (let k = 0; k < reply.length; k += 4) {
    out.push({
      parameter_index: k / 4,
      name: asStr(reply[k]),
      value: asNum(reply[k + 1]),
      min: asNum(reply[k + 2]),
      max: asNum(reply[k + 3]),
    });
  }
  return out;
}

// --- Tool registration ----------------------------------------------------

export function registerTools(server: McpServer): void {
  // ===== Tracks / creation =====

  server.registerTool(
    "create_midi_track",
    {
      description:
        "Create a MIDI track appended at the end of the track list. " +
        "Returns the zero-based track_index of the new track.",
      inputSchema: { name: z.string().optional().describe("Optional name for the new track.") },
    },
    async ({ name }) => {
      const c = await getClient();
      const reply = await c.query("/live/song/get/num_tracks");
      const newIndex = asNum(reply[0]);
      c.send("/live/song/create_midi_track", i(-1));
      await sleep(LIVE_TICK_MS);
      if (name) c.send("/live/track/set/name", i(newIndex), name);
      return jsonResult({ track_index: newIndex });
    },
  );

  server.registerTool(
    "create_audio_track",
    {
      description:
        "Create an audio track appended at the end of the track list. Use this when you " +
        "need to land an audio clip on the Session grid (e.g. via load_browser_clip with " +
        "an audio .alc loop). Returns the zero-based track_index of the new track.",
      inputSchema: { name: z.string().optional().describe("Optional name for the new track.") },
    },
    async ({ name }) => {
      const c = await getClient();
      const reply = await c.query("/live/song/get/num_tracks");
      const newIndex = asNum(reply[0]);
      c.send("/live/song/create_audio_track", i(-1));
      await sleep(LIVE_TICK_MS);
      if (name) c.send("/live/track/set/name", i(newIndex), name);
      return jsonResult({ track_index: newIndex });
    },
  );

  server.registerTool(
    "load_instrument",
    {
      description:
        "Load a built-in Live 12 Suite instrument onto a track. instrument is a " +
        "case-insensitive identifier from the allowlist: synths/modeling (operator, " +
        "wavetable, drift, meld, analog, electric, tension, collision); samplers " +
        "(simpler, sampler, impulse, drum_sampler); racks/routing (drum_rack — empty, " +
        "use load_drum_kit for a kit; instrument_rack, external_instrument); drum synths " +
        "(ds_kick, ds_snare, ds_hh, ds_clap, ds_tom, ds_cymbal, ds_fm, ds_clang). For " +
        "named presets use load_preset. Returns the loaded identifier + device_index.",
      inputSchema: {
        track_index: z.number().int().describe("zero-based target track index"),
        instrument: z.string().describe("instrument identifier from the allowlist"),
      },
    },
    async ({ track_index, instrument }) => {
      const c = await getClient();
      const key = instrument.toLowerCase();
      const browserName = INSTRUMENT_MAP[key];
      if (browserName === undefined) {
        throw new Error(
          `Unknown instrument ${JSON.stringify(instrument)}. ` +
            `Allowed: ${Object.keys(INSTRUMENT_MAP).sort().join(", ")}`,
        );
      }
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_instrument", i(track_index), browserName);

      const count = await waitForDeviceIncrease(c, track_index, devicesBefore, LOAD_TIMEOUT_MS);
      if (count !== null) return jsonResult({ instrument: key, device_index: devicesBefore });
      throw new Error(
        `Load timed out: ${JSON.stringify(instrument)} did not appear on track ` +
          `${track_index} within ${LOAD_TIMEOUT_MS / 1000}s.`,
      );
    },
  );

  server.registerTool(
    "create_clip",
    {
      description:
        "Create a MIDI clip in the given clip slot and optionally write notes. The clip " +
        "length is `length_bars` in the project's current time signature (bars→beats uses " +
        "the live sig: 4/4 → 4 beats/bar, 3/4 → 3, 6/8 → 3, 7/8 → 3.5, …). Raises if the " +
        "slot already has a clip. Each note: pitch 0-127 (60=C4), start_beat>=0, " +
        "duration_beat>0, velocity 1-127.",
      inputSchema: {
        track_index: z.number().int().describe("zero-based MIDI track index"),
        clip_slot: z.number().int().describe("zero-based clip slot (scene) index"),
        length_bars: z.number().describe("clip length in bars (> 0)"),
        notes: z.array(noteSchema).optional().describe("optional notes to write"),
        name: z.string().optional().describe("optional clip name"),
      },
    },
    async ({ track_index, clip_slot, length_bars, notes, name }) => {
      if (length_bars <= 0) throw new Error(`length_bars must be > 0 (got ${length_bars})`);
      const c = await getClient();
      const bpb = await beatsPerBar(c);
      const result = await createClipImpl(
        track_index,
        clip_slot,
        length_bars * bpb,
        notes ?? null,
        name ?? null,
      );
      return jsonResult(result);
    },
  );

  server.registerTool(
    "chord_progression",
    {
      description:
        "Write a chord progression into a clip as block chords. Chord symbols are " +
        "parsed (e.g. [\"Cmaj7\",\"Am7\",\"Fmaj7\",\"G7\"]). By default each chord lasts " +
        "one bar in the project's current time signature (so a 3/4 progression gives " +
        "3-beat chords); pass rhythm to control timing explicitly. voicing 'smooth' " +
        "(default) applies voice-leading so chords stay in a stable register and common " +
        "tones barely move; 'root' keeps literal root position from octave.",
      inputSchema: {
        track_index: z.number().int().describe("target MIDI track index"),
        clip_slot: z.number().int().describe("target clip slot (must be empty)"),
        chords: z.array(z.string()).describe("chord symbols"),
        rhythm: z
          .array(rhythmStepSchema)
          .optional()
          .describe("optional {start_beat,duration_beat} aligned with chords"),
        name: z.string().optional().describe("optional clip name"),
        velocity: z.number().int().default(90).describe("MIDI velocity for every note"),
        octave: z.number().int().default(4).describe("octave for the first chord's root"),
        voicing: z.enum(["smooth", "root"]).default("smooth"),
      },
    },
    async ({ track_index, clip_slot, chords, rhythm, name, velocity, octave, voicing }) => {
      if (!chords.length) throw new Error("chords must not be empty");
      if (!(velocity >= 1 && velocity <= 127)) {
        throw new Error(`velocity ${velocity} out of range 1-127`);
      }

      const c = await getClient();
      const bpb = await beatsPerBar(c);
      const rhythmSteps =
        rhythm ??
        chords.map((_, idx) => ({
          start_beat: idx * bpb,
          duration_beat: bpb,
        }));
      if (chords.length !== rhythmSteps.length) {
        throw new Error(
          `chords (${chords.length}) and rhythm (${rhythmSteps.length}) must be the same length`,
        );
      }

      const notes: Note[] = [];
      let maxEnd = 0;
      let prevNotes: number[] | null = null;
      for (let idx = 0; idx < chords.length; idx++) {
        const symbol = chords[idx];
        let components: string[];
        try {
          components = chordComponents(symbol);
        } catch (e) {
          throw new Error(
            `chord[${idx}] ${JSON.stringify(symbol)} could not be parsed: ${
              (e as Error).message
            }`,
          );
        }
        const start = rhythmSteps[idx].start_beat;
        const duration = rhythmSteps[idx].duration_beat;
        if (start < 0) throw new Error(`rhythm[${idx}]: start_beat ${start} must be >= 0`);
        if (duration <= 0) {
          throw new Error(`rhythm[${idx}]: duration_beat ${duration} must be > 0`);
        }

        const pitches: number[] =
          voicing === "smooth"
            ? voiceChordSmooth(components, octave, prevNotes)
            : chordToMidi(components, octave);

        for (const pitch of pitches) {
          notes.push({ pitch, start_beat: start, duration_beat: duration, velocity });
        }
        prevNotes = pitches;
        maxEnd = Math.max(maxEnd, start + duration);
      }

      const lengthBeats = Math.max(bpb, Math.ceil(maxEnd / bpb) * bpb);
      const clipName = name ?? chords.join(" | ");
      const result = await createClipImpl(track_index, clip_slot, lengthBeats, notes, clipName);
      return jsonResult(result);
    },
  );

  // ===== Scenes =====

  server.registerTool(
    "fire_scene",
    {
      description:
        "Fire all clips in the given scene (row). Locks multiple tracks to the same " +
        "downbeat. Fire-and-forget.",
      inputSchema: { scene_index: z.number().int().describe("zero-based scene (row) index") },
    },
    async ({ scene_index }) => {
      const c = await getClient();
      c.send("/live/scene/fire", i(scene_index));
      return jsonResult({ scene_index, action: "fired" });
    },
  );

  server.registerTool(
    "list_scenes",
    {
      description:
        "List every scene (row) with its index, name, and whether it's empty. " +
        "is_empty is true when no track has a clip in that row.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const nReply = await c.query("/live/song/get/num_scenes");
      const n = asNum(nReply[0]);
      const scenes = [];
      for (let k = 0; k < n; k++) {
        const nameReply = await c.query("/live/scene/get/name", [i(k)]);
        const emptyReply = await c.query("/live/scene/get/is_empty", [i(k)]);
        scenes.push({
          scene_index: k,
          name: asStr(nameReply[1]),
          is_empty: asBool(emptyReply[1]),
        });
      }
      return jsonResult(scenes);
    },
  );

  server.registerTool(
    "create_scene",
    {
      description:
        "Create a new empty scene (row). index -1 (default) appends; any other value " +
        "inserts at that index, shifting later scenes down.",
      inputSchema: {
        index: z.number().int().default(-1).describe("insertion position; -1 appends"),
        name: z.string().optional().describe("optional name for the new scene"),
      },
    },
    async ({ index, name }) => {
      const c = await getClient();
      const beforeReply = await c.query("/live/song/get/num_scenes");
      const before = asNum(beforeReply[0]);
      const newIndex = index < 0 ? before : index;
      c.send("/live/song/create_scene", i(index));
      await sleep(LIVE_TICK_MS);
      if (name) c.send("/live/scene/set/name", i(newIndex), name);
      return jsonResult({ scene_index: newIndex, action: "created" });
    },
  );

  server.registerTool(
    "duplicate_scene",
    {
      description:
        "Duplicate a scene, inserting the copy directly below it. Copies every clip in " +
        "the row. Returns the new scene's index (scene_index + 1).",
      inputSchema: { scene_index: z.number().int().describe("zero-based scene index") },
    },
    async ({ scene_index }) => {
      const c = await getClient();
      c.send("/live/song/duplicate_scene", i(scene_index));
      await sleep(LIVE_TICK_MS);
      return jsonResult({ scene_index: scene_index + 1, action: "duplicated" });
    },
  );

  server.registerTool(
    "rename_scene",
    {
      description: "Rename a scene (row).",
      inputSchema: {
        scene_index: z.number().int().describe("zero-based scene index"),
        name: z.string().describe("new scene name"),
      },
    },
    async ({ scene_index, name }) => {
      const c = await getClient();
      c.send("/live/scene/set/name", i(scene_index), name);
      return jsonResult({ scene_index, action: "renamed" });
    },
  );

  server.registerTool(
    "delete_scene",
    {
      description:
        "Delete a scene (row). Destructive but Undo-able. Live requires at least one " +
        "scene to exist.",
      inputSchema: { scene_index: z.number().int().describe("zero-based scene index to delete") },
    },
    async ({ scene_index }) => {
      const c = await getClient();
      c.send("/live/song/delete_scene", i(scene_index));
      return jsonResult({ scene_index, action: "deleted" });
    },
  );

  // ===== Transport / tempo / read-state =====

  server.registerTool(
    "set_tempo",
    {
      description: "Set the project tempo in BPM (Live's valid range is 20-999).",
      inputSchema: { bpm: z.number().describe("target tempo in BPM") },
    },
    async ({ bpm }) => {
      if (!(bpm >= 20 && bpm <= 999)) throw new Error(`bpm ${bpm} out of range 20-999`);
      const c = await getClient();
      c.send("/live/song/set/tempo", f(bpm));
      return jsonResult({ bpm, action: "set" });
    },
  );

  server.registerTool(
    "get_tempo",
    { description: "Read the current project tempo in BPM.", inputSchema: {} },
    async () => {
      const c = await getClient();
      const reply = await c.query("/live/song/get/tempo");
      return jsonResult({ bpm: asNum(reply[0]) });
    },
  );

  server.registerTool(
    "get_time_signature",
    {
      description:
        "Read the project time signature (numerator/denominator). create_clip and " +
        "chord_progression honor this when converting bars↔beats.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const num = await c.query("/live/song/get/signature_numerator");
      const den = await c.query("/live/song/get/signature_denominator");
      return jsonResult({ numerator: asNum(num[0]), denominator: asNum(den[0]) });
    },
  );

  server.registerTool(
    "set_time_signature",
    {
      description:
        "Set the project (song) time signature. Common sigs: 4/4, 3/4 (waltz), 6/8 " +
        "(ballad), 7/8 / 5/4 (odd meters). Denominator must be a power of 2 (1, 2, 4, 8, " +
        "16, 32, 64). create_clip and chord_progression will honor this for bars↔beats. " +
        "For a single clip in a different meter, use set_clip_time_signature.",
      inputSchema: {
        numerator: z.number().int().describe("beats per bar, 1-99"),
        denominator: z.number().int().describe("beat unit, power of 2 (1-64)"),
      },
    },
    async ({ numerator, denominator }) => {
      validateSig(numerator, denominator);
      const c = await getClient();
      c.send("/live/song/set/signature_numerator", i(numerator));
      c.send("/live/song/set/signature_denominator", i(denominator));
      return jsonResult({ numerator, denominator, action: "set" });
    },
  );

  server.registerTool(
    "get_playback_state",
    {
      description:
        "Read transport state: whether Live is playing and the playhead position " +
        "(current_beat, in beats from the start).",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const playing = await c.query("/live/song/get/is_playing");
      const beat = await c.query("/live/song/get/current_song_time");
      return jsonResult({ is_playing: asBool(playing[0]), current_beat: asNum(beat[0]) });
    },
  );

  server.registerTool(
    "set_song_position",
    {
      description:
        "Move the playhead to a specific position (beats from the start of the " +
        "arrangement). Doesn't start/stop playback — pair with start_playing/continue_playing.",
      inputSchema: { beat: z.number().describe("position in beats (>= 0)") },
    },
    async ({ beat }) => {
      if (beat < 0) throw new Error(`beat ${beat} must be >= 0`);
      const c = await getClient();
      c.send("/live/song/set/current_song_time", f(beat));
      return jsonResult({ beat, action: "set" });
    },
  );

  server.registerTool(
    "set_metronome",
    {
      description: "Turn Live's metronome on or off.",
      inputSchema: { on: z.boolean() },
    },
    async ({ on }) => {
      const c = await getClient();
      c.send("/live/song/set/metronome", i(on ? 1 : 0));
      return jsonResult({ on, action: "set" });
    },
  );

  server.registerTool(
    "set_arrangement_loop",
    {
      description:
        "Configure the Arrangement loop region. Any of `start_beats`, `length_beats`, " +
        "`enabled` may be set; omitted fields are left unchanged. Loop bounds are in beats.",
      inputSchema: {
        start_beats: z.number().optional().describe("loop start (beats from project start)"),
        length_beats: z.number().optional().describe("loop length in beats (> 0)"),
        enabled: z.boolean().optional().describe("loop on/off"),
      },
    },
    async ({ start_beats, length_beats, enabled }) => {
      const c = await getClient();
      if (start_beats !== undefined) {
        if (start_beats < 0) throw new Error(`start_beats ${start_beats} must be >= 0`);
        c.send("/live/song/set/loop_start", f(start_beats));
      }
      if (length_beats !== undefined) {
        if (length_beats <= 0) throw new Error(`length_beats ${length_beats} must be > 0`);
        c.send("/live/song/set/loop_length", f(length_beats));
      }
      if (enabled !== undefined) c.send("/live/song/set/loop", i(enabled ? 1 : 0));
      return jsonResult({ start_beats, length_beats, enabled, action: "set" });
    },
  );

  server.registerTool(
    "set_launch_quantization",
    {
      description:
        "Set the global clip launch quantization (clip_trigger_quantization). Controls " +
        "the grid scenes/clips snap to when fired. Choose from: none, 8 bars, 4 bars, " +
        "2 bars, 1 bar, 1/2, 1/2T, 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32 " +
        "(T = triplet, case-insensitive).",
      inputSchema: { grid: z.string().describe("e.g. '1 bar', '1/4', 'none'") },
    },
    async ({ grid }) => {
      const c = await getClient();
      c.send("/live/song/set/clip_trigger_quantization", i(resolveQuant(grid)));
      return jsonResult({ grid, action: "set" });
    },
  );

  server.registerTool(
    "get_project_scale",
    {
      description:
        "Read the project's scale (Live 12 global scale): root_note (pitch class 0-11, " +
        "0=C…11=B) and scale_name (e.g. 'Major', 'Minor', 'Dorian', 'Mixolydian').",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const r = asNum((await c.query("/live/song/get/root_note"))[0]);
      const s = asStr((await c.query("/live/song/get/scale_name"))[0]);
      return jsonResult({ root_note: r, scale_name: s });
    },
  );

  server.registerTool(
    "set_project_scale",
    {
      description:
        "Set the project's scale (Live 12). root_note is the pitch class 0-11 " +
        "(0=C, 1=C#/Db, 2=D, 3=D#/Eb, 4=E, 5=F, 6=F#/Gb, 7=G, 8=G#/Ab, 9=A, 10=A#/Bb, " +
        "11=B). scale_name is one of Live's scale strings, e.g. 'Major', 'Minor', 'Dorian', " +
        "'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian', 'Locrian', 'Pentatonic', " +
        "'Blues', 'Harmonic Minor', 'Melodic Minor'.",
      inputSchema: {
        root_note: z.number().int().describe("pitch class 0-11"),
        scale_name: z.string().describe("e.g. 'Minor', 'Dorian', 'Mixolydian'"),
      },
    },
    async ({ root_note, scale_name }) => {
      if (!(root_note >= 0 && root_note <= 11)) {
        throw new Error(`root_note ${root_note} out of range 0-11`);
      }
      const c = await getClient();
      c.send("/live/song/set/root_note", i(root_note));
      c.send("/live/song/set/scale_name", scale_name);
      return jsonResult({ root_note, scale_name, action: "set" });
    },
  );

  server.registerTool(
    "start_playing",
    {
      description:
        "Start global playback / fire whatever Session clips are queued.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      c.send("/live/song/start_playing");
      return jsonResult({ action: "started" });
    },
  );

  server.registerTool(
    "stop_playing",
    { description: "Stop global playback. All playing clips are stopped.", inputSchema: {} },
    async () => {
      const c = await getClient();
      c.send("/live/song/stop_playing");
      return jsonResult({ action: "stopped" });
    },
  );

  server.registerTool(
    "continue_playing",
    {
      description: "Resume playback from the current position without restarting from the top.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      c.send("/live/song/continue_playing");
      return jsonResult({ action: "continued" });
    },
  );

  // ===== Duplicate track / clip; clip properties =====

  server.registerTool(
    "duplicate_track",
    {
      description:
        "Duplicate a track, inserting the copy directly to its right (instrument, " +
        "devices, and clips). New track lands at track_index + 1.",
      inputSchema: { track_index: z.number().int().describe("zero-based track index to duplicate") },
    },
    async ({ track_index }) => {
      const c = await getClient();
      c.send("/live/song/duplicate_track", i(track_index));
      await sleep(LIVE_TICK_MS);
      return jsonResult({ source_index: track_index, new_index: track_index + 1 });
    },
  );

  server.registerTool(
    "duplicate_clip",
    {
      description:
        "Copy a clip from one slot into another slot (same or different track). The " +
        "target slot must be empty. Cross-track copies only make sense MIDI→MIDI.",
      inputSchema: {
        track_index: z.number().int().describe("source track index"),
        clip_slot: z.number().int().describe("source clip slot index"),
        target_track: z.number().int().describe("destination track index"),
        target_clip_slot: z.number().int().describe("destination clip slot (must be empty)"),
      },
    },
    async ({ track_index, clip_slot, target_track, target_clip_slot }) => {
      const c = await getClient();
      c.send(
        "/live/clip_slot/duplicate_clip_to",
        i(track_index),
        i(clip_slot),
        i(target_track),
        i(target_clip_slot),
      );
      await sleep(LIVE_TICK_MS);
      return jsonResult({
        source_track: track_index,
        source_clip_slot: clip_slot,
        target_track,
        target_clip_slot,
        action: "duplicated",
      });
    },
  );

  server.registerTool(
    "set_clip_name",
    {
      description: "Rename the clip in the given slot.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must contain a clip"),
        name: z.string().describe("new clip name"),
      },
    },
    async ({ track_index, clip_slot, name }) => {
      const c = await getClient();
      c.send("/live/clip/set/name", i(track_index), i(clip_slot), name);
      return jsonResult({ track_index, clip_slot, action: "renamed" });
    },
  );

  server.registerTool(
    "set_clip_loop",
    {
      description:
        "Turn a clip's looping on or off. Off = plays once and stops (one-shots); on = " +
        "repeats while the slot is playing.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must contain a clip"),
        looping: z.boolean().describe("true to loop, false for one-shot"),
      },
    },
    async ({ track_index, clip_slot, looping }) => {
      const c = await getClient();
      c.send("/live/clip/set/looping", i(track_index), i(clip_slot), i(looping ? 1 : 0));
      return jsonResult({ track_index, clip_slot, action: "loop set" });
    },
  );

  server.registerTool(
    "set_clip_color",
    {
      description: "Set a clip's color as a packed RGB integer (0xRRGGBB, e.g. 0xFF8800 = orange).",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must contain a clip"),
        color: z.number().int().describe("packed RGB integer 0xRRGGBB"),
      },
    },
    async ({ track_index, clip_slot, color }) => {
      const c = await getClient();
      c.send("/live/clip/set/color", i(track_index), i(clip_slot), i(color));
      return jsonResult({ track_index, clip_slot, action: "color set" });
    },
  );

  server.registerTool(
    "set_clip_time_signature",
    {
      description:
        "Set a single clip's time signature (Live supports per-clip sigs alongside the " +
        "song sig). Denominator must be a power of 2 (1, 2, 4, 8, 16, 32, 64). For the " +
        "whole project, use set_time_signature instead.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must contain a clip"),
        numerator: z.number().int().describe("beats per bar, 1-99"),
        denominator: z.number().int().describe("beat unit, power of 2 (1-64)"),
      },
    },
    async ({ track_index, clip_slot, numerator, denominator }) => {
      validateSig(numerator, denominator);
      const c = await getClient();
      c.send("/live/clip/set/signature_numerator", i(track_index), i(clip_slot), i(numerator));
      c.send("/live/clip/set/signature_denominator", i(track_index), i(clip_slot), i(denominator));
      return jsonResult({ track_index, clip_slot, numerator, denominator, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_gain",
    {
      description:
        "Set a clip's gain (clip-level volume, normalized 0.0-1.0). Useful for audio " +
        "clips; on MIDI clips this is a no-op in some versions.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        gain: z.number().describe("0.0-1.0"),
      },
    },
    async ({ track_index, clip_slot, gain }) => {
      if (!(gain >= 0 && gain <= 1)) throw new Error(`gain ${gain} out of range 0.0-1.0`);
      const c = await getClient();
      c.send("/live/clip/set/gain", i(track_index), i(clip_slot), f(gain));
      return jsonResult({ track_index, clip_slot, gain, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_mute",
    {
      description: "Mute or unmute a single clip (Live calls this property 'muted').",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        muted: z.boolean(),
      },
    },
    async ({ track_index, clip_slot, muted }) => {
      const c = await getClient();
      c.send("/live/clip/set/muted", i(track_index), i(clip_slot), i(muted ? 1 : 0));
      return jsonResult({ track_index, clip_slot, muted, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_position",
    {
      description:
        "Set a clip's position on the Arrangement timeline (beats from project start). " +
        "Only meaningful for Arrangement clips, not Session-view clip slots.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        position_beats: z.number().describe("position in beats (>= 0)"),
      },
    },
    async ({ track_index, clip_slot, position_beats }) => {
      if (position_beats < 0) throw new Error(`position_beats ${position_beats} must be >= 0`);
      const c = await getClient();
      c.send("/live/clip/set/position", i(track_index), i(clip_slot), f(position_beats));
      return jsonResult({ track_index, clip_slot, position_beats, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_region",
    {
      description:
        "Set a clip's playback region (the start/end markers, in beats from clip 0). " +
        "Either field is optional — omitted ones are left unchanged.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        start_marker: z.number().optional().describe("clip start marker (beats from clip 0)"),
        end_marker: z.number().optional().describe("clip end marker (beats from clip 0)"),
      },
    },
    async ({ track_index, clip_slot, start_marker, end_marker }) => {
      const c = await getClient();
      if (start_marker !== undefined) {
        if (start_marker < 0) throw new Error(`start_marker ${start_marker} must be >= 0`);
        c.send("/live/clip/set/start_marker", i(track_index), i(clip_slot), f(start_marker));
      }
      if (end_marker !== undefined) {
        if (end_marker <= 0) throw new Error(`end_marker ${end_marker} must be > 0`);
        c.send("/live/clip/set/end_marker", i(track_index), i(clip_slot), f(end_marker));
      }
      return jsonResult({ track_index, clip_slot, start_marker, end_marker, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_loop_region",
    {
      description:
        "Set a clip's loop region (loop_start and loop_end, in beats from clip 0). " +
        "Either field is optional. To toggle looping on/off use set_clip_loop.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        loop_start: z.number().optional(),
        loop_end: z.number().optional(),
      },
    },
    async ({ track_index, clip_slot, loop_start, loop_end }) => {
      const c = await getClient();
      if (loop_start !== undefined) {
        if (loop_start < 0) throw new Error(`loop_start ${loop_start} must be >= 0`);
        c.send("/live/clip/set/loop_start", i(track_index), i(clip_slot), f(loop_start));
      }
      if (loop_end !== undefined) {
        if (loop_end <= 0) throw new Error(`loop_end ${loop_end} must be > 0`);
        c.send("/live/clip/set/loop_end", i(track_index), i(clip_slot), f(loop_end));
      }
      return jsonResult({ track_index, clip_slot, loop_start, loop_end, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_pitch",
    {
      description:
        "Set a clip's pitch shift — coarse (semitones, integer) and/or fine (cents, " +
        "float). Useful for audio (Simpler/Sampler) and warped audio clips. Either field " +
        "is optional.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        coarse_semitones: z.number().int().optional().describe("pitch in semitones"),
        fine_cents: z.number().optional().describe("fine pitch in cents (-50..50)"),
      },
    },
    async ({ track_index, clip_slot, coarse_semitones, fine_cents }) => {
      const c = await getClient();
      if (coarse_semitones !== undefined) {
        c.send("/live/clip/set/pitch_coarse", i(track_index), i(clip_slot), i(coarse_semitones));
      }
      if (fine_cents !== undefined) {
        c.send("/live/clip/set/pitch_fine", i(track_index), i(clip_slot), f(fine_cents));
      }
      return jsonResult({ track_index, clip_slot, coarse_semitones, fine_cents, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_warp",
    {
      description:
        "Configure audio-clip warping. `warping` enables/disables warp; `warp_mode` picks " +
        "the algorithm — one of: beats, tones, texture, re-pitch, complex, rex, " +
        "complex pro (case-insensitive). Either field is optional. No-op on MIDI clips.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        warping: z.boolean().optional(),
        warp_mode: z.string().optional().describe("beats|tones|texture|re-pitch|complex|rex|complex pro"),
      },
    },
    async ({ track_index, clip_slot, warping, warp_mode }) => {
      const c = await getClient();
      if (warping !== undefined) {
        c.send("/live/clip/set/warping", i(track_index), i(clip_slot), i(warping ? 1 : 0));
      }
      if (warp_mode !== undefined) {
        const v = WARP_MODE[warp_mode.toLowerCase()];
        if (v === undefined) {
          throw new Error(
            `unknown warp_mode ${JSON.stringify(warp_mode)}; choose: ${Object.keys(WARP_MODE).join(", ")}`,
          );
        }
        c.send("/live/clip/set/warp_mode", i(track_index), i(clip_slot), i(v));
      }
      return jsonResult({ track_index, clip_slot, warping, warp_mode, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_launch_mode",
    {
      description:
        "Set a clip's launch mode — how it responds to being fired: trigger (start), " +
        "gate (play while held), toggle (toggle on/off), repeat (retrigger).",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        mode: z.string().describe("trigger | gate | toggle | repeat"),
      },
    },
    async ({ track_index, clip_slot, mode }) => {
      const v = CLIP_LAUNCH_MODE[mode.toLowerCase()];
      if (v === undefined) {
        throw new Error(
          `unknown mode ${JSON.stringify(mode)}; choose: ${Object.keys(CLIP_LAUNCH_MODE).join(", ")}`,
        );
      }
      const c = await getClient();
      c.send("/live/clip/set/launch_mode", i(track_index), i(clip_slot), i(v));
      return jsonResult({ track_index, clip_slot, mode, action: "set" });
    },
  );

  server.registerTool(
    "set_clip_launch_quantization",
    {
      description:
        "Set a single clip's launch quantization grid (overrides the global default for " +
        "this clip). Same grid choices as set_launch_quantization: none, 8 bars, 4 bars, " +
        "2 bars, 1 bar, 1/2, 1/2T, 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        grid: z.string(),
      },
    },
    async ({ track_index, clip_slot, grid }) => {
      const c = await getClient();
      c.send(
        "/live/clip/set/launch_quantization",
        i(track_index), i(clip_slot), i(resolveQuant(grid)),
      );
      return jsonResult({ track_index, clip_slot, grid, action: "set" });
    },
  );

  server.registerTool(
    "quantize_clip",
    {
      description:
        "Quantize a clip's note timing toward a grid. amount=1.0 is a full snap; lower " +
        "values pull notes partway (preserving feel). grid is one of 1/4, 1/8, 1/8T, " +
        "1/16, 1/16T, 1/32 (T = triplet).",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must contain a MIDI clip"),
        grid: z.string().default("1/16").describe("grid resolution"),
        amount: z.number().default(1.0).describe("snap strength 0.0-1.0"),
      },
    },
    async ({ track_index, clip_slot, grid, amount }) => {
      const key = grid.toUpperCase();
      const gridValue = QUANTIZE_GRID[key];
      if (gridValue === undefined) {
        throw new Error(
          `unknown grid ${JSON.stringify(grid)}; choose from ${Object.keys(QUANTIZE_GRID)
            .sort()
            .join(", ")}`,
        );
      }
      if (!(amount >= 0 && amount <= 1)) {
        throw new Error(`amount ${amount} out of range 0.0-1.0`);
      }
      const c = await getClient();
      c.send("/live/clip/quantize", i(track_index), i(clip_slot), i(gridValue), f(amount));
      return jsonResult({ track_index, clip_slot, action: "quantized" });
    },
  );

  // ===== Arrangement =====

  server.registerTool(
    "duplicate_clip_to_arrangement",
    {
      description:
        "Copy a Session clip onto the track's Arrangement timeline at a beat position. " +
        "This is how you build a real, finite track (e.g. a 2-minute song). At 4/4, bar " +
        "N starts at beat (N-1)*4. Stamp a section clip at successive positions to lay " +
        "out intro/verse/chorus.",
      inputSchema: {
        track_index: z.number().int().describe("track owning the source clip and destination"),
        clip_slot: z.number().int().describe("source Session clip slot (must contain a clip)"),
        arrangement_beat: z.number().describe("destination position in beats (beat 0 = bar 1)"),
      },
    },
    async ({ track_index, clip_slot, arrangement_beat }) => {
      if (arrangement_beat < 0) {
        throw new Error(`arrangement_beat ${arrangement_beat} must be >= 0`);
      }
      const c = await getClient();
      c.send(
        "/live/track/duplicate_clip_to_arrangement",
        i(track_index),
        i(clip_slot),
        f(arrangement_beat),
      );
      await sleep(LIVE_TICK_MS);
      return jsonResult({
        track_index,
        source_clip_slot: clip_slot,
        arrangement_beat,
        action: "placed",
      });
    },
  );

  server.registerTool(
    "list_arrangement_clips",
    {
      description:
        "List the clips on a track's Arrangement timeline (name/start_beat/length_beats).",
      inputSchema: { track_index: z.number().int().describe("zero-based track index") },
    },
    async ({ track_index }) => {
      const c = await getClient();
      const names = (await c.query("/live/track/get/arrangement_clips/name", [i(track_index)])).slice(1);
      const starts = (
        await c.query("/live/track/get/arrangement_clips/start_time", [i(track_index)])
      ).slice(1);
      const lengths = (
        await c.query("/live/track/get/arrangement_clips/length", [i(track_index)])
      ).slice(1);
      const clips = names.map((n, idx) => ({
        name: asStr(n),
        start_beat: asNum(starts[idx]),
        length_beats: asNum(lengths[idx]),
      }));
      return jsonResult(clips);
    },
  );

  // ===== Clip playback =====

  server.registerTool(
    "play_clip",
    {
      description:
        "Trigger playback of the clip in the given clip slot (Session view). " +
        "Fire-and-forget; empty slot does nothing.",
      inputSchema: { track_index: z.number().int(), clip_slot: z.number().int() },
    },
    async ({ track_index, clip_slot }) => {
      const c = await getClient();
      c.send("/live/clip_slot/fire", i(track_index), i(clip_slot));
      return jsonResult({ track_index, clip_slot, action: "fired" });
    },
  );

  server.registerTool(
    "stop_clip",
    {
      description: "Stop playback of the clip in the given clip slot. No-op if not playing.",
      inputSchema: { track_index: z.number().int(), clip_slot: z.number().int() },
    },
    async ({ track_index, clip_slot }) => {
      const c = await getClient();
      c.send("/live/clip/stop", i(track_index), i(clip_slot));
      return jsonResult({ track_index, clip_slot, action: "stopped" });
    },
  );

  server.registerTool(
    "delete_clip",
    {
      description:
        "Delete the clip in the given clip slot, emptying the slot. Destructive but " +
        "Undo-able. Useful before recreating a clip in the same slot.",
      inputSchema: { track_index: z.number().int(), clip_slot: z.number().int() },
    },
    async ({ track_index, clip_slot }) => {
      const c = await getClient();
      c.send("/live/clip_slot/delete_clip", i(track_index), i(clip_slot));
      return jsonResult({ track_index, clip_slot, action: "deleted" });
    },
  );

  // ===== Browser: instrument presets / drum kits / load =====

  server.registerTool(
    "list_presets",
    {
      description:
        "List child names in Live's instrument browser at the given path " +
        "(app.browser.instruments). Empty path = top-level instruments; " +
        "'Wavetable/Synth Lead' = presets in that folder. Slash-separated.",
      inputSchema: {
        path: z.string().default("").describe("slash-separated path; '' for top-level"),
        ...FILTER_FIELD,
      },
    },
    async ({ path, filter }) => {
      const c = await getClient();
      const reply = await c.query("/live/browser/list_instrument_presets", [path]);
      return jsonResult({ path: asStr(reply[0]), children: applyFilter(reply.slice(1).map(asStr), filter) });
    },
  );

  server.registerTool(
    "list_drum_kits",
    {
      description:
        "List child names in Live's drum browser at the given path (app.browser.drums). " +
        "Empty path = top-level drum categories; a category path = the kits inside it. " +
        "Auto-paginates the fork's byte-capped reply (big packs have hundreds of kits).",
      inputSchema: {
        path: z.string().default("").describe("slash-separated path; '' for top-level"),
        ...FILTER_FIELD,
      },
    },
    async ({ path, filter }) => {
      return jsonResult(await listBrowserNode("/live/browser/list_drum_kits", path, filter));
    },
  );

  server.registerTool(
    "load_drum_kit",
    {
      description:
        "Load a complete drum kit onto a track by drum-browser path (e.g. 'Kit-Core " +
        "909/909 Kit'). Result is a Drum Rack with samples on standard pad pitches " +
        "(kick C1=36, snare D1=38). Use list_drum_kits to discover paths.",
      inputSchema: {
        track_index: z.number().int(),
        kit_path: z.string().describe("slash-separated browser path to the kit"),
      },
    },
    async ({ track_index, kit_path }) => {
      const c = await getClient();
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_drum_kit", i(track_index), kit_path);

      const deadline = Date.now() + DRUM_KIT_LOAD_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(LOAD_POLL_MS);
        let count: number;
        try {
          count = await numDevices(c, track_index);
        } catch (e) {
          if (e instanceof QueryTimeout) continue; // Live still busy streaming samples
          throw e;
        }
        if (count > devicesBefore) {
          return jsonResult({ track_index, preset_path: kit_path, device_index: devicesBefore });
        }
      }
      throw new Error(
        `Load timed out: drum kit ${JSON.stringify(kit_path)} did not appear on track ` +
          `${track_index} within ${DRUM_KIT_LOAD_TIMEOUT_MS / 1000}s. The path may not ` +
          "exist or may not be loadable; try list_drum_kits to verify.",
      );
    },
  );

  server.registerTool(
    "load_preset",
    {
      description:
        "Load an instrument preset onto a track by a list_presets path (the instruments " +
        "browser, organized by instrument ENGINE). The path must start with the engine. " +
        "✅ 'Electric/Piano & Keys/E-Piano MKI Mellow', ✅ 'Wavetable/Synth Lead/Big Pluck'. " +
        "For paths from list_sounds (organized by sound category, e.g. 'Piano & Keys/...'), " +
        "use load_sound instead. Complex racks (.adg) can take several seconds; this waits " +
        "until the device actually appears.",
      inputSchema: {
        track_index: z.number().int(),
        preset_path: z
          .string()
          .describe("engine-prefixed list_presets path, e.g. 'Electric/Piano & Keys/...'"),
      },
    },
    async ({ track_index, preset_path }) => {
      const c = await getClient();
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_instrument_preset", i(track_index), preset_path);

      const count = await waitForDeviceIncrease(c, track_index, devicesBefore, LOAD_TIMEOUT_MS);
      if (count !== null) return jsonResult({ track_index, preset_path, device_index: devicesBefore });
      throw new Error(
        `Load timed out: preset ${JSON.stringify(preset_path)} did not appear on track ` +
          `${track_index} within ${LOAD_TIMEOUT_MS / 1000}s. The path must come from ` +
          "list_presets and start with the instrument engine (e.g. 'Electric/...'). If it's " +
          "a list_sounds path (by sound category), use load_sound instead.",
      );
    },
  );

  server.registerTool(
    "load_sound",
    {
      description:
        "Load a preset from Live's Sounds browser onto a track — the cross-device view " +
        "organized by sound category. Pass a path from list_sounds, e.g. " +
        "'Piano & Keys/E-Piano MKI Mellow' or 'Bass/Sub Bass'. (This is the loader for " +
        "list_sounds paths; use load_preset for engine-prefixed list_presets paths.) " +
        "Complex racks (.adg) can take several seconds; this waits until the device appears.",
      inputSchema: {
        track_index: z.number().int(),
        sound_path: z.string().describe("a list_sounds path, e.g. 'Piano & Keys/...'"),
      },
    },
    async ({ track_index, sound_path }) => {
      const c = await getClient();
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_sound", i(track_index), sound_path);

      const count = await waitForDeviceIncrease(c, track_index, devicesBefore, LOAD_TIMEOUT_MS);
      if (count !== null) return jsonResult({ track_index, sound_path, device_index: devicesBefore });
      throw new Error(
        `Load timed out: sound ${JSON.stringify(sound_path)} did not appear on track ` +
          `${track_index} within ${LOAD_TIMEOUT_MS / 1000}s. Verify the path with list_sounds.`,
      );
    },
  );

  server.registerTool(
    "load_browser_item",
    {
      description:
        "Load a device from a browser node that has no dedicated loader: third-party " +
        "**plugins** (VST/VST3/AU), your **user_library** (saved racks/presets/instruments), " +
        "**packs** content, or **max_for_live** devices. Pair it with the matching list_* " +
        "tool: e.g. list_plugins → load_browser_item(node='plugins', path=...). The item " +
        "loads onto the track as a device. (For instruments/sounds/drums/audio & MIDI " +
        "effects/samples, use the dedicated load_* tools instead.) Complex items can take " +
        "several seconds; this waits until the device appears.",
      inputSchema: {
        track_index: z.number().int(),
        node: z
          .enum(["plugins", "user_library", "packs", "max_for_live"])
          .describe("which browser node the path is from (matches the list_* tool)"),
        path: z.string().describe("slash-separated path from the matching list_* tool"),
      },
    },
    async ({ track_index, node, path }) => {
      const c = await getClient();
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_browser_item", i(track_index), node, path);

      const count = await waitForDeviceIncrease(c, track_index, devicesBefore, LOAD_TIMEOUT_MS);
      if (count !== null) return jsonResult({ track_index, node, path, device_index: devicesBefore });
      throw new Error(
        `Load timed out: ${node} item ${JSON.stringify(path)} did not appear on track ` +
          `${track_index} within ${LOAD_TIMEOUT_MS / 1000}s. Verify the path with list_${node} ` +
          "(this loads device items; browser clips are a Live API ceiling — see DESIGN.md).",
      );
    },
  );

  // ===== Delete track / device =====

  server.registerTool(
    "delete_track",
    {
      description:
        "Delete a track from the song (devices + clips). Destructive but Undo-able (Cmd+Z).",
      inputSchema: { track_index: z.number().int() },
    },
    async ({ track_index }) => {
      const c = await getClient();
      c.send("/live/song/delete_track", i(track_index));
      return jsonResult({ track_index, action: "deleted" });
    },
  );

  server.registerTool(
    "delete_device",
    {
      description:
        "Delete a device (instrument or effect) from a track. Destructive but Undo-able. " +
        "Useful for swapping instruments.",
      inputSchema: { track_index: z.number().int(), device_index: z.number().int() },
    },
    async ({ track_index, device_index }) => {
      const c = await getClient();
      c.send("/live/track/delete_device", i(track_index), i(device_index));
      return jsonResult({ track_index, device_index, action: "deleted" });
    },
  );

  // ===== State visibility =====

  server.registerTool(
    "list_tracks",
    {
      description:
        "List every track with its zero-based index, name, whether it accepts MIDI " +
        "input, and device count. Use before any fix-the-bass / swap-the-lead workflow.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const nReply = await c.query("/live/song/get/num_tracks");
      const n = asNum(nReply[0]);
      const tracks = [];
      for (let k = 0; k < n; k++) {
        const nameReply = await c.query("/live/track/get/name", [i(k)]);
        const midiReply = await c.query("/live/track/get/has_midi_input", [i(k)]);
        const ndevReply = await c.query("/live/track/get/num_devices", [i(k)]);
        tracks.push({
          track_index: k,
          name: asStr(nameReply[1]),
          is_midi: asBool(midiReply[1]),
          num_devices: asNum(ndevReply[1]),
        });
      }
      return jsonResult(tracks);
    },
  );

  server.registerTool(
    "list_clips",
    {
      description:
        "List clip slots on a track with occupancy. Empty slots have has_clip=false and " +
        "name=null. Useful for 'what's already on the Bass track?'.",
      inputSchema: { track_index: z.number().int() },
    },
    async ({ track_index }) => {
      const c = await getClient();
      const nReply = await c.query("/live/song/get/num_scenes");
      const nScenes = asNum(nReply[0]);
      const slots = [];
      for (let s = 0; s < nScenes; s++) {
        const hasReply = await c.query("/live/clip_slot/get/has_clip", [i(track_index), i(s)]);
        const has = asBool(hasReply[2]);
        if (has) {
          const nameReply = await c.query("/live/clip/get/name", [i(track_index), i(s)]);
          const lengthReply = await c.query("/live/clip/get/length", [i(track_index), i(s)]);
          slots.push({
            clip_slot: s,
            has_clip: true,
            name: asStr(nameReply[2]),
            length_beats: asNum(lengthReply[2]),
          });
        } else {
          slots.push({ clip_slot: s, has_clip: false, name: null, length_beats: null });
        }
      }
      return jsonResult(slots);
    },
  );

  server.registerTool(
    "get_track_devices",
    {
      description:
        "List the devices (instrument + effects) on a track: index, name, type_id " +
        "(0=audio_effect, 1=instrument, 2=midi_effect), class_name. Use to discover " +
        "device indices before delete_device / get_device_parameters.",
      inputSchema: { track_index: z.number().int() },
    },
    async ({ track_index }) => {
      const c = await getClient();
      const ndevReply = await c.query("/live/track/get/num_devices", [i(track_index)]);
      const n = asNum(ndevReply[1]);
      if (n === 0) return jsonResult([]);
      const names = (await c.query("/live/track/get/devices/name", [i(track_index)])).slice(1);
      const types = (await c.query("/live/track/get/devices/type", [i(track_index)])).slice(1);
      const classes = (await c.query("/live/track/get/devices/class_name", [i(track_index)])).slice(1);
      const devices = [];
      for (let k = 0; k < n; k++) {
        devices.push({
          device_index: k,
          name: asStr(names[k]),
          type_id: asNum(types[k]),
          class_name: asStr(classes[k]),
        });
      }
      return jsonResult(devices);
    },
  );

  // ===== Mixer =====

  server.registerTool(
    "set_track_volume",
    {
      description:
        "Set track volume. Live's normalized volume in [0.0, 1.0]; ~0.85 is 0 dB unity, " +
        "1.0 is +6 dB.",
      inputSchema: { track_index: z.number().int(), volume: z.number().describe("0.0-1.0") },
    },
    async ({ track_index, volume }) => {
      if (!(volume >= 0 && volume <= 1)) throw new Error(`volume ${volume} out of range 0.0-1.0`);
      const c = await getClient();
      c.send("/live/track/set/volume", i(track_index), f(volume));
      return jsonResult({ track_index, property: "volume", value: volume });
    },
  );

  server.registerTool(
    "set_track_pan",
    {
      description: "Set track pan. -1.0 (full left) to 1.0 (full right); 0.0 is centered.",
      inputSchema: { track_index: z.number().int(), pan: z.number().describe("-1.0 to 1.0") },
    },
    async ({ track_index, pan }) => {
      if (!(pan >= -1 && pan <= 1)) throw new Error(`pan ${pan} out of range -1.0 to 1.0`);
      const c = await getClient();
      c.send("/live/track/set/panning", i(track_index), f(pan));
      return jsonResult({ track_index, property: "pan", value: pan });
    },
  );

  server.registerTool(
    "set_track_mute",
    {
      description: "Mute or unmute a track.",
      inputSchema: { track_index: z.number().int(), mute: z.boolean() },
    },
    async ({ track_index, mute }) => {
      const c = await getClient();
      c.send("/live/track/set/mute", i(track_index), i(mute ? 1 : 0));
      return jsonResult({ track_index, property: "mute", value: mute ? 1 : 0 });
    },
  );

  server.registerTool(
    "set_track_solo",
    {
      description: "Solo or un-solo a track.",
      inputSchema: { track_index: z.number().int(), solo: z.boolean() },
    },
    async ({ track_index, solo }) => {
      const c = await getClient();
      c.send("/live/track/set/solo", i(track_index), i(solo ? 1 : 0));
      return jsonResult({ track_index, property: "solo", value: solo ? 1 : 0 });
    },
  );

  // ===== Device parameters =====

  server.registerTool(
    "get_device_parameters",
    {
      description:
        "List a device's exposed parameters with current value + range: parameter_index, " +
        "name, value, min, max, is_quantized. Use to discover indices before " +
        "set_device_parameter.",
      inputSchema: { track_index: z.number().int(), device_index: z.number().int() },
    },
    async ({ track_index, device_index }) => {
      const c = await getClient();
      const nReply = await c.query("/live/device/get/num_parameters", [i(track_index), i(device_index)]);
      const n = asNum(nReply[2]);
      if (n === 0) return jsonResult([]);
      const args = [i(track_index), i(device_index)];
      const names = (await c.query("/live/device/get/parameters/name", args)).slice(2);
      const values = (await c.query("/live/device/get/parameters/value", args)).slice(2);
      const mins = (await c.query("/live/device/get/parameters/min", args)).slice(2);
      const maxs = (await c.query("/live/device/get/parameters/max", args)).slice(2);
      const quants = (await c.query("/live/device/get/parameters/is_quantized", args)).slice(2);
      const params = [];
      for (let k = 0; k < n; k++) {
        params.push({
          parameter_index: k,
          name: asStr(names[k]),
          value: asNum(values[k]),
          min: asNum(mins[k]),
          max: asNum(maxs[k]),
          is_quantized: asBool(quants[k]),
        });
      }
      return jsonResult(params);
    },
  );

  server.registerTool(
    "set_device_parameter",
    {
      description:
        "Set a single device parameter by index. Use get_device_parameters first for the " +
        "index + range. Out-of-range values are silently clamped by Live.",
      inputSchema: {
        track_index: z.number().int(),
        device_index: z.number().int(),
        parameter_index: z.number().int(),
        value: z.number(),
      },
    },
    async ({ track_index, device_index, parameter_index, value }) => {
      const c = await getClient();
      c.send(
        "/live/device/set/parameter/value",
        i(track_index),
        i(device_index),
        i(parameter_index),
        f(value),
      );
      return jsonResult({ track_index, device_index, parameter_index, value });
    },
  );

  // ===== Audio effects =====

  server.registerTool(
    "list_audio_effects",
    {
      description:
        "List child names in Live's audio-effects browser (app.browser.audio_effects). " +
        "Empty path = top-level categories (Reverb, Delay, EQ Eight, Compressor); a path " +
        "= presets in that folder.",
      inputSchema: { path: z.string().default(""), ...FILTER_FIELD },
    },
    async ({ path, filter }) => {
      const c = await getClient();
      const reply = await c.query("/live/browser/list_audio_effects", [path]);
      return jsonResult({ path: asStr(reply[0]), children: applyFilter(reply.slice(1).map(asStr), filter) });
    },
  );

  server.registerTool(
    "load_audio_effect",
    {
      description:
        "Load an audio effect onto a track by browser path (appended to the device " +
        "chain). E.g. 'Reverb' loads default Reverb; 'Compressor/Mixing/Vocal' a preset.",
      inputSchema: {
        track_index: z.number().int(),
        effect_path: z.string().describe("slash-separated browser path to the effect"),
      },
    },
    async ({ track_index, effect_path }) => {
      const c = await getClient();
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_audio_effect", i(track_index), effect_path);

      const count = await waitForDeviceIncrease(c, track_index, devicesBefore, LOAD_TIMEOUT_MS);
      if (count !== null) return jsonResult({ track_index, effect_path, device_index: devicesBefore });
      throw new Error(
        `Load timed out: audio effect ${JSON.stringify(effect_path)} did not appear on track ` +
          `${track_index} within ${LOAD_TIMEOUT_MS / 1000}s. The path may not exist or may ` +
          "not be loadable; try list_audio_effects to verify.",
      );
    },
  );

  // ===== MIDI effects =====

  server.registerTool(
    "list_midi_effects",
    {
      description:
        "List child names in Live's MIDI-effects browser (app.browser.midi_effects). " +
        "Empty path = top-level (Arpeggiator, Chord, Scale, Note Length, Random, etc.).",
      inputSchema: { path: z.string().default(""), ...FILTER_FIELD },
    },
    async ({ path, filter }) => {
      const c = await getClient();
      const reply = await c.query("/live/browser/list_midi_effects", [path]);
      return jsonResult({ path: asStr(reply[0]), children: applyFilter(reply.slice(1).map(asStr), filter) });
    },
  );

  server.registerTool(
    "load_midi_effect",
    {
      description:
        "Load a MIDI effect onto a MIDI track by browser path. MIDI effects process " +
        "notes before the instrument, so Live inserts them ahead of it (device indices " +
        "may shift). Returns the new total device_count.",
      inputSchema: {
        track_index: z.number().int(),
        effect_path: z.string().describe("slash-separated browser path to the MIDI effect"),
      },
    },
    async ({ track_index, effect_path }) => {
      const c = await getClient();
      const devicesBefore = await numDevices(c, track_index);
      c.send("/live/track/load_midi_effect", i(track_index), effect_path);

      const count = await waitForDeviceIncrease(c, track_index, devicesBefore, LOAD_TIMEOUT_MS);
      if (count !== null) return jsonResult({ track_index, effect_path, device_count: count });
      throw new Error(
        `Load timed out: MIDI effect ${JSON.stringify(effect_path)} did not appear on track ` +
          `${track_index} within ${LOAD_TIMEOUT_MS / 1000}s. The path may not exist or may ` +
          "not be loadable; try list_midi_effects to verify.",
      );
    },
  );

  // ===== Additional browser nodes =====

  const browserNodes: [string, string, string][] = [
    [
      "list_packs",
      "/live/browser/list_packs",
      "List content in Live's Packs browser (app.browser.packs) — installed Packs. A huge " +
        "share of premium sound lives in packs. Load found items with load_preset / " +
        "load_drum_kit / load_audio_effect / load_sample.",
    ],
    [
      "list_plugins",
      "/live/browser/list_plugins",
      "List third-party plugins (app.browser.plugins) — VST/VST3/AU instruments and effects.",
    ],
    [
      "list_user_library",
      "/live/browser/list_user_library",
      "List the User Library (app.browser.user_library) — your saved presets, racks, samples.",
    ],
    [
      "list_sounds",
      "/live/browser/list_sounds",
      "List Live 12's Sounds browser (app.browser.sounds) — content organized by sound " +
        "category (Bass, Piano & Keys, …). Load any of these paths with load_sound " +
        "(the paired loader for this browser).",
    ],
    [
      "list_browser_clips",
      "/live/browser/list_clips",
      "List browsable clips/loops in Live's Clips browser (app.browser.clips). Named " +
        "list_browser_clips to avoid clashing with list_clips (a track's Session slots).",
    ],
    [
      "list_max_for_live",
      "/live/browser/list_max_for_live",
      "List Max for Live devices (app.browser.max_for_live) — M4L instruments, effects, tools.",
    ],
    [
      "list_current_project",
      "/live/browser/list_current_project",
      "List content the current Live set references (app.browser.current_project).",
    ],
  ];

  for (const [name, address, description] of browserNodes) {
    server.registerTool(
      name,
      {
        description: `${description} Slash-separated path; '' for top-level.`,
        inputSchema: { path: z.string().default(""), ...FILTER_FIELD },
      },
      async ({ path, filter }) => jsonResult(await listBrowserNode(address, path, filter)),
    );
  }

  // ===== Sidechain =====

  server.registerTool(
    "get_sidechain_sources",
    {
      description:
        "List the available sidechain source names for a device. Only input-routing " +
        "devices (Compressor, Glue Compressor, Gate, Vocoder) return a non-empty list.",
      inputSchema: { track_index: z.number().int(), device_index: z.number().int() },
    },
    async ({ track_index, device_index }) => {
      const c = await getClient();
      const reply = await c.query(
        "/live/device/get/available_input_routing_types",
        [i(track_index), i(device_index)],
      );
      return jsonResult({ track_index, device_index, sources: reply.slice(2).map(asStr) });
    },
  );

  server.registerTool(
    "get_sidechain_channels",
    {
      description:
        "List the available sidechain channel tap points for a device (Pre FX, Post FX, " +
        "Post Mixer).",
      inputSchema: { track_index: z.number().int(), device_index: z.number().int() },
    },
    async ({ track_index, device_index }) => {
      const c = await getClient();
      const reply = await c.query(
        "/live/device/get/available_input_routing_channels",
        [i(track_index), i(device_index)],
      );
      return jsonResult({ track_index, device_index, channels: reply.slice(2).map(asStr) });
    },
  );

  server.registerTool(
    "set_sidechain_source",
    {
      description:
        "Set the sidechain source for a Compressor / Gate / Vocoder. Use " +
        "get_sidechain_sources first. To hear pumping, also enable the device's S/C On " +
        "parameter (often param index 20 on the stock Compressor) via set_device_parameter.",
      inputSchema: {
        track_index: z.number().int(),
        device_index: z.number().int(),
        source: z.string().describe("display name of the source (must match exactly)"),
      },
    },
    async ({ track_index, device_index, source }) => {
      const c = await getClient();
      c.send("/live/device/set/input_routing_type", i(track_index), i(device_index), source);
      return jsonResult({ track_index, device_index, value: source });
    },
  );

  server.registerTool(
    "set_sidechain_channel",
    {
      description:
        "Set the sidechain channel tap point. Use get_sidechain_channels first. Typical: " +
        "Pre FX, Post FX, Post Mixer.",
      inputSchema: {
        track_index: z.number().int(),
        device_index: z.number().int(),
        channel: z.string().describe("display name of the tap point (must match exactly)"),
      },
    },
    async ({ track_index, device_index, channel }) => {
      const c = await getClient();
      c.send("/live/device/set/input_routing_channel", i(track_index), i(device_index), channel);
      return jsonResult({ track_index, device_index, value: channel });
    },
  );

  // ===== Returns + sends =====

  server.registerTool(
    "list_return_tracks",
    {
      description:
        "List every return track with its index and name. Return indices are independent " +
        "of regular track indices.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const reply = await c.query("/live/song/get/return_tracks/name");
      return jsonResult(reply.map((name, idx) => ({ return_index: idx, name: asStr(name) })));
    },
  );

  server.registerTool(
    "create_return_track",
    {
      description:
        "Create a new (empty) return track at the end of the return-track list. Use " +
        "load_audio_effect_on_return + set_send to wire it up.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const beforeReply = await c.query("/live/song/get/num_return_tracks");
      const before = asNum(beforeReply[0]);
      c.send("/live/song/create_return_track");
      await sleep(LIVE_TICK_MS);
      return jsonResult({ return_index: before });
    },
  );

  server.registerTool(
    "delete_return_track",
    {
      description:
        "Delete a return track (and sends pointing at it). Destructive but Undo-able.",
      inputSchema: { return_index: z.number().int().describe("zero-based return-track index") },
    },
    async ({ return_index }) => {
      const c = await getClient();
      c.send("/live/song/delete_return_track", i(return_index));
      await sleep(LIVE_TICK_MS);
      return jsonResult({ return_index, action: "deleted" });
    },
  );

  server.registerTool(
    "load_audio_effect_on_return",
    {
      description:
        "Load an audio effect onto a return track by browser path (appended to its chain). " +
        "Fire-and-forget (no device-count confirmation for returns).",
      inputSchema: {
        return_index: z.number().int(),
        effect_path: z.string().describe("slash-separated browser path to the effect"),
      },
    },
    async ({ return_index, effect_path }) => {
      const c = await getClient();
      c.send("/live/return_track/load_audio_effect", i(return_index), effect_path);
      await sleep(LIVE_TICK_MS * 2);
      return jsonResult({ return_index, effect_path });
    },
  );

  server.registerTool(
    "set_send",
    {
      description:
        "Set a track's send level to a return track. Each regular track has one send per " +
        "return, indexed in order. value 0.0-1.0.",
      inputSchema: {
        track_index: z.number().int().describe("regular track sending audio"),
        send_index: z.number().int().describe("zero-based send/return index"),
        value: z.number().describe("0.0-1.0"),
      },
    },
    async ({ track_index, send_index, value }) => {
      if (!(value >= 0 && value <= 1)) throw new Error(`send value ${value} out of range 0.0-1.0`);
      const c = await getClient();
      c.send("/live/track/set/send", i(track_index), i(send_index), f(value));
      return jsonResult({ track_index, send_index, value });
    },
  );

  server.registerTool(
    "get_sends",
    {
      description: "List the send levels of a track to every return.",
      inputSchema: { track_index: z.number().int() },
    },
    async ({ track_index }) => {
      const c = await getClient();
      const nReply = await c.query("/live/song/get/num_return_tracks");
      const n = asNum(nReply[0]);
      const sends = [];
      for (let k = 0; k < n; k++) {
        const reply = await c.query("/live/track/get/send", [i(track_index), i(k)]);
        sends.push({ send_index: k, value: asNum(reply[2]) });
      }
      return jsonResult(sends);
    },
  );

  // ===== Master (Main) track =====

  server.registerTool(
    "load_audio_effect_on_master",
    {
      description:
        "Load an audio effect onto the Main (master) track — for mastering. Effects append " +
        "in order, so load front-to-back (e.g. Glue Compressor then Limiter puts the " +
        "brickwall limiter last). Returns the Main track's new device_count.",
      inputSchema: {
        effect_path: z.string().describe("slash-separated path under app.browser.audio_effects"),
      },
    },
    async ({ effect_path }) => {
      const c = await getClient();
      const beforeReply = await c.query("/live/master_track/get/num_devices");
      const before = asNum(beforeReply[0]);
      c.send("/live/master_track/load_audio_effect", effect_path);

      const deadline = Date.now() + LOAD_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(LOAD_POLL_MS);
        try {
          const countReply = await c.query("/live/master_track/get/num_devices");
          if (asNum(countReply[0]) > before) {
            return jsonResult({ effect_path, device_count: asNum(countReply[0]) });
          }
        } catch (e) {
          if (e instanceof QueryTimeout) continue; // Live busy loading — keep waiting
          throw e;
        }
      }
      throw new Error(
        `Load timed out: ${JSON.stringify(effect_path)} did not appear on the Main track ` +
          `within ${LOAD_TIMEOUT_MS / 1000}s. Check the path with list_audio_effects.`,
      );
    },
  );

  server.registerTool(
    "get_master_devices",
    {
      description:
        "List the devices on the Main (master) track in chain order. Use to inspect the " +
        "mastering chain and find device_index for get/set_master_device_parameter.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const reply = await c.query("/live/master_track/get/devices/name");
      return jsonResult(reply.map((n, idx) => ({ device_index: idx, name: asStr(n) })));
    },
  );

  server.registerTool(
    "get_master_device_parameters",
    {
      description:
        "List a Main-track device's parameters with current value and range " +
        "(parameter_index, name, value, min, max).",
      inputSchema: { device_index: z.number().int().describe("device index on the Main track") },
    },
    async ({ device_index }) => {
      return jsonResult(await readMasterDeviceParameters(device_index));
    },
  );

  server.registerTool(
    "set_master_device_parameter",
    {
      description:
        "Set a parameter on a Main-track device (comp threshold, limiter ceiling…). " +
        "Returns the parameter's info after setting (re-read to confirm).",
      inputSchema: {
        device_index: z.number().int(),
        parameter_index: z.number().int(),
        value: z.number(),
      },
    },
    async ({ device_index, parameter_index, value }) => {
      const c = await getClient();
      c.send("/live/master_track/set/device/parameter", i(device_index), i(parameter_index), f(value));
      await sleep(LIVE_TICK_MS);
      const params = await readMasterDeviceParameters(device_index);
      return jsonResult(params[parameter_index]);
    },
  );

  server.registerTool(
    "get_master_volume",
    {
      description: "Read the Main (master) track output volume (Live normalized, ~0.85 = 0 dB).",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      const reply = await c.query("/live/master_track/get/volume");
      return jsonResult({ volume: asNum(reply[0]) });
    },
  );

  server.registerTool(
    "set_master_volume",
    {
      description:
        "Set the Main (master) track output volume — the final output level. Normalized " +
        "[0.0, 1.0]; ~0.85 = 0 dB unity, 1.0 = +6 dB.",
      inputSchema: { volume: z.number().describe("0.0-1.0") },
    },
    async ({ volume }) => {
      if (!(volume >= 0 && volume <= 1)) throw new Error(`volume ${volume} out of range 0.0-1.0`);
      const c = await getClient();
      c.send("/live/master_track/set/volume", f(volume));
      return jsonResult({ volume });
    },
  );

  // ===== Clip editing: notes =====

  server.registerTool(
    "get_notes",
    {
      description:
        "Read notes from an existing clip, optionally filtered by pitch/time range. " +
        "Default range covers everything. Filtering is inclusive of start, exclusive of " +
        "(start+span).",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        start_pitch: z.number().int().default(ALL_PITCH_START),
        pitch_span: z.number().int().default(ALL_PITCH_SPAN),
        start_beat: z.number().default(ALL_BEAT_START),
        beat_span: z.number().default(ALL_BEAT_SPAN),
      },
    },
    async ({ track_index, clip_slot, start_pitch, pitch_span, start_beat, beat_span }) => {
      const c = await getClient();
      const reply = await c.query("/live/clip/get/notes", [
        i(track_index),
        i(clip_slot),
        i(start_pitch),
        i(pitch_span),
        f(start_beat),
        f(beat_span),
      ]);
      // reply: (track, slot, [pitch, start, duration, velocity, mute]*) — mute dropped.
      const notes: Note[] = [];
      for (let k = 2; k < reply.length; k += 5) {
        notes.push({
          pitch: asNum(reply[k]),
          start_beat: asNum(reply[k + 1]),
          duration_beat: asNum(reply[k + 2]),
          velocity: asNum(reply[k + 3]),
        });
      }
      return jsonResult(notes);
    },
  );

  server.registerTool(
    "add_notes_to_clip",
    {
      description:
        "Add notes to an existing clip without removing what's there. Use to iterate " +
        "(denser bassline, ghost notes). For a full replacement use delete_clip + create_clip.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        notes: z.array(noteSchema).describe("notes to add (same shape as create_clip)"),
      },
    },
    async ({ track_index, clip_slot, notes }) => {
      if (!notes.length) throw new Error("notes list is empty");
      notes.forEach((n, idx) => validateNote(n, idx));
      const c = await getClient();
      const flat: SendArg[] = [i(track_index), i(clip_slot)];
      for (const n of notes) {
        flat.push(
          i(n.pitch),
          f(quantizeTime(n.start_beat)),
          f(quantizeTime(n.duration_beat)),
          i(n.velocity),
          false,
        );
      }
      c.send("/live/clip/add/notes", ...flat);
      await sleep(LIVE_TICK_MS);
      return jsonResult({ track_index, clip_slot, added_count: notes.length });
    },
  );

  server.registerTool(
    "remove_notes",
    {
      description:
        "Remove notes from a clip in a pitch/time range. Default removes all. Pass " +
        "narrower ranges to surgically delete groups (e.g. all hi-hats: start_pitch=42, " +
        "pitch_span=1).",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int(),
        start_pitch: z.number().int().default(ALL_PITCH_START),
        pitch_span: z.number().int().default(ALL_PITCH_SPAN),
        start_beat: z.number().default(ALL_BEAT_START),
        beat_span: z.number().default(ALL_BEAT_SPAN),
      },
    },
    async ({ track_index, clip_slot, start_pitch, pitch_span, start_beat, beat_span }) => {
      const c = await getClient();
      c.send(
        "/live/clip/remove/notes",
        i(track_index),
        i(clip_slot),
        i(start_pitch),
        i(pitch_span),
        f(start_beat),
        f(beat_span),
      );
      await sleep(LIVE_TICK_MS);
      return jsonResult({ track_index, clip_slot });
    },
  );

  // ===== Samples =====

  server.registerTool(
    "list_samples",
    {
      description:
        "List child names in Live's sample browser (app.browser.samples), with " +
        "pagination. Reply is byte-capped to one OSC packet; when truncated use " +
        "offset = previous offset + len(children). total_count tells you when you're done.",
      inputSchema: {
        path: z.string().default("").describe("slash-separated path; '' for top-level"),
        offset: z.number().int().default(0).describe("zero-based index to start from"),
      },
    },
    async ({ path, offset }) => {
      const c = await getClient();
      const reply = await c.query("/live/browser/list_samples", [path, i(offset)], 3000);
      return jsonResult({
        path: asStr(reply[0]),
        offset: asNum(reply[1]),
        total_count: asNum(reply[2]),
        children: reply.slice(3).map(asStr),
      });
    },
  );

  server.registerTool(
    "load_sample",
    {
      description:
        "Load a sample onto a MIDI track (Live wraps it in a Simpler). Playable via MIDI; " +
        "replaces any existing instrument. Fire-and-forget (loads can be slow on first call).",
      inputSchema: {
        track_index: z.number().int(),
        sample_path: z.string().describe("slash-separated path under app.browser.samples"),
      },
    },
    async ({ track_index, sample_path }) => {
      const c = await getClient();
      c.send("/live/track/load_sample", i(track_index), sample_path);
      await sleep(LIVE_TICK_MS * 3);
      return jsonResult({ track_index, sample_path });
    },
  );

  server.registerTool(
    "load_audio_clip",
    {
      description:
        "Drop an audio file directly into a Session clip slot as a real audio clip — " +
        "wraps Live's `ClipSlot.create_audio_clip`. **This is the only programmatic way to " +
        "land an audio loop on the Session grid** (Live's Clip API otherwise can't " +
        "materialise audio clips from files; `load_sample` is the Simpler-wrapped fallback). " +
        "Requirements: track must be an **audio track** (use `create_audio_track`), the slot " +
        "must be **empty**, and `file_path` must be an **absolute filesystem path** to a " +
        "decodable audio file (.wav/.aif/.aiff/.mp3/.flac/.ogg). `.alc` browser clips are " +
        "XML wrappers and are NOT accepted directly — extract the audio reference first.",
      inputSchema: {
        track_index: z.number().int().describe("zero-based audio track index"),
        clip_slot: z.number().int().describe("zero-based clip slot (scene) index; must be empty"),
        file_path: z
          .string()
          .describe("absolute filesystem path to an audio file (must start with '/')"),
      },
    },
    async ({ track_index, clip_slot, file_path }) => {
      if (!file_path.startsWith("/")) {
        throw new Error(
          `file_path must be an absolute path (got ${JSON.stringify(file_path)}). ` +
            "Live rejects relative paths.",
        );
      }
      const c = await getClient();
      // Preflight: slot must be empty.
      const beforeR = await c.query("/live/clip_slot/get/has_clip", [
        i(track_index),
        i(clip_slot),
      ]);
      if (asBool(beforeR[2])) {
        throw new Error(
          `clip_slot (${track_index}, ${clip_slot}) already contains a clip. ` +
            "Delete it first or pick another slot.",
        );
      }
      c.send("/live/clip_slot/load_audio_clip", i(track_index), i(clip_slot), file_path);

      // Poll for the slot to fill. create_audio_clip is fast for short files
      // but heavier loops (multi-MB) can take a few hundred ms.
      const deadline = Date.now() + LOAD_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(LOAD_POLL_MS);
        try {
          const r = await c.query("/live/clip_slot/get/has_clip", [
            i(track_index),
            i(clip_slot),
          ]);
          if (asBool(r[2])) {
            // Pull the clip name for nice feedback.
            const nameR = await c.query("/live/clip/get/name", [
              i(track_index),
              i(clip_slot),
            ]);
            return jsonResult({
              track_index,
              clip_slot,
              file_path,
              clip_name: asStr(nameR[2]),
            });
          }
        } catch (e) {
          if (e instanceof QueryTimeout) continue;
          throw e;
        }
      }
      throw new Error(
        `load_audio_clip timed out: clip did not appear at (track ${track_index}, slot ${clip_slot}) ` +
          `within ${LOAD_TIMEOUT_MS / 1000}s. Common causes: track is not an audio track ` +
          "(use create_audio_track), file_path doesn't point to a decodable audio file, or " +
          "the path is wrong. Check Live's AbletonOSC log for the underlying error.",
      );
    },
  );

  server.registerTool(
    "load_sample_to_drum_pad",
    {
      description:
        "Load a sample onto a specific pad of a Drum Rack (swap a single drum without " +
        "touching the kit). The Drum Rack must already exist. pad_pitch is the MIDI note: " +
        "36=kick, 38=snare, 39=clap, 42=closed hat, 46=open hat, 49=crash, 51=ride.",
      inputSchema: {
        track_index: z.number().int(),
        device_index: z.number().int().describe("device index of the Drum Rack"),
        pad_pitch: z.number().int().describe("MIDI note (0-127) of the target pad"),
        sample_path: z.string().describe("slash-separated path under app.browser.samples"),
      },
    },
    async ({ track_index, device_index, pad_pitch, sample_path }) => {
      const c = await getClient();
      c.send(
        "/live/track/load_sample_to_drum_pad",
        i(track_index),
        i(device_index),
        i(pad_pitch),
        sample_path,
      );
      await sleep(LIVE_TICK_MS * 3);
      return jsonResult({ track_index, device_index, pad_pitch, sample_path });
    },
  );

  server.registerTool(
    "list_drum_pads",
    {
      description:
        "List the populated pads of a Drum Rack with their MIDI note and name (empty pads " +
        "omitted, ordered by note). Returns [] if the device is not a Drum Rack.",
      inputSchema: {
        track_index: z.number().int(),
        device_index: z.number().int().describe("device index of the Drum Rack"),
      },
    },
    async ({ track_index, device_index }) => {
      const c = await getClient();
      const reply = await c.query("/live/device/get/drum_pads", [i(track_index), i(device_index)]);
      // reply: (track, device, note1, name1, note2, name2, ...)
      const padData = reply.slice(2);
      const pads = [];
      for (let k = 0; k < padData.length; k += 2) {
        pads.push({ note: asNum(padData[k]), name: asStr(padData[k + 1]) });
      }
      return jsonResult(pads);
    },
  );

  // ===== Clip automation =====

  server.registerTool(
    "automate_device_parameter",
    {
      description:
        "Write step automation for a device parameter into a clip's envelope. Each step " +
        "is a constant-value segment [start_beat, start_beat+length_beats). For a smooth " +
        "ramp pass many small adjacent steps. The envelope loops with the clip. Use " +
        "get_device_parameters first for indices + [min,max].",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must already contain a clip"),
        device_index: z.number().int(),
        parameter_index: z.number().int(),
        steps: z.array(automationStepSchema),
      },
    },
    async ({ track_index, clip_slot, device_index, parameter_index, steps }) => {
      const flat = flattenSteps(steps);
      const c = await getClient();
      c.send(
        "/live/clip/automate_device_parameter",
        i(track_index),
        i(clip_slot),
        i(device_index),
        i(parameter_index),
        ...flat.map(f),
      );
      await sleep(LIVE_TICK_MS);
      return jsonResult({ track_index, clip_slot, step_count: steps.length });
    },
  );

  server.registerTool(
    "automate_mixer_parameter",
    {
      description:
        "Write step automation for a mixer parameter (volume / panning / send_N). " +
        "volume normalized 0.0-1.0; panning -1.0..1.0; send_N where N is the zero-based " +
        "return index. Use cases: automation-based sidechain ducking, reverb send swells.",
      inputSchema: {
        track_index: z.number().int(),
        clip_slot: z.number().int().describe("must already contain a clip"),
        parameter: z.string().describe('"volume" | "panning" | "send_N"'),
        steps: z.array(automationStepSchema),
      },
    },
    async ({ track_index, clip_slot, parameter, steps }) => {
      const flat = flattenSteps(steps);
      const c = await getClient();
      c.send(
        "/live/clip/automate_mixer_parameter",
        i(track_index),
        i(clip_slot),
        parameter,
        ...flat.map(f),
      );
      await sleep(LIVE_TICK_MS);
      return jsonResult({ track_index, clip_slot, step_count: steps.length });
    },
  );

  server.registerTool(
    "re_enable_automation",
    {
      description:
        "Re-enable any automation Live has currently disabled (the orange dot), song-wide. " +
        "Our automate_* tools already re-enable per-parameter, so this is rarely needed.",
      inputSchema: {},
    },
    async () => {
      const c = await getClient();
      c.send("/live/song/re_enable_automation");
      return jsonResult({ action: "automation re-enabled" });
    },
  );

  server.registerTool(
    "clear_clip_envelopes",
    {
      description:
        "Remove all automation envelopes from a clip (resets automated params to static). " +
        "Doesn't touch notes.",
      inputSchema: { track_index: z.number().int(), clip_slot: z.number().int() },
    },
    async ({ track_index, clip_slot }) => {
      const c = await getClient();
      c.send("/live/clip/clear_envelopes", i(track_index), i(clip_slot));
      await sleep(LIVE_TICK_MS);
      return jsonResult({ track_index, clip_slot });
    },
  );
}
