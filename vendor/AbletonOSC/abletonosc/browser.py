from typing import Tuple, Any

import Live

from .handler import AbletonOSCHandler


class BrowserHandler(AbletonOSCHandler):
    """OSC handlers for walking and loading from Live's browser.

    Exposes instruments (`app.browser.instruments`), drums
    (`app.browser.drums`), audio effects (`app.browser.audio_effects`),
    and samples (`app.browser.samples`). Audio effects can be loaded onto
    either regular tracks or return tracks. Samples are wrapped in Simpler
    automatically when loaded onto a MIDI track.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "browser"

    def init_api(self):
        def _walk(root, path: str):
            """Walk `root.children` by slash-separated `path`. Returns the
            terminal BrowserItem, or None if any segment misses."""
            node = root
            for segment in path.split("/"):
                if not segment:
                    continue
                matched = None
                for child in node.children:
                    if child.name == segment:
                        matched = child
                        break
                if matched is None:
                    self.logger.warning(
                        "browser walk: no child named %r under %r"
                        % (segment, node.name)
                    )
                    return None
                node = matched
            return node

        def list_instrument_presets(params: Tuple[Any]):
            path = str(params[0]) if params else ""
            app = Live.Application.get_application()
            node = _walk(app.browser.instruments, path) if path else app.browser.instruments
            if node is None:
                # Bad path — reply with just the path so callers can disambiguate
                # from "valid path, no children".
                self.osc_server.send(
                    "/live/browser/list_instrument_presets", (path,)
                )
                return
            names = tuple(child.name for child in node.children)
            self.osc_server.send(
                "/live/browser/list_instrument_presets", (path,) + names
            )

        def load_instrument_preset(params: Tuple[Any]):
            track_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_instrument_preset: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.instruments, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_instrument_preset: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_instrument_preset: track %d does not exist" % track_id
                )
                return

            self.song.view.selected_track = track
            app.browser.load_item(node)

        def load_sound(params: Tuple[Any]):
            """Load a preset from the Sounds browser (app.browser.sounds), the
            cross-device view organized by sound category (Bass, Keys, ...).
            Pairs with list_sounds. Loads onto the given track."""
            track_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_sound: empty path")
                return

            # Forgiving: list_sounds paths are relative to app.browser.sounds,
            # but agents sometimes prefix the node name — strip a leading
            # "Sounds/" if present.
            if path.lower().startswith("sounds/"):
                path = path[len("sounds/"):]

            app = Live.Application.get_application()
            node = _walk(app.browser.sounds, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_sound: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_sound: track %d does not exist" % track_id
                )
                return

            self.song.view.selected_track = track
            app.browser.load_item(node)

        def load_browser_item(params: Tuple[Any]):
            """Load a device-producing item from an arbitrary browser node onto
            a track. Params: (track_id, node_name, path). node_name is an
            attribute of app.browser (e.g. plugins, user_library, packs,
            max_for_live). Closes the gap where these nodes can be listed but
            had no loader."""
            track_id = int(params[0])
            node_name = str(params[1])
            path = str(params[2])
            if not path:
                self.logger.warning("load_browser_item: empty path")
                return

            app = Live.Application.get_application()
            try:
                root = getattr(app.browser, node_name)
            except (AttributeError, RuntimeError):
                self.logger.warning(
                    "load_browser_item: no browser node %r on this Live version"
                    % node_name
                )
                return
            node = _walk(root, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_browser_item: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_browser_item: track %d does not exist" % track_id
                )
                return

            self.song.view.selected_track = track
            app.browser.load_item(node)

        def load_audio_clip(params: Tuple[Any]):
            """Create an audio clip in a Session slot from an absolute file
            path. Wraps `Live.ClipSlot.create_audio_clip`, which accepts the
            path of an audio file (.wav/.aif/.aiff/.mp3/.flac/.ogg) and lands
            it in the slot as a real audio clip — the only programmatic path
            to put audio loops on the Session grid (Live's Clip API otherwise
            can't materialise an audio clip from a file).

            Params: (track_id, clip_slot_id, file_path).

            Live rejects the call if:
              * the path is not absolute → ValueError "Please provide an absolute path"
              * the path doesn't resolve to a decodable audio file → ValueError
                "The provided path does not appear to point to a valid audio file"
              * the target track is not an audio track → RuntimeError
                "Audio clips can only be created on audio tracks"
              * the slot is already occupied → RuntimeError
                "This clip slot already has a clip"

            We let those propagate as warnings; the MCP layer translates the
            slot-state preconditions into clean errors.
            """
            track_id = int(params[0])
            clip_slot_id = int(params[1])
            file_path = str(params[2])
            if not file_path:
                self.logger.warning("load_audio_clip: empty path")
                return
            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_audio_clip: track %d does not exist" % track_id
                )
                return
            try:
                slot = track.clip_slots[clip_slot_id]
            except IndexError:
                self.logger.warning(
                    "load_audio_clip: clip slot %d does not exist on track %d"
                    % (clip_slot_id, track_id)
                )
                return
            try:
                slot.create_audio_clip(file_path)
            except (RuntimeError, ValueError) as e:
                self.logger.warning(
                    "load_audio_clip: %s: %s" % (type(e).__name__, e)
                )

        # NOTE on app.browser.load_item: verified inert for clip-type browser items
        # (app.browser.clips). Five targeting strategies tried — highlighted_clip_slot,
        # selected_track+selected_scene, plus focus_view("Session"), plus hotswap_target,
        # plus schedule_message — all returned without filling the slot. load_item only
        # works for device-producing items. For audio-file → clip use load_audio_clip
        # (via ClipSlot.create_audio_clip) which is the supported LOM path.

        def list_drum_kits(params: Tuple[Any]):
            # Params: (path) or (path, offset). Offset paginates when a folder
            # has more kits than fit in one OSC packet — big packs like Drum
            # Machines have hundreds of kits, which overflow the UDP MTU and get
            # dropped (manifesting as intermittent query timeouts). Same
            # byte-cap + pagination as list_samples.
            # Reply shape: (path, offset, total_count, name1, name2, ...).
            path = str(params[0]) if len(params) >= 1 else ""
            offset = int(params[1]) if len(params) >= 2 else 0
            app = Live.Application.get_application()
            node = _walk(app.browser.drums, path) if path else app.browser.drums
            if node is None:
                self.osc_server.send("/live/browser/list_drum_kits", (path, offset, 0))
                return
            all_children = list(node.children)
            total = len(all_children)
            MAX_REPLY_BYTES = 7500
            names = []
            running = len(path.encode("utf-8")) + 64
            for child in all_children[offset:]:
                name = child.name
                nb = len(name.encode("utf-8")) + 8
                if running + nb > MAX_REPLY_BYTES:
                    break
                names.append(name)
                running += nb
            self.osc_server.send(
                "/live/browser/list_drum_kits", (path, offset, total) + tuple(names)
            )

        def load_drum_kit(params: Tuple[Any]):
            track_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_drum_kit: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.drums, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_drum_kit: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_drum_kit: track %d does not exist" % track_id
                )
                return

            self.song.view.selected_track = track
            app.browser.load_item(node)

        def list_audio_effects(params: Tuple[Any]):
            path = str(params[0]) if params else ""
            app = Live.Application.get_application()
            node = _walk(app.browser.audio_effects, path) if path else app.browser.audio_effects
            if node is None:
                self.osc_server.send(
                    "/live/browser/list_audio_effects", (path,)
                )
                return
            names = tuple(child.name for child in node.children)
            self.osc_server.send(
                "/live/browser/list_audio_effects", (path,) + names
            )

        def load_audio_effect(params: Tuple[Any]):
            track_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_audio_effect: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.audio_effects, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_audio_effect: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_audio_effect: track %d does not exist" % track_id
                )
                return

            self.song.view.selected_track = track
            app.browser.load_item(node)

        def load_audio_effect_on_return(params: Tuple[Any]):
            return_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_audio_effect_on_return: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.audio_effects, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_audio_effect_on_return: path %r is not loadable" % path
                )
                return

            try:
                return_track = self.song.return_tracks[return_id]
            except IndexError:
                self.logger.warning(
                    "load_audio_effect_on_return: return track %d does not exist"
                    % return_id
                )
                return

            self.song.view.selected_track = return_track
            app.browser.load_item(node)

        def list_midi_effects(params: Tuple[Any]):
            path = str(params[0]) if params else ""
            app = Live.Application.get_application()
            node = _walk(app.browser.midi_effects, path) if path else app.browser.midi_effects
            if node is None:
                self.osc_server.send(
                    "/live/browser/list_midi_effects", (path,)
                )
                return
            names = tuple(child.name for child in node.children)
            self.osc_server.send(
                "/live/browser/list_midi_effects", (path,) + names
            )

        def load_midi_effect(params: Tuple[Any]):
            track_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_midi_effect: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.midi_effects, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_midi_effect: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_midi_effect: track %d does not exist" % track_id
                )
                return

            self.song.view.selected_track = track
            app.browser.load_item(node)

        def list_samples(params: Tuple[Any]):
            # Params: (path) or (path, offset). Optional offset for pagination
            # when a folder has more children than fit in one OSC packet.
            path = str(params[0]) if len(params) >= 1 else ""
            offset = int(params[1]) if len(params) >= 2 else 0

            app = Live.Application.get_application()
            node = _walk(app.browser.samples, path) if path else app.browser.samples
            if node is None:
                # Bad path — reply with (path, offset, 0) so callers can
                # disambiguate from "valid path, no children".
                self.osc_server.send(
                    "/live/browser/list_samples", (path, offset, 0)
                )
                return

            all_children = list(node.children)
            total = len(all_children)

            # Cap the reply by accumulated byte size to stay under typical
            # OSC/UDP MTU (~9 KB on macOS). When truncated, callers can
            # re-request with offset = previous_offset + len(returned_names).
            MAX_REPLY_BYTES = 7500
            names = []
            # path string + (offset, total) ints + osc framing overhead
            running = len(path.encode("utf-8")) + 64
            for child in all_children[offset:]:
                name = child.name
                nb = len(name.encode("utf-8")) + 8
                if running + nb > MAX_REPLY_BYTES:
                    break
                names.append(name)
                running += nb

            # Reply shape: (path, offset, total_count, name1, name2, ...)
            self.osc_server.send(
                "/live/browser/list_samples",
                (path, offset, total) + tuple(names),
            )

        def load_sample(params: Tuple[Any]):
            track_id = int(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("load_sample: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.samples, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_sample: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_sample: track %d does not exist" % track_id
                )
                return

            # Loading a sample onto a track wraps it in a Simpler automatically.
            self.song.view.selected_track = track
            app.browser.load_item(node)

        self.osc_server.add_handler(
            "/live/browser/list_instrument_presets", list_instrument_presets
        )
        self.osc_server.add_handler(
            "/live/track/load_instrument_preset", load_instrument_preset
        )
        self.osc_server.add_handler(
            "/live/track/load_sound", load_sound
        )
        self.osc_server.add_handler(
            "/live/track/load_browser_item", load_browser_item
        )
        self.osc_server.add_handler(
            "/live/clip_slot/load_audio_clip", load_audio_clip
        )
        def load_sample_to_drum_pad(params: Tuple[Any]):
            """Load a sample into a specific Drum Rack pad on a track.

            Params: (track_id, device_id, pad_pitch, path) where pad_pitch
            is the MIDI note that triggers the pad (e.g. 36 = kick, 38 =
            snare in General-MIDI-style Drum Rack layouts).
            """
            track_id = int(params[0])
            device_id = int(params[1])
            pad_pitch = int(params[2])
            path = str(params[3])
            if not path:
                self.logger.warning("load_sample_to_drum_pad: empty path")
                return

            app = Live.Application.get_application()
            node = _walk(app.browser.samples, path)
            if node is None:
                return
            if not node.is_loadable:
                self.logger.warning(
                    "load_sample_to_drum_pad: path %r is not loadable" % path
                )
                return

            try:
                track = self.song.tracks[track_id]
            except IndexError:
                self.logger.warning(
                    "load_sample_to_drum_pad: track %d does not exist" % track_id
                )
                return

            try:
                device = track.devices[device_id]
            except IndexError:
                self.logger.warning(
                    "load_sample_to_drum_pad: device %d does not exist on track %d"
                    % (device_id, track_id)
                )
                return

            # Accessing .drum_pads on a non-Drum-Rack raises RuntimeError (not
            # AttributeError), which hasattr does NOT suppress — so guard the
            # access itself with try/except rather than a hasattr precheck.
            try:
                pad = device.drum_pads[pad_pitch]
            except (RuntimeError, AttributeError):
                self.logger.warning(
                    "load_sample_to_drum_pad: device %d on track %d is not a Drum Rack"
                    % (device_id, track_id)
                )
                return
            except (IndexError, KeyError):
                self.logger.warning(
                    "load_sample_to_drum_pad: no drum pad at MIDI pitch %d"
                    % pad_pitch
                )
                return

            # Selecting the pad as the active drop target, then load.
            self.song.view.selected_track = track
            device.view.selected_drum_pad = pad
            app.browser.load_item(node)

        self.osc_server.add_handler(
            "/live/browser/list_drum_kits", list_drum_kits
        )
        self.osc_server.add_handler(
            "/live/track/load_drum_kit", load_drum_kit
        )
        self.osc_server.add_handler(
            "/live/browser/list_audio_effects", list_audio_effects
        )
        self.osc_server.add_handler(
            "/live/track/load_audio_effect", load_audio_effect
        )
        self.osc_server.add_handler(
            "/live/return_track/load_audio_effect", load_audio_effect_on_return
        )
        self.osc_server.add_handler(
            "/live/browser/list_midi_effects", list_midi_effects
        )
        self.osc_server.add_handler(
            "/live/track/load_midi_effect", load_midi_effect
        )
        self.osc_server.add_handler(
            "/live/browser/list_samples", list_samples
        )
        self.osc_server.add_handler(
            "/live/track/load_sample", load_sample
        )
        self.osc_server.add_handler(
            "/live/track/load_sample_to_drum_pad", load_sample_to_drum_pad
        )

        #--------------------------------------------------------------------------------
        # Generic browser-node listing — exposes the remaining
        # Application.Browser nodes (packs, plugins, user_library, sounds,
        # clips, max_for_live, current_project, ...) with the same byte-cap +
        # pagination as list_samples. Reply: (path, offset, total, *names).
        # A node attribute that doesn't exist on this Live version raises
        # AttributeError/RuntimeError — caught, logged, and reported as empty so
        # callers degrade gracefully.
        #--------------------------------------------------------------------------------
        def _make_browser_node_lister(address, attr_name):
            def handler(params: Tuple[Any]):
                path = str(params[0]) if len(params) >= 1 else ""
                offset = int(params[1]) if len(params) >= 2 else 0
                app = Live.Application.get_application()
                try:
                    root = getattr(app.browser, attr_name)
                except (AttributeError, RuntimeError):
                    self.logger.warning(
                        "browser node %r not available on this Live version"
                        % attr_name
                    )
                    self.osc_server.send(address, (path, offset, 0))
                    return
                node = _walk(root, path) if path else root
                if node is None:
                    self.osc_server.send(address, (path, offset, 0))
                    return
                all_children = list(node.children)
                total = len(all_children)
                MAX_REPLY_BYTES = 7500
                names = []
                running = len(path.encode("utf-8")) + 64
                for child in all_children[offset:]:
                    nm = child.name
                    nb = len(nm.encode("utf-8")) + 8
                    if running + nb > MAX_REPLY_BYTES:
                        break
                    names.append(nm)
                    running += nb
                self.osc_server.send(address, (path, offset, total) + tuple(names))
            self.osc_server.add_handler(address, handler)

        # grooves and templates are NOT exposed as Application.Browser nodes in
        # Live 12 (verified by probe) — grooves live in song.groove_pool, and
        # there's no browsable templates node — so they're omitted here.
        for _addr, _attr in [
            ("/live/browser/list_packs", "packs"),
            ("/live/browser/list_plugins", "plugins"),
            ("/live/browser/list_user_library", "user_library"),
            ("/live/browser/list_sounds", "sounds"),
            ("/live/browser/list_clips", "clips"),
            ("/live/browser/list_max_for_live", "max_for_live"),
            ("/live/browser/list_current_project", "current_project"),
        ]:
            _make_browser_node_lister(_addr, _attr)
