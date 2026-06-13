from typing import Tuple, Any

import Live

from .handler import AbletonOSCHandler


class MasterTrackHandler(AbletonOSCHandler):
    """OSC handlers for the Master (Main) track.

    `song.master_track` lives OUTSIDE `song.tracks`, so the regular
    track/device handlers can't address it. These endpoints expose the Main
    track for mastering: load audio effects (Glue Compressor, Limiter, EQ),
    read/set their parameters, and set the final output volume.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "master_track"

    def init_api(self):
        def _walk_audio_effects(path):
            app = Live.Application.get_application()
            node = app.browser.audio_effects
            for segment in path.split("/"):
                if not segment:
                    continue
                matched = None
                for child in node.children:
                    if child.name == segment:
                        matched = child
                        break
                if matched is None:
                    return None
                node = matched
            return node

        def master_load_audio_effect(params: Tuple[Any]):
            path = str(params[0]) if params else ""
            if not path:
                self.logger.warning("master_load_audio_effect: empty path")
                return
            node = _walk_audio_effects(path)
            if node is None or not node.is_loadable:
                self.logger.warning(
                    "master_load_audio_effect: path %r not found/loadable" % path
                )
                return
            app = Live.Application.get_application()
            self.song.view.selected_track = self.song.master_track
            app.browser.load_item(node)

        def master_load_browser_item(params: Tuple[Any]):
            """Load a device-producing item from an arbitrary browser node onto
            the Main track. Params: (node_name, path). node_name is an attribute
            of app.browser (plugins, user_library, packs, max_for_live) — the
            master equivalent of /live/track/load_browser_item, so third-party
            mastering plugins and saved racks can land on the Main track (the
            audio_effects-only master_load_audio_effect can't reach them)."""
            node_name = str(params[0])
            path = str(params[1])
            if not path:
                self.logger.warning("master_load_browser_item: empty path")
                return
            app = Live.Application.get_application()
            try:
                root = getattr(app.browser, node_name)
            except (AttributeError, RuntimeError):
                self.logger.warning(
                    "master_load_browser_item: no browser node %r" % node_name
                )
                return
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
                        "master_load_browser_item: no child %r under %r"
                        % (segment, node.name)
                    )
                    return
                node = matched
            if not node.is_loadable:
                self.logger.warning(
                    "master_load_browser_item: path %r is not loadable" % path
                )
                return
            self.song.view.selected_track = self.song.master_track
            app.browser.load_item(node)

        def master_delete_device(params: Tuple[Any]):
            """Delete a device from the Main track by index. master_track is a
            Track, so Track.delete_device works on it — the regular
            /live/track/delete_device can't address the master (it's outside
            song.tracks)."""
            device_index = int(params[0])
            master = self.song.master_track
            if device_index < 0 or device_index >= len(master.devices):
                self.logger.warning(
                    "master_delete_device: index %d out of range (0-%d)"
                    % (device_index, len(master.devices) - 1)
                )
                return
            master.delete_device(device_index)

        def master_get_num_devices(params: Tuple[Any] = ()):
            return (len(self.song.master_track.devices),)

        def master_get_device_names(params: Tuple[Any] = ()):
            return tuple(d.name for d in self.song.master_track.devices)

        def master_get_device_parameters(params: Tuple[Any]):
            # Reply: flat (name, value, min, max) per parameter for one device.
            device_index = int(params[0])
            device = self.song.master_track.devices[device_index]
            out = []
            for p in device.parameters:
                out += [p.name, p.value, p.min, p.max]
            return tuple(out)

        def master_set_device_parameter(params: Tuple[Any]):
            device_index = int(params[0])
            param_index = int(params[1])
            value = float(params[2])
            self.song.master_track.devices[device_index].parameters[param_index].value = value

        def master_get_volume(params: Tuple[Any] = ()):
            return (self.song.master_track.mixer_device.volume.value,)

        def master_set_volume(params: Tuple[Any]):
            self.song.master_track.mixer_device.volume.value = float(params[0])

        self.osc_server.add_handler("/live/master_track/load_audio_effect", master_load_audio_effect)
        self.osc_server.add_handler("/live/master_track/load_browser_item", master_load_browser_item)
        self.osc_server.add_handler("/live/master_track/delete_device", master_delete_device)
        self.osc_server.add_handler("/live/master_track/get/num_devices", master_get_num_devices)
        self.osc_server.add_handler("/live/master_track/get/devices/name", master_get_device_names)
        self.osc_server.add_handler("/live/master_track/get/device/parameters", master_get_device_parameters)
        self.osc_server.add_handler("/live/master_track/set/device/parameter", master_set_device_parameter)
        self.osc_server.add_handler("/live/master_track/get/volume", master_get_volume)
        self.osc_server.add_handler("/live/master_track/set/volume", master_set_volume)
