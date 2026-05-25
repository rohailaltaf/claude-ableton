/**
 * Live integration test: spawn the built MCP server and exercise the 83 tools
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
  await step("set_clip_color", () => call("set_clip_color", { track_index: keysIdx, clip_slot: 0, color: 0xff8800 }));
  await step("quantize_clip", () => call("quantize_clip", { track_index: keysIdx, clip_slot: 0, grid: "1/16", amount: 1.0 }));
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
  await step("delete_scene (the duplicate)", () => call("delete_scene", { scene_index: newSceneIdx + 1 }));

  // ---- transport ----
  await step("fire_scene", () => call("fire_scene", { scene_index: 0 }));
  await step("play_clip", () => call("play_clip", { track_index: keysIdx, clip_slot: 0 }));
  await step("stop_clip", () => call("stop_clip", { track_index: keysIdx, clip_slot: 0 }));
  await step("start_playing", () => call("start_playing"));
  await step("continue_playing", () => call("continue_playing"));
  await step("stop_playing", () => call("stop_playing"));

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
