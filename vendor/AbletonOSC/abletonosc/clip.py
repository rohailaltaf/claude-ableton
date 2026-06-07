import re
from typing import Tuple, Callable, Any, Optional
from .handler import AbletonOSCHandler
import Live

def note_name_to_midi(name):
    """ Maps a MIDI note name (D3, C#6) to a value.
    Assumes that middle C is C4. """
    note_names = [["C"],
                  ["C#", "Db"],
                  ["D"],
                  ["D#", "Eb"],
                  ["E"],
                  ["F"],
                  ["F#", "Gb"],
                  ["G"],
                  ["G#", "Ab"],
                  ["A"],
                  ["A#", "Bb"],
                  ["B"]]

    for index, names in enumerate(note_names):
        if name in names:
            return index
    return None

class ClipHandler(AbletonOSCHandler):
    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "clip"
        self._clip_notes_cache = []

    def init_api(self):
        def create_clip_callback(func, *args, pass_clip_index=False):
            """
            Creates a callback that expects the following set of arguments:
              (track_index, clip_index, *args)

            The callback then extracts the relevant `Clip` object from the current Song,
            and calls `func` with this `Clip` object plus any additional *args.

            pass_clip_index is a bit of an ugly hack, although seems like the lesser of
            evils for scenarios where the track/clip index is needed (as a clip is unable
            to query its own index). Other alternatives include _always_ passing track/clip
            index to the callback, but this adds arg clutter to every single callback.
            """

            def clip_callback(params: Tuple[Any]) -> Tuple:
                #--------------------------------------------------------------------------------
                # Cast to int to support clients such as TouchOSC that, by default, pass all
                # numeric arguments as float.
                #--------------------------------------------------------------------------------
                track_index, clip_index = int(params[0]), int(params[1])
                track = self.song.tracks[track_index]
                clip = track.clip_slots[clip_index].clip
                if pass_clip_index:
                    rv = func(clip, *args, tuple(params[0:]))
                else:
                    rv = func(clip, *args, tuple(params[2:]))

                if rv is not None:
                    return (track_index, clip_index, *rv)

            return clip_callback

        methods = [
            "fire",
            "stop",
            "duplicate_loop", 
            "remove_notes_by_id"
        ]
        properties_r = [
            "end_time",
            "file_path",
            "gain_display_string",
            "has_groove",
            "is_midi_clip",
            "is_audio_clip",
            "is_overdubbing",
            "is_playing",
            "is_recording",
            "is_triggered",
            "length",
            "playing_position",
            "sample_length",
            "start_time",
            "will_record_on_start"
            ## TODO list:
            ##"groove", ## if other than None, says "Error handling OSC message: Infered arg_value type is not supported"
            ## is_arrangement_clip            
            ##"warp_markers", ## "Infered arg_value type is not supported"
            ##"view", ##"Infered arg_value type is not supported"
        ]
        properties_rw = [
            "color",
            "color_index",
            "end_marker",
            "gain",
            "launch_mode",
            "launch_quantization",
            "legato",
            "loop_end",
            "loop_start",
            "looping",
            "muted",
            "name",
            "pitch_coarse",
            "pitch_fine",
            "position",
            "ram_mode",
            "signature_denominator",
            "signature_numerator",
            "start_marker",
            "velocity_amount",
            "warp_mode",
            "warping",
        ]

        for method in methods:
            self.osc_server.add_handler("/live/clip/%s" % method,
                                        create_clip_callback(self._call_method, method))

        for prop in properties_r + properties_rw:
            self.osc_server.add_handler("/live/clip/get/%s" % prop,
                                        create_clip_callback(self._get_property, prop))
            self.osc_server.add_handler("/live/clip/start_listen/%s" % prop,
                                        create_clip_callback(self._start_listen, prop, pass_clip_index=True))
            self.osc_server.add_handler("/live/clip/stop_listen/%s" % prop,
                                        create_clip_callback(self._stop_listen, prop, pass_clip_index=True))
        for prop in properties_rw:
            self.osc_server.add_handler("/live/clip/set/%s" % prop,
                                        create_clip_callback(self._set_property, prop))

        #--------------------------------------------------------------------------------
        # Clip: quantize timing to a grid.
        # `Clip.quantize(grid, amount)` snaps note starts toward `grid` by `amount`
        # (0.0 = no change, 1.0 = full snap). `grid` is a Live.Song.Quantization
        # enum int (e.g. 7 = 1/4, 9 = 1/8, 11 = 1/16). Amount < 1.0 keeps some of
        # the original feel / swing.
        #--------------------------------------------------------------------------------
        def clip_quantize(clip, params: Tuple[Any]):
            grid = int(params[0])
            amount = float(params[1])
            clip.quantize(grid, amount)

        self.osc_server.add_handler("/live/clip/quantize",
                                    create_clip_callback(clip_quantize))

        def clip_get_notes(clip, params: Tuple[Any] = ()):
            if len(params) == 4:
                pitch_start, pitch_span, time_start, time_span = params
            elif len(params) == 0:
                pitch_start, pitch_span, time_start, time_span = 0, 127, -8192, 16384
            else:
                raise ValueError("Invalid number of arguments for /clip/get/notes. Either 0 or 4 arguments must be passed.")
            notes = clip.get_notes_extended(pitch_start, pitch_span, time_start, time_span)
            all_note_attributes = []
            for note in notes:
                all_note_attributes += [note.pitch, note.start_time, note.duration, note.velocity, note.mute]
            return tuple(all_note_attributes)

        def clip_add_notes(clip, params: Tuple[Any] = ()):
            notes = []
            for offset in range(0, len(params), 5):
                pitch, start_time, duration, velocity, mute = params[offset:offset + 5]
                note = Live.Clip.MidiNoteSpecification(start_time=start_time,
                                                       duration=duration,
                                                       pitch=pitch,
                                                       velocity=velocity,
                                                       mute=mute)
                notes.append(note)
            clip.add_new_notes(tuple(notes))

        def clip_remove_notes(clip, params: Tuple[Any] = ()):
            if len(params) == 4:
                pitch_start, pitch_span, time_start, time_span = params
            elif len(params) == 0:
                pitch_start, pitch_span, time_start, time_span = 0, 127, -8192, 16384
            else:
                raise ValueError("Invalid number of arguments for /clip/remove/notes. Either 0 or 4 arguments must be passed.")
            clip.remove_notes_extended(pitch_start, pitch_span, time_start, time_span)

        # ---- Extended note API (Live 11+): note_id + per-note probability,
        # velocity_deviation, release_velocity. 9 fields/note. ----
        def clip_get_notes_extended(clip, params: Tuple[Any] = ()):
            if len(params) == 4:
                pitch_start, pitch_span, time_start, time_span = params
            elif len(params) == 0:
                pitch_start, pitch_span, time_start, time_span = 0, 127, -8192, 16384
            else:
                raise ValueError("Invalid number of arguments for /clip/get/notes_extended. Either 0 or 4 arguments must be passed.")
            notes = clip.get_notes_extended(pitch_start, pitch_span, time_start, time_span)
            attrs = []
            for note in notes:
                attrs += [note.note_id, note.pitch, note.start_time, note.duration,
                          note.velocity, note.mute, note.probability,
                          note.velocity_deviation, note.release_velocity]
            return tuple(attrs)

        def clip_add_notes_extended(clip, params: Tuple[Any] = ()):
            # 8 fields/note: pitch, start, duration, velocity, mute, probability,
            # velocity_deviation, release_velocity
            notes = []
            for o in range(0, len(params), 8):
                pitch, start_time, duration, velocity, mute, probability, vdev, relvel = params[o:o + 8]
                notes.append(Live.Clip.MidiNoteSpecification(
                    pitch=int(pitch), start_time=start_time, duration=duration,
                    velocity=velocity, mute=bool(mute), probability=probability,
                    velocity_deviation=vdev, release_velocity=relvel))
            clip.add_new_notes(tuple(notes))

        def clip_apply_note_modifications(clip, params: Tuple[Any] = ()):
            # 9 fields/note: note_id, pitch, start, duration, velocity, mute,
            # probability, velocity_deviation, release_velocity. Matches existing
            # notes by note_id and overwrites their full state.
            mods = {}
            for o in range(0, len(params), 9):
                note_id, pitch, start_time, duration, velocity, mute, probability, vdev, relvel = params[o:o + 9]
                mods[int(note_id)] = (int(pitch), start_time, duration, velocity,
                                      bool(mute), probability, vdev, relvel)
            if not mods:
                return
            notes = clip.get_notes_extended(0, 127, -8192, 16384)
            for note in notes:
                m = mods.get(note.note_id)
                if m is None:
                    continue
                (note.pitch, note.start_time, note.duration, note.velocity,
                 note.mute, note.probability, note.velocity_deviation,
                 note.release_velocity) = m
            clip.apply_note_modifications(notes)

        self.osc_server.add_handler("/live/clip/get/notes", create_clip_callback(clip_get_notes))
        self.osc_server.add_handler("/live/clip/add/notes", create_clip_callback(clip_add_notes))
        self.osc_server.add_handler("/live/clip/remove/notes", create_clip_callback(clip_remove_notes))
        self.osc_server.add_handler("/live/clip/get/notes_extended", create_clip_callback(clip_get_notes_extended))
        self.osc_server.add_handler("/live/clip/add/notes_extended", create_clip_callback(clip_add_notes_extended))
        self.osc_server.add_handler("/live/clip/apply_note_modifications", create_clip_callback(clip_apply_note_modifications))

        def clips_filter_handler(params: Tuple):
            # TODO: Pre-cache clip notes
            if len(self._clip_notes_cache) == 0:
                self.logger.warning("Building clip notes cache...")
                self._build_clip_name_cache()
            else:
                self.logger.warning("Found existing clip notes cache (len = %d)" % len(self._clip_notes_cache))
            note_indices = [note_name_to_midi(name) for name in params]

            self.logger.warning("Got note indices: %s" % note_indices)
            for track_index, track in enumerate(self.song.tracks):
                for clip_slot_index, clip_slot in enumerate(track.clip_slots):
                    clip_notes_list = self._clip_notes_cache[track_index][clip_slot_index]
                    if clip_notes_list:
                        clip = clip_slot.clip
                        if all(note in note_indices for note in clip_notes_list):
                            clip.muted = False
                        else:
                            clip.muted = True

        self.osc_server.add_handler("/live/clips/filter", clips_filter_handler)

        def clips_unfilter_handler(params: Tuple):
            track_start = params[0] if len(params) > 0 else 0
            track_end = params[1] if len(params) > 1 else len(self.song.tracks)

            self.logger.info("Unfiltering tracks: %d .. %d" % (track_start, track_end))
            for track in self.song.tracks[track_start:track_end]:
                for clip_slot in track.clip_slots:
                    if clip_slot.has_clip:
                        clip = clip_slot.clip
                        clip.muted = False

        self.osc_server.add_handler("/live/clips/unfilter", clips_unfilter_handler)

        #--------------------------------------------------------------------------------
        # Clip automation envelopes — write step-style automation per clip
        # for any device parameter or mixer parameter. Live's
        # Live.Automation.AutomationEnvelope public API only supports steps
        # (no native breakpoints), so callers approximate ramps by writing
        # many small adjacent steps.
        #--------------------------------------------------------------------------------
        def _clip_at(track_id, clip_id):
            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "automation: track %d does not exist" % track_id
                )
                return None
            try:
                slot = track.clip_slots[clip_id]
            except IndexError:
                self.logger.warning(
                    "automation: clip slot %d does not exist on track %d"
                    % (clip_id, track_id)
                )
                return None
            if slot.clip is None:
                self.logger.warning(
                    "automation: no clip in slot (%d, %d)" % (track_id, clip_id)
                )
                return None
            return slot.clip

        def _get_or_create_envelope(clip, parameter):
            """`clip.automation_envelope(parameter)` returns None when no
            envelope exists for the parameter yet. `create_automation_envelope`
            creates one. Try both so first-time writes Just Work."""
            envelope = clip.automation_envelope(parameter)
            if envelope is None and hasattr(clip, "create_automation_envelope"):
                envelope = clip.create_automation_envelope(parameter)
            return envelope

        def _apply_steps(envelope, steps_flat):
            # steps_flat is a flat sequence (time, length, value, ...)
            for i in range(0, len(steps_flat) - 2, 3):
                time = float(steps_flat[i])
                length = float(steps_flat[i + 1])
                value = float(steps_flat[i + 2])
                envelope.insert_step(time, length, value)

        def _re_enable(parameter):
            """If Live marked the parameter as 'automation disabled' (orange
            dot), nothing we write into the envelope takes effect until the
            user clicks Re-Enable Automation in the UI or we call it here."""
            if hasattr(parameter, "re_enable_automation"):
                parameter.re_enable_automation()

        def clip_automate_device_parameter(params):
            track_id = int(params[0])
            clip_id = int(params[1])
            device_id = int(params[2])
            param_idx = int(params[3])
            steps_flat = params[4:]

            clip = _clip_at(track_id, clip_id)
            if clip is None:
                return
            try:
                parameter = self.song.tracks[track_id].devices[device_id].parameters[param_idx]
            except IndexError:
                self.logger.warning(
                    "automate_device_parameter: bad device/param indices "
                    "(%d, %d) on track %d" % (device_id, param_idx, track_id)
                )
                return
            envelope = _get_or_create_envelope(clip, parameter)
            if envelope is None:
                self.logger.warning(
                    "automate_device_parameter: could not get/create envelope "
                    "for track %d device %d param %d"
                    % (track_id, device_id, param_idx)
                )
                return
            _apply_steps(envelope, steps_flat)
            _re_enable(parameter)

        def clip_automate_mixer_parameter(params):
            track_id = int(params[0])
            clip_id = int(params[1])
            param_name = str(params[2])
            steps_flat = params[3:]

            clip = _clip_at(track_id, clip_id)
            if clip is None:
                return
            mixer = self.song.tracks[track_id].mixer_device
            if param_name == "volume":
                parameter = mixer.volume
            elif param_name == "panning":
                parameter = mixer.panning
            elif param_name.startswith("send_"):
                try:
                    send_idx = int(param_name.split("_", 1)[1])
                    parameter = mixer.sends[send_idx]
                except (IndexError, ValueError):
                    self.logger.warning(
                        "automate_mixer_parameter: bad send index in %r" % param_name
                    )
                    return
            else:
                self.logger.warning(
                    "automate_mixer_parameter: unknown name %r "
                    "(expected volume / panning / send_N)" % param_name
                )
                return
            envelope = _get_or_create_envelope(clip, parameter)
            if envelope is None:
                self.logger.warning(
                    "automate_mixer_parameter: could not get/create envelope "
                    "for track %d %s" % (track_id, param_name)
                )
                return
            _apply_steps(envelope, steps_flat)
            _re_enable(parameter)

        def clip_clear_envelopes(params):
            track_id = int(params[0])
            clip_id = int(params[1])
            clip = _clip_at(track_id, clip_id)
            if clip is None:
                return
            clip.clear_all_envelopes()

        self.osc_server.add_handler(
            "/live/clip/automate_device_parameter",
            clip_automate_device_parameter,
        )
        self.osc_server.add_handler(
            "/live/clip/automate_mixer_parameter",
            clip_automate_mixer_parameter,
        )
        self.osc_server.add_handler(
            "/live/clip/clear_envelopes",
            clip_clear_envelopes,
        )

    def _build_clip_name_cache(self):
        regex = "([_-])([A-G][A-G#b1-9-]*)$"
        for track_index, track in enumerate(self.song.tracks):
            self._clip_notes_cache.append([])
            for clip_slot_index, clip_slot in enumerate(track.clip_slots):
                self._clip_notes_cache[-1].append([])
                if clip_slot.has_clip:
                    clip = clip_slot.clip
                    clip_name = clip.name
                    match = re.search(regex, clip_name)
                    if match:
                        clip_notes_str = match.group(2)
                        clip_notes_str = re.sub("[1-9]", "", clip_notes_str)
                        clip_notes_list = clip_notes_str.split("-")
                        clip_notes_list = [note_name_to_midi(name) for name in clip_notes_list]
                        self._clip_notes_cache[-1][-1] = clip_notes_list
