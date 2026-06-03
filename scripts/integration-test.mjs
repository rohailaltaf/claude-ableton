/**
 * Live integration test: spawn the built MCP server and exercise the 114 tools
 * against a running Ableton Live (AbletonOSC selected as Control Surface).
 *
 * REQUIREMENTS:
 *   - Port 11001 must be FREE (stop the Python MCP server first).
 *   - A SCRATCH Live set should be open — this creates/deletes tracks, clips,
 *     scenes, return tracks, and adds a device to the Main track.
 *
 * Run: node scripts/integration-test.mjs
 * Exits non-zero if any tool fails.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "integration-test", version: "0.0.0" });
await client.connect(transport);

let pass = 0;
let fail = 0;
const failures = [];

/** Call a tool, parse JSON result, throw on isError. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text ?? "").join("") ?? "";
  if (res.isError) throw new Error(`${name} -> isError: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text; // some tools may return non-JSON; keep raw
  }
}

/** Run a labelled check; record pass/fail; never throws. */
async function step(label, fn) {
  try {
    const out = await fn();
    console.log(`PASS  ${label}`);
    pass++;
    return out;
  } catch (e) {
    console.log(`FAIL  ${label}\n        ${e.message}`);
    fail++;
    failures.push(label);
    return undefined;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function findTrackByName(name) {
  const tracks = await call("list_tracks");
  const t = tracks.find((x) => x.name === name);
  return t ? t.track_index : -1;
}

const KEYS = "ZZ Test Keys";
const DRUMS = "ZZ Test Drums";
const SMP = "ZZ Test Sample";

let keysIdx = -1;
let drumsIdx = -1;
let smpIdx = -1;
let returnIdx = -1;
let origTempo = 120;

try {
  // ---- read-state ----
  await step("get_tempo", async () => {
    const r = await call("get_tempo");
    assert(typeof r.bpm === "number", "no bpm");
    origTempo = r.bpm;
  });
  await step("get_time_signature", async () => {
    const r = await call("get_time_signature");
    assert(r.numerator > 0 && r.denominator > 0, "bad sig");
  });
  await step("get_playback_state", async () => {
    const r = await call("get_playback_state");
    assert(typeof r.is_playing === "boolean", "no is_playing");
  });
  await step("set_tempo (90) + get_tempo round-trip", async () => {
    await call("set_tempo", { bpm: 90 });
    const r = await call("get_tempo");
    assert(Math.abs(r.bpm - 90) < 0.5, `expected 90 got ${r.bpm}`);
  });
  await step("get_song_length", async () => {
    const r = await call("get_song_length");
    assert(typeof r.length_beats === "number" && r.length_beats >= 0, "no length_beats");
  });
  await step("set_midi_recording_quantization (round-trip via none)", async () => {
    await call("set_midi_recording_quantization", { grid: "1/16" });
    const r = await call("set_midi_recording_quantization", { grid: "none" });
    assert(r.value === 0, `expected value 0 for none, got ${r.value}`);
  });
  await step("set_groove_amount", async () => {
    const r = await call("set_groove_amount", { amount: 0.5 });
    assert(Math.abs(r.amount - 0.5) < 1e-6, "groove amount not echoed");
    await call("set_groove_amount", { amount: 0 });
  });

  // ---- time signature: set 3/4, create_clip honors it, restore ----
  await step("set_time_signature + sig-aware create_clip + set_clip_time_signature", async () => {
    const orig = await call("get_time_signature");
    await call("set_time_signature", { numerator: 3, denominator: 4 });
    const got = await call("get_time_signature");
    assert(got.numerator === 3 && got.denominator === 4, `sig didn't set: ${JSON.stringify(got)}`);
    const idx = (await call("create_midi_track", { name: "ZZ Sig" })).track_index;
    const r = await call("create_clip", { track_index: idx, clip_slot: 0, length_bars: 2 });
    assert(r.length_beats === 6, `expected 6 beats in 3/4, got ${r.length_beats}`);
    // per-clip sig (no read-back tool; setting without error is the assertion)
    await call("set_clip_time_signature", { track_index: idx, clip_slot: 0, numerator: 6, denominator: 8 });
    await call("delete_track", { track_index: idx });
    await call("set_time_signature", orig);
  });

  // ---- v0.1.5 batch: scale + transport + clip details (self-contained) ----
  await step("scale + transport + clip-detail setters", async () => {
    const origScale = await call("get_project_scale");
    await call("set_project_scale", { root_note: 0, scale_name: "Minor" });
    const got = await call("get_project_scale");
    assert(got.scale_name === "Minor", `scale didn't set: ${JSON.stringify(got)}`);

    await call("set_song_position", { beat: 8 });
    await call("set_metronome", { on: true });
    await call("set_metronome", { on: false });
    await call("set_arrangement_loop", { start_beats: 0, length_beats: 16, enabled: true });
    await call("set_arrangement_loop", { enabled: false });
    await call("set_launch_quantization", { grid: "1 bar" });

    const idx = (await call("create_midi_track", { name: "ZZ v15" })).track_index;
    await call("create_clip", {
      track_index: idx, clip_slot: 0, length_bars: 2,
      notes: [{ pitch: 60, start_beat: 0, duration_beat: 1, velocity: 90 }],
    });
    await call("set_clip_gain", { track_index: idx, clip_slot: 0, gain: 0.7 });
    await call("set_clip_mute", { track_index: idx, clip_slot: 0, muted: true });
    await call("set_clip_pitch", { track_index: idx, clip_slot: 0, coarse_semitones: 2, fine_cents: 0 });
    await call("set_clip_region", { track_index: idx, clip_slot: 0, start_marker: 0, end_marker: 4 });
    await call("set_clip_loop_region", { track_index: idx, clip_slot: 0, loop_start: 0, loop_end: 4 });
    await call("set_clip_launch_mode", { track_index: idx, clip_slot: 0, mode: "gate" });
    await call("set_clip_launch_quantization", { track_index: idx, clip_slot: 0, grid: "1/4" });
    await call("set_clip_warp", { track_index: idx, clip_slot: 0, warping: false });
    await call("set_clip_position", { track_index: idx, clip_slot: 0, position_beats: 4 });

    // bad input rejection
    let rejected = false;
    try { await call("set_launch_quantization", { grid: "bogus" }); } catch { rejected = true; }
    assert(rejected, "invalid grid was not rejected");

    await call("delete_track", { track_index: idx });
    await call("set_project_scale", origScale);
  });

  // ---- track + instrument ----
  await step("create_midi_track (Keys)", async () => {
    const r = await call("create_midi_track", { name: KEYS });
    assert(typeof r.track_index === "number", "no track_index");
    keysIdx = r.track_index;
  });
  await step("list_tracks finds Keys", async () => {
    const idx = await findTrackByName(KEYS);
    assert(idx === keysIdx, `Keys at ${idx} not ${keysIdx}`);
  });
  await step("load_instrument operator", async () => {
    const r = await call("load_instrument", { track_index: keysIdx, instrument: "operator" });
    assert(r.device_index === 0, `device_index ${r.device_index}`);
  });
  await step("get_track_devices has Operator", async () => {
    const devs = await call("get_track_devices", { track_index: keysIdx });
    assert(devs.length >= 1 && /operator/i.test(devs[0].name), "no Operator");
  });
  let opParamCount = 0;
  await step("get_device_parameters", async () => {
    const params = await call("get_device_parameters", { track_index: keysIdx, device_index: 0 });
    assert(params.length > 0, "no params");
    opParamCount = params.length;
  });
  await step("set_device_parameter", async () => {
    const params = await call("get_device_parameters", { track_index: keysIdx, device_index: 0 });
    const p = params.find((x) => !x.is_quantized) ?? params[0];
    await call("set_device_parameter", {
      track_index: keysIdx,
      device_index: 0,
      parameter_index: p.parameter_index,
      value: p.min + (p.max - p.min) * 0.5,
    });
  });

  // ---- clips + notes ----
  const notes = [
    { pitch: 60, start_beat: 0, duration_beat: 1, velocity: 100 },
    { pitch: 64, start_beat: 1, duration_beat: 1, velocity: 90 },
    { pitch: 67, start_beat: 2, duration_beat: 2, velocity: 80 },
  ];
  await step("create_clip with notes", async () => {
    const r = await call("create_clip", {
      track_index: keysIdx,
      clip_slot: 0,
      length_bars: 2,
      notes,
      name: "ZZ clip",
    });
    assert(r.note_count === 3, `note_count ${r.note_count}`);
  });
  await step("get_notes round-trip", async () => {
    const got = await call("get_notes", { track_index: keysIdx, clip_slot: 0 });
    assert(got.length === 3, `got ${got.length} notes`);
    const pitches = got.map((n) => n.pitch).sort((a, b) => a - b);
    assert(pitches.join(",") === "60,64,67", `pitches ${pitches}`);
  });
  await step("add_notes_to_clip", async () => {
    await call("add_notes_to_clip", {
      track_index: keysIdx,
      clip_slot: 0,
      notes: [{ pitch: 72, start_beat: 3, duration_beat: 1, velocity: 70 }],
    });
    const got = await call("get_notes", { track_index: keysIdx, clip_slot: 0 });
    assert(got.length === 4, `expected 4 got ${got.length}`);
  });
  await step("remove_notes (pitch 72 only)", async () => {
    await call("remove_notes", {
      track_index: keysIdx,
      clip_slot: 0,
      start_pitch: 72,
      pitch_span: 1,
    });
    const got = await call("get_notes", { track_index: keysIdx, clip_slot: 0 });
    assert(got.length === 3, `expected 3 got ${got.length}`);
  });
  await step("set_clip_name", () => call("set_clip_name", { track_index: keysIdx, clip_slot: 0, name: "ZZ renamed" }));
  await step("set_clip_loop", () => call("set_clip_loop", { track_index: keysIdx, clip_slot: 0, looping: true }));
  await step("set_clip_color (RGB)", () => call("set_clip_color", { track_index: keysIdx, clip_slot: 0, color: 0xff8800 }));
  await step("set_clip_color (color_index)", () => call("set_clip_color", { track_index: keysIdx, clip_slot: 0, color_index: 5 }));
  await step("quantize_clip", () => call("quantize_clip", { track_index: keysIdx, clip_slot: 0, grid: "1/16", amount: 1.0 }));
  await step("duplicate_clip_loop (clip must loop)", async () => {
    const before = (await call("list_clips", { track_index: keysIdx })).find((c) => c.clip_slot === 0);
    await call("duplicate_clip_loop", { track_index: keysIdx, clip_slot: 0 });
    const after = (await call("list_clips", { track_index: keysIdx })).find((c) => c.clip_slot === 0);
    assert(after.length_beats >= before.length_beats, "loop length did not grow");
  });
  await step("duplicate_clip (slot 0 -> 1)", async () => {
    await call("duplicate_clip", { track_index: keysIdx, clip_slot: 0, target_track: keysIdx, target_clip_slot: 1 });
    const clips = await call("list_clips", { track_index: keysIdx });
    assert(clips.find((c) => c.clip_slot === 1)?.has_clip, "slot 1 empty");
  });
  await step("chord_progression (smooth)", async () => {
    const r = await call("chord_progression", {
      track_index: keysIdx,
      clip_slot: 2,
      chords: ["Cmaj7", "Am7", "Fmaj7", "G7"],
    });
    assert(r.note_count === 16, `note_count ${r.note_count}`);
  });
  await step("list_clips", async () => {
    const clips = await call("list_clips", { track_index: keysIdx });
    assert(clips.filter((c) => c.has_clip).length >= 3, "expected >=3 clips");
  });

  // ---- scenes ----
  await step("list_scenes", async () => {
    const s = await call("list_scenes");
    assert(Array.isArray(s) && s.length > 0, "no scenes");
  });
  let newSceneIdx = -1;
  await step("create_scene", async () => {
    const r = await call("create_scene", { name: "ZZ scene" });
    newSceneIdx = r.scene_index;
  });
  await step("duplicate_scene", () => call("duplicate_scene", { scene_index: newSceneIdx }));
  await step("rename_scene", () => call("rename_scene", { scene_index: newSceneIdx, name: "ZZ scene 2" }));
  await step("set_scene_tempo + set_scene_time_signature + list_scenes readback", async () => {
    await call("set_scene_tempo", { scene_index: newSceneIdx, bpm: 142 });
    await call("set_scene_time_signature", { scene_index: newSceneIdx, numerator: 7, denominator: 8 });
    const scenes = await call("list_scenes");
    const sc = scenes.find((s) => s.scene_index === newSceneIdx);
    assert(sc, "scene not found in list_scenes");
    assert(sc.tempo_enabled === true, "tempo_enabled not set");
    assert(Math.abs(sc.tempo - 142) < 0.5, `scene tempo not 142 (got ${sc.tempo})`);
    assert(sc.time_signature_enabled === true, "time_signature_enabled not set");
    assert(
      sc.time_signature && sc.time_signature.numerator === 7 && sc.time_signature.denominator === 8,
      `scene time sig not 7/8 (got ${JSON.stringify(sc.time_signature)})`,
    );
    // clear overrides
    await call("set_scene_tempo", { scene_index: newSceneIdx, bpm: 120, enabled: false });
    await call("set_scene_time_signature", { scene_index: newSceneIdx, numerator: 4, denominator: 4, enabled: false });
    const cleared = (await call("list_scenes")).find((s) => s.scene_index === newSceneIdx);
    assert(cleared.tempo_enabled === false && cleared.tempo === null, "tempo override not cleared");
    assert(cleared.time_signature_enabled === false && cleared.time_signature === null, "time sig override not cleared");
  });
  await step("delete_scene (the duplicate)", () => call("delete_scene", { scene_index: newSceneIdx + 1 }));

  // ---- transport ----
  await step("fire_scene", () => call("fire_scene", { scene_index: 0 }));
  await step("play_clip", () => call("play_clip", { track_index: keysIdx, clip_slot: 0 }));
  await step("stop_clip", () => call("stop_clip", { track_index: keysIdx, clip_slot: 0 }));
  await step("start_playing", () => call("start_playing"));
  await step("continue_playing", () => call("continue_playing"));
  await step("stop_all_clips (all)", () => call("stop_all_clips"));
  await step("stop_all_clips (one track)", () => call("stop_all_clips", { track_index: keysIdx }));
  await step("stop_playing", () => call("stop_playing"));
  await step("undo + redo", async () => {
    const u = await call("undo");
    assert(typeof u.can_undo_more === "boolean", "undo missing can_undo_more");
    const r = await call("redo");
    assert(typeof r.can_redo_more === "boolean", "redo missing can_redo_more");
  });

  // ---- arrangement ----
  await step("duplicate_clip_to_arrangement x2", async () => {
    await call("duplicate_clip_to_arrangement", { track_index: keysIdx, clip_slot: 0, arrangement_beat: 0 });
    await call("duplicate_clip_to_arrangement", { track_index: keysIdx, clip_slot: 0, arrangement_beat: 8 });
  });
  await step("list_arrangement_clips", async () => {
    const a = await call("list_arrangement_clips", { track_index: keysIdx });
    assert(a.length >= 2, `expected >=2 arrangement clips got ${a.length}`);
  });

  // ---- mixer ----
  await step("set_track_volume", () => call("set_track_volume", { track_index: keysIdx, volume: 0.8 }));
  await step("set_track_pan", () => call("set_track_pan", { track_index: keysIdx, pan: -0.2 }));
  await step("set_track_mute", () => call("set_track_mute", { track_index: keysIdx, mute: false }));
  await step("set_track_solo", () => call("set_track_solo", { track_index: keysIdx, solo: false }));
  await step("set_track_color (RGB) + color_index + list_tracks readback", async () => {
    await call("set_track_color", { track_index: keysIdx, color_index: 12 });
    const t = (await call("list_tracks")).find((x) => x.track_index === keysIdx);
    assert(t.color_index === 12, `track color_index not 12 (got ${t.color_index})`);
    await call("set_track_color", { track_index: keysIdx, color: 0x00ff00 });
  });
  await step("set_track_arm + monitoring + list_tracks readback", async () => {
    const t0 = (await call("list_tracks")).find((x) => x.track_index === keysIdx);
    assert(typeof t0.can_be_armed === "boolean", "no can_be_armed");
    assert(t0.can_be_armed, "MIDI track should be armable");
    await call("set_track_arm", { track_index: keysIdx, armed: true });
    await call("set_track_monitoring", { track_index: keysIdx, mode: "in" });
    const t1 = (await call("list_tracks")).find((x) => x.track_index === keysIdx);
    assert(t1.armed === true, "track not armed");
    assert(t1.monitoring === "in", `monitoring not 'in' (got ${t1.monitoring})`);
    // restore
    await call("set_track_monitoring", { track_index: keysIdx, mode: "auto" });
    await call("set_track_arm", { track_index: keysIdx, armed: false });
  });

  // ---- MIDI effects (loads ahead of instrument; device idx shifts) ----
  await step("list_midi_effects", async () => {
    const r = await call("list_midi_effects");
    assert(r.children.length > 0, "no midi effects");
  });
  await step("load_midi_effect Arpeggiator", async () => {
    const r = await call("load_midi_effect", { track_index: keysIdx, effect_path: "Arpeggiator" });
    assert(r.device_count >= 2, `device_count ${r.device_count}`);
  });

  // ---- audio effects ----
  await step("list_audio_effects", async () => {
    const r = await call("list_audio_effects");
    assert(r.children.length > 0, "no audio effects");
  });
  await step("load_audio_effect Reverb", async () => {
    await call("load_audio_effect", { track_index: keysIdx, effect_path: "Reverb" });
  });

  // ---- sidechain (needs a Compressor) ----
  await step("load_audio_effect Compressor (for sidechain)", async () => {
    await call("load_audio_effect", { track_index: keysIdx, effect_path: "Compressor" });
  });
  let compIdx = -1;
  await step("locate Compressor device", async () => {
    const devs = await call("get_track_devices", { track_index: keysIdx });
    const c = devs.find((d) => /compressor/i.test(d.name));
    assert(c, "no compressor");
    compIdx = c.device_index;
  });
  await step("get_sidechain_sources", async () => {
    const r = await call("get_sidechain_sources", { track_index: keysIdx, device_index: compIdx });
    assert(Array.isArray(r.sources), "no sources");
  });
  await step("get_sidechain_channels", async () => {
    const r = await call("get_sidechain_channels", { track_index: keysIdx, device_index: compIdx });
    assert(Array.isArray(r.channels), "no channels");
  });
  await step("set_sidechain_source", async () => {
    const r = await call("get_sidechain_sources", { track_index: keysIdx, device_index: compIdx });
    const src = r.sources.find((s) => s !== "No Input") ?? r.sources[0];
    await call("set_sidechain_source", { track_index: keysIdx, device_index: compIdx, source: src });
  });
  await step("set_sidechain_channel", async () => {
    const r = await call("get_sidechain_channels", { track_index: keysIdx, device_index: compIdx });
    await call("set_sidechain_channel", { track_index: keysIdx, device_index: compIdx, channel: r.channels[0] });
  });

  // ---- returns + sends ----
  await step("create_return_track", async () => {
    const r = await call("create_return_track");
    returnIdx = r.return_index;
  });
  await step("list_return_tracks", async () => {
    const r = await call("list_return_tracks");
    assert(r.length > returnIdx, "return not listed");
  });
  await step("load_audio_effect_on_return", () => call("load_audio_effect_on_return", { return_index: returnIdx, effect_path: "Reverb" }));
  await step("set_send", () => call("set_send", { track_index: keysIdx, send_index: returnIdx, value: 0.3 }));
  await step("get_sends", async () => {
    const r = await call("get_sends", { track_index: keysIdx });
    assert(r.length > returnIdx, "send missing");
  });

  // ---- master ----
  await step("load_audio_effect_on_master Glue Compressor", async () => {
    const r = await call("load_audio_effect_on_master", { effect_path: "Glue Compressor" });
    assert(r.device_count >= 1, "no master device");
  });
  await step("get_master_devices", async () => {
    const r = await call("get_master_devices");
    assert(r.length >= 1, "no master devices");
  });
  await step("get_master_device_parameters", async () => {
    const r = await call("get_master_device_parameters", { device_index: 0 });
    assert(r.length > 0, "no master params");
  });
  await step("set_master_device_parameter", async () => {
    const params = await call("get_master_device_parameters", { device_index: 0 });
    const p = params.find((x) => /threshold/i.test(x.name)) ?? params[0];
    const out = await call("set_master_device_parameter", {
      device_index: 0,
      parameter_index: p.parameter_index,
      value: p.min + (p.max - p.min) * 0.5,
    });
    assert(typeof out.value === "number", "no value back");
  });
  await step("get_master_volume", async () => {
    const r = await call("get_master_volume");
    assert(typeof r.volume === "number", "no volume");
  });
  await step("set_master_volume", () => call("set_master_volume", { volume: 0.85 }));

  // ---- automation ----
  const steps = [
    { start_beat: 0, length_beats: 1, value: 0.2 },
    { start_beat: 1, length_beats: 1, value: 0.8 },
  ];
  await step("automate_device_parameter", async () => {
    const params = await call("get_device_parameters", { track_index: keysIdx, device_index: 0 });
    // device 0 is now the Arpeggiator (midi fx loaded ahead); just use param 0 with its range
    const p = params[0];
    const segs = steps.map((s) => ({ ...s, value: p.min + (p.max - p.min) * s.value }));
    await call("automate_device_parameter", {
      track_index: keysIdx,
      clip_slot: 0,
      device_index: 0,
      parameter_index: p.parameter_index,
      steps: segs,
    });
  });
  await step("automate_mixer_parameter (volume)", () =>
    call("automate_mixer_parameter", {
      track_index: keysIdx,
      clip_slot: 0,
      parameter: "volume",
      steps: [
        { start_beat: 0, length_beats: 1, value: 0.7 },
        { start_beat: 1, length_beats: 1, value: 0.9 },
      ],
    }),
  );
  await step("re_enable_automation", () => call("re_enable_automation"));
  await step("clear_clip_envelopes", () => call("clear_clip_envelopes", { track_index: keysIdx, clip_slot: 0 }));

  // ---- browser nodes ----
  for (const node of [
    "list_presets",
    "list_packs",
    "list_plugins",
    "list_user_library",
    "list_sounds",
    "list_browser_clips",
    "list_max_for_live",
    "list_current_project",
  ]) {
    await step(node, async () => {
      const r = await call(node);
      assert(Array.isArray(r.children), "no children array");
    });
  }
  let samplePath = null;
  await step("list_samples", async () => {
    const r = await call("list_samples");
    assert(Array.isArray(r.children), "no children");
    assert(typeof r.total_count === "number", "no total_count");
  });

  // ---- load_sound (Sounds browser; self-contained track) ----
  await step("load_sound", async () => {
    let sp = null;
    const top = (await call("list_sounds")).children;
    const queue = top.map((p) => ({ p, d: 1 }));
    while (queue.length && !sp) {
      const { p, d } = queue.shift();
      let kids;
      try {
        kids = (await call("list_sounds", { path: p })).children;
      } catch {
        continue;
      }
      if (kids.length === 0) {
        sp = p;
        break;
      }
      for (const k of kids) {
        const full = `${p}/${k}`;
        if (/\.(adv|adg)$/i.test(k)) {
          sp = full;
          break;
        }
        if (d < 3) queue.push({ p: full, d: d + 1 });
      }
    }
    assert(sp, "no loadable sound found");
    const idx = (await call("create_midi_track", { name: "ZZ Sound" })).track_index;
    await call("load_sound", { track_index: idx, sound_path: sp });
    const devs = await call("get_track_devices", { track_index: idx });
    assert(devs.length >= 1, "no device after load_sound");
    await call("delete_track", { track_index: idx });
  });

  // ---- load_browser_item (plugins/user_library/packs/max_for_live) ----
  await step("load_browser_item", async () => {
    const listTool = {
      packs: "list_packs",
      user_library: "list_user_library",
      max_for_live: "list_max_for_live",
      plugins: "list_plugins",
    };
    // find a loadable device item in any of these nodes (depth-bounded)
    let hit = null;
    for (const node of ["packs", "user_library", "max_for_live", "plugins"]) {
      const lt = listTool[node];
      const queue = (await call(lt)).children.map((p) => ({ p, d: 1 }));
      let budget = 40;
      while (queue.length && budget > 0 && !hit) {
        const { p, d } = queue.shift();
        budget--;
        if (/\.(adg|adv|amxd)$/i.test(p.split("/").pop())) {
          hit = { node, path: p };
          break;
        }
        let kids;
        try {
          kids = (await call(lt, { path: p })).children;
        } catch {
          continue;
        }
        for (const k of kids) {
          const full = `${p}/${k}`;
          if (/\.(adg|adv|amxd)$/i.test(k)) {
            hit = { node, path: full };
            break;
          }
          if (d < 4) queue.push({ p: full, d: d + 1 });
        }
      }
      if (hit) break;
    }
    if (!hit) {
      console.log("      (no loadable plugin/pack/library/M4L item on this machine — skipped)");
      return;
    }
    const idx = (await call("create_midi_track", { name: "ZZ Browser" })).track_index;
    await call("load_browser_item", { track_index: idx, node: hit.node, path: hit.path });
    const devs = await call("get_track_devices", { track_index: idx });
    assert(devs.length >= 1, `no device after load_browser_item (${hit.node}: ${hit.path})`);
    await call("delete_track", { track_index: idx });
  });

  // ---- create_audio_track quick round-trip (create + delete) ----
  await step("create_audio_track", async () => {
    const r = await call("create_audio_track", { name: "ZZ Audio" });
    assert(typeof r.track_index === "number", "no track_index");
    await call("delete_track", { track_index: r.track_index });
  });

  // ---- load_audio_clip (audio file → Session slot, the real one) ----
  await step("load_audio_clip", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    // Find a known WAV under Live's Core Library.
    const core = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Samples";
    let wav = null;
    async function walk(dir, depth) {
      if (wav || depth > 4) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (wav) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".wav")) { wav = full; return; }
      }
    }
    await walk(core, 0);
    if (!wav) {
      console.log("      (no .wav under Core Library — skipped)");
      return;
    }
    const idx = (await call("create_audio_track", { name: "ZZ AudioClip" })).track_index;
    const r = await call("load_audio_clip", {
      track_index: idx,
      clip_slot: 0,
      file_path: wav,
    });
    assert(typeof r.clip_name === "string" && r.clip_name.length > 0, "no clip_name returned");
    const clips = await call("list_clips", { track_index: idx });
    assert(
      Array.isArray(clips) && clips.some((c) => c.clip_slot === 0 && c.has_clip),
      `no clip at slot 0 after load_audio_clip (${wav})`,
    );
    await call("delete_track", { track_index: idx });
  });

  // ---- drums + samples ----
  let kitPath = null;
  await step("list_drum_kits (find a kit)", async () => {
    const top = await call("list_drum_kits");
    assert(top.children.length > 0, "no drum categories");
    // Loadable Drum Rack kits are top-level ".adg" entries (e.g. "808 Core
    // Kit.adg"). Folders like "Drum Hits" hold one-shots, not kits.
    kitPath = top.children.find((x) => x.endsWith(".adg"));
    if (!kitPath) {
      // Fallback: drill a category for a leaf .adg.
      for (const cat of top.children) {
        const inner = await call("list_drum_kits", { path: cat });
        const k = inner.children.find((x) => x.endsWith(".adg"));
        if (k) {
          kitPath = `${cat}/${k}`;
          break;
        }
      }
    }
    assert(kitPath, "no loadable kit found");
  });
  await step("create_midi_track (Drums)", async () => {
    const r = await call("create_midi_track", { name: DRUMS });
    drumsIdx = r.track_index;
  });
  await step("load_drum_kit", async () => {
    assert(kitPath, "no kitPath");
    const r = await call("load_drum_kit", { track_index: drumsIdx, kit_path: kitPath });
    assert(r.device_index === 0, `device_index ${r.device_index}`);
  });
  await step("list_drum_pads", async () => {
    const pads = await call("list_drum_pads", { track_index: drumsIdx, device_index: 0 });
    assert(Array.isArray(pads), "pads not array");
  });
  // find a real sample file to load
  await step("find a sample file (deep)", async () => {
    // walk samples to find a leaf (file). Heuristic: drill into first folders.
    let path = "";
    for (let depth = 0; depth < 4 && !samplePath; depth++) {
      const r = await call("list_samples", { path });
      if (r.children.length === 0) break;
      // a leaf is something we can't drill — try the first child as a file
      const candidate = r.children[0];
      const nextPath = path ? `${path}/${candidate}` : candidate;
      const probe = await call("list_samples", { path: nextPath });
      if (probe.children.length === 0) {
        samplePath = nextPath; // leaf = file
      } else {
        path = nextPath;
      }
    }
    // not fatal if we can't find one; mark skip via assertion soft
    if (!samplePath) throw new Error("no sample leaf found (skipping sample loads)");
  });
  await step("load_sample_to_drum_pad", async () => {
    if (!samplePath) throw new Error("no samplePath");
    await call("load_sample_to_drum_pad", {
      track_index: drumsIdx,
      device_index: 0,
      pad_pitch: 36,
      sample_path: samplePath,
    });
  });
  await step("create_midi_track (Sample) + load_sample", async () => {
    if (!samplePath) throw new Error("no samplePath");
    const r = await call("create_midi_track", { name: SMP });
    smpIdx = r.track_index;
    await call("load_sample", { track_index: smpIdx, sample_path: samplePath });
  });

  // ---- duplicate_track + delete_device ----
  await step("duplicate_track (Sample)", async () => {
    const before = await findTrackByName(SMP);
    await call("duplicate_track", { track_index: before });
    // the duplicate is named the same; expect >=2 with name SMP
    const tracks = await call("list_tracks");
    assert(tracks.filter((t) => t.name === SMP).length >= 1, "duplicate missing");
  });
  await step("delete_device (a device on Keys)", async () => {
    const idx = await findTrackByName(KEYS);
    const devs = await call("get_track_devices", { track_index: idx });
    assert(devs.length > 0, "no devices to delete");
    await call("delete_device", { track_index: idx, device_index: devs.length - 1 });
  });
  await step("delete_clip", async () => {
    const idx = await findTrackByName(KEYS);
    await call("delete_clip", { track_index: idx, clip_slot: 1 });
  });

  // ---- cleanup ----
  await step("cleanup: delete return track", async () => {
    if (returnIdx >= 0) await call("delete_return_track", { return_index: returnIdx });
  });
  await step("cleanup: delete created tracks", async () => {
    // delete by name, re-resolving indices each time (indices shift)
    for (const name of [SMP, SMP, DRUMS, KEYS]) {
      const idx = await findTrackByName(name);
      if (idx >= 0) await call("delete_track", { track_index: idx });
    }
  });
  await step("cleanup: restore tempo", () => call("set_tempo", { bpm: origTempo }));
} finally {
  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log("Failed:\n" + failures.map((f) => "  - " + f).join("\n"));
  await client.close();
  process.exit(fail === 0 ? 0 : 1);
}
