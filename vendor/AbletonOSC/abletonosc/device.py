from typing import Tuple, Any
from .handler import AbletonOSCHandler

class DeviceHandler(AbletonOSCHandler):
    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "device"

    def init_api(self):
        def create_device_callback(func, *args, include_ids: bool = False):
            def device_callback(params: Tuple[Any]):
                track_index, device_index = int(params[0]), int(params[1])
                device = self.song.tracks[track_index].devices[device_index]
                if (include_ids):
                    rv = func(device, *args, params[0:])
                else:
                    rv = func(device, *args, params[2:])

                if rv is not None:
                    return (track_index, device_index, *rv)

            return device_callback

        methods = [
        ]
        properties_r = [
            "class_name",
            "name",
            "type"
        ]
        properties_rw = [
        ]

        for method in methods:
            self.osc_server.add_handler("/live/device/%s" % method,
                                        create_device_callback(self._call_method, method))

        for prop in properties_r + properties_rw:
            self.osc_server.add_handler("/live/device/get/%s" % prop,
                                        create_device_callback(self._get_property, prop))
            self.osc_server.add_handler("/live/device/start_listen/%s" % prop,
                                        create_device_callback(self._start_listen, prop))
            self.osc_server.add_handler("/live/device/stop_listen/%s" % prop,
                                        create_device_callback(self._stop_listen, prop))
        for prop in properties_rw:
            self.osc_server.add_handler("/live/device/set/%s" % prop,
                                        create_device_callback(self._set_property, prop))

        #--------------------------------------------------------------------------------
        # Device: Get/set parameter lists
        #--------------------------------------------------------------------------------
        def device_get_num_parameters(device, params: Tuple[Any] = ()):
            return len(device.parameters),

        def device_get_parameters_name(device, params: Tuple[Any] = ()):
            return tuple(parameter.name for parameter in device.parameters)

        def device_get_parameters_value(device, params: Tuple[Any] = ()):
            return tuple(parameter.value for parameter in device.parameters)

        def device_get_parameters_min(device, params: Tuple[Any] = ()):
            return tuple(parameter.min for parameter in device.parameters)

        def device_get_parameters_max(device, params: Tuple[Any] = ()):
            return tuple(parameter.max for parameter in device.parameters)

        def device_get_parameters_is_quantized(device, params: Tuple[Any] = ()):
            return tuple(parameter.is_quantized for parameter in device.parameters)

        def device_set_parameters_value(device, params: Tuple[Any] = ()):
            for index, value in enumerate(params):
                device.parameters[index].value = value

        self.osc_server.add_handler("/live/device/get/num_parameters", create_device_callback(device_get_num_parameters))
        self.osc_server.add_handler("/live/device/get/parameters/name", create_device_callback(device_get_parameters_name))
        self.osc_server.add_handler("/live/device/get/parameters/value", create_device_callback(device_get_parameters_value))
        self.osc_server.add_handler("/live/device/get/parameters/min", create_device_callback(device_get_parameters_min))
        self.osc_server.add_handler("/live/device/get/parameters/max", create_device_callback(device_get_parameters_max))
        self.osc_server.add_handler("/live/device/get/parameters/is_quantized", create_device_callback(device_get_parameters_is_quantized))
        self.osc_server.add_handler("/live/device/set/parameters/value", create_device_callback(device_set_parameters_value))

        #--------------------------------------------------------------------------------
        # Device: Get/set individual parameters
        #--------------------------------------------------------------------------------
        def device_get_parameter_value(device, params: Tuple[Any] = ()):
            # Cast to ints so that we can tolerate floats from interfaces such as TouchOSC
            # that send floats by default.
            # https://github.com/ideoforms/AbletonOSC/issues/33
            param_index = int(params[0])
            return param_index, device.parameters[param_index].value
        
        # Uses str_for_value method to return the UI-friendly version of a parameter value (ex: "2500 Hz")
        def device_get_parameter_value_string(device, params: Tuple[Any] = ()):
            param_index = int(params[0])
            return param_index, device.parameters[param_index].str_for_value(device.parameters[param_index].value)
        
        def device_get_parameter_value_listener(device, params: Tuple[Any] = ()):

            def property_changed_callback():
                value = device.parameters[params[2]].value
                self.logger.info("Property %s changed of %s %s: %s" % ('value', 'device parameter', str(params), value))
                self.osc_server.send("/live/device/get/parameter/value", (*params, value,))

                value_string = device.parameters[params[2]].str_for_value(device.parameters[params[2]].value)
                self.logger.info("Property %s changed of %s %s: %s" % ('value_string', 'device parameter', str(params), value_string))
                self.osc_server.send("/live/device/get/parameter/value_string", (*params, value_string,))

            listener_key = ('device_parameter_value', tuple(params))
            if listener_key in self.listener_functions:
               device_get_parameter_remove_value_listener(device, params)

            self.logger.info("Adding listener for %s %s, property: %s" % ('device parameter', str(params), 'value'))
            device.parameters[params[2]].add_value_listener(property_changed_callback)
            self.listener_functions[listener_key] = property_changed_callback

            property_changed_callback()

        def device_get_parameter_remove_value_listener(device, params: Tuple[Any] = ()):
            listener_key = ('device_parameter_value', tuple(params))
            if listener_key in self.listener_functions:
                self.logger.info("Removing listener for %s %s, property %s" % (self.class_identifier, str(params), 'value'))
                listener_function = self.listener_functions[listener_key]
                device.parameters[params[2]].remove_value_listener(listener_function)
                del self.listener_functions[listener_key]
            else:
                self.logger.warning("No listener function found for property: %s (%s)" % (prop, str(params)))

        def device_set_parameter_value(device, params: Tuple[Any] = ()):
            param_index, param_value = params[:2]
            param_index = int(param_index)
            device.parameters[param_index].value = param_value

        def device_get_parameter_name(device, params: Tuple[Any] = ()):
            param_index = int(params[0])
            return param_index, device.parameters[param_index].name

        def device_get_parameter_value_items(device, params: Tuple[Any] = ()):
            # For a quantized parameter, the string label of each step (e.g. a
            # filter type's ['Lowpass','Highpass',...]). Reply: (param_index,
            # *labels). Non-quantized params have no items (accessing raises),
            # so we guard and return just the index.
            param_index = int(params[0])
            p = device.parameters[param_index]
            if not p.is_quantized:
                return (param_index,)
            return (param_index, *[str(it) for it in p.value_items])

        self.osc_server.add_handler("/live/device/get/parameter/value_items", create_device_callback(device_get_parameter_value_items))
        self.osc_server.add_handler("/live/device/get/parameter/value", create_device_callback(device_get_parameter_value))
        self.osc_server.add_handler("/live/device/get/parameter/value_string", create_device_callback(device_get_parameter_value_string))
        self.osc_server.add_handler("/live/device/set/parameter/value", create_device_callback(device_set_parameter_value))
        self.osc_server.add_handler("/live/device/get/parameter/name", create_device_callback(device_get_parameter_name))
        self.osc_server.add_handler("/live/device/start_listen/parameter/value", create_device_callback(device_get_parameter_value_listener, include_ids = True))
        self.osc_server.add_handler("/live/device/stop_listen/parameter/value", create_device_callback(device_get_parameter_remove_value_listener, include_ids = True))

        #--------------------------------------------------------------------------------
        # Device: input routing (sidechain source for Compressor / Gate / Vocoder / etc.)
        #
        # Not all devices support input routing — only those that can receive a
        # sidechain or external input signal. For devices that don't, the getters
        # return an empty tuple and the setter logs a warning.
        #
        # The available routing types are track names (e.g. "Kick", "Drums"), plus
        # "No Input" and any external inputs configured in Live's preferences.
        # The routing channel is the tap point: "Pre FX" / "Post FX" / "Post Mixer".
        #--------------------------------------------------------------------------------
        def device_get_available_input_routing_types(device, params: Tuple[Any] = ()):
            try:
                return tuple(rt.display_name for rt in device.available_input_routing_types)
            except AttributeError:
                return ()

        def device_get_available_input_routing_channels(device, params: Tuple[Any] = ()):
            try:
                return tuple(rc.display_name for rc in device.available_input_routing_channels)
            except AttributeError:
                return ()

        def device_get_input_routing_type(device, params: Tuple[Any] = ()):
            try:
                return (device.input_routing_type.display_name,)
            except AttributeError:
                return ("",)

        def device_get_input_routing_channel(device, params: Tuple[Any] = ()):
            try:
                return (device.input_routing_channel.display_name,)
            except AttributeError:
                return ("",)

        def device_set_input_routing_type(device, params: Tuple[Any] = ()):
            type_name = str(params[0])
            try:
                for rt in device.available_input_routing_types:
                    if rt.display_name == type_name:
                        device.input_routing_type = rt
                        return
                self.logger.warning(
                    "device set_input_routing_type: no routing type named %r" % type_name
                )
            except AttributeError:
                self.logger.warning(
                    "device set_input_routing_type: device does not support input routing"
                )

        def device_set_input_routing_channel(device, params: Tuple[Any] = ()):
            channel_name = str(params[0])
            try:
                for rc in device.available_input_routing_channels:
                    if rc.display_name == channel_name:
                        device.input_routing_channel = rc
                        return
                self.logger.warning(
                    "device set_input_routing_channel: no channel named %r" % channel_name
                )
            except AttributeError:
                self.logger.warning(
                    "device set_input_routing_channel: device does not support input routing"
                )

        self.osc_server.add_handler(
            "/live/device/get/available_input_routing_types",
            create_device_callback(device_get_available_input_routing_types),
        )
        self.osc_server.add_handler(
            "/live/device/get/available_input_routing_channels",
            create_device_callback(device_get_available_input_routing_channels),
        )
        self.osc_server.add_handler(
            "/live/device/get/input_routing_type",
            create_device_callback(device_get_input_routing_type),
        )
        self.osc_server.add_handler(
            "/live/device/get/input_routing_channel",
            create_device_callback(device_get_input_routing_channel),
        )
        self.osc_server.add_handler(
            "/live/device/set/input_routing_type",
            create_device_callback(device_set_input_routing_type),
        )
        self.osc_server.add_handler(
            "/live/device/set/input_routing_channel",
            create_device_callback(device_set_input_routing_channel),
        )

        #--------------------------------------------------------------------------------
        # Device: Rack chains + nested devices
        #
        # A rack device (Instrument/Audio Effect/MIDI Effect/Drum Rack) contains
        # `chains`, each with its own `devices` list and a `mixer_device`
        # (volume/panning + mute/solo on the chain). These handlers make racks
        # transparent — list chains, reach the devices nested inside them, and
        # balance the chain mixer. Addressing is one level deep:
        # track -> device(rack) -> chain -> nested device -> parameter.
        #--------------------------------------------------------------------------------
        def _rack(track_index, device_index):
            return self.song.tracks[track_index].devices[device_index]

        def device_get_num_chains(params: Tuple[Any]):
            ti, di = int(params[0]), int(params[1])
            dev = _rack(ti, di)
            n = len(dev.chains) if getattr(dev, "can_have_chains", False) else 0
            return (ti, di, n)

        def device_get_chains(params: Tuple[Any]):
            # Reply: (ti, di, [name, mute, solo, num_devices] per chain).
            ti, di = int(params[0]), int(params[1])
            dev = _rack(ti, di)
            out = []
            if getattr(dev, "can_have_chains", False):
                for ch in dev.chains:
                    out += [ch.name, int(bool(ch.mute)), int(bool(ch.solo)), len(ch.devices)]
            return (ti, di, *out)

        def device_get_visible_macro_count(params: Tuple[Any]):
            ti, di = int(params[0]), int(params[1])
            dev = _rack(ti, di)
            return (ti, di, int(getattr(dev, "visible_macro_count", 0)))

        def chain_get_device_names(params: Tuple[Any]):
            ti, di, ci = int(params[0]), int(params[1]), int(params[2])
            ch = _rack(ti, di).chains[ci]
            return (ti, di, ci, *[d.name for d in ch.devices])

        def chain_get_device_parameters(params: Tuple[Any]):
            # Reply: (ti, di, ci, ndi, [name, value, min, max, is_quantized] per param).
            ti, di, ci, ndi = (int(params[0]), int(params[1]), int(params[2]), int(params[3]))
            dev = _rack(ti, di).chains[ci].devices[ndi]
            out = []
            for p in dev.parameters:
                out += [p.name, p.value, p.min, p.max, int(bool(p.is_quantized))]
            return (ti, di, ci, ndi, *out)

        def chain_get_parameter_value_items(params: Tuple[Any]):
            # (ti, di, ci, ndi, pidx) -> (ti, di, ci, ndi, pidx, *labels).
            ti, di, ci, ndi = (int(params[0]), int(params[1]), int(params[2]), int(params[3]))
            pidx = int(params[4])
            p = _rack(ti, di).chains[ci].devices[ndi].parameters[pidx]
            if not p.is_quantized:
                return (ti, di, ci, ndi, pidx)
            return (ti, di, ci, ndi, pidx, *[str(it) for it in p.value_items])

        def chain_set_device_parameter(params: Tuple[Any]):
            ti, di, ci, ndi = (int(params[0]), int(params[1]), int(params[2]), int(params[3]))
            pidx = int(params[4])
            value = float(params[5])
            self.song.tracks[ti].devices[di].chains[ci].devices[ndi].parameters[pidx].value = value

        def chain_set_mixer(params: Tuple[Any]):
            # (ti, di, ci, prop, value). prop in volume|panning|mute|solo.
            ti, di, ci = int(params[0]), int(params[1]), int(params[2])
            prop = str(params[3])
            ch = _rack(ti, di).chains[ci]
            if prop == "volume":
                ch.mixer_device.volume.value = float(params[4])
            elif prop == "panning":
                ch.mixer_device.panning.value = float(params[4])
            elif prop == "mute":
                ch.mute = bool(int(params[4]))
            elif prop == "solo":
                ch.solo = bool(int(params[4]))
            else:
                self.logger.warning("chain_set_mixer: unknown prop %r" % prop)

        self.osc_server.add_handler("/live/device/get/num_chains", device_get_num_chains)
        self.osc_server.add_handler("/live/device/get/chains", device_get_chains)
        self.osc_server.add_handler("/live/device/get/visible_macro_count", device_get_visible_macro_count)
        self.osc_server.add_handler("/live/device/chain/get/device_names", chain_get_device_names)
        self.osc_server.add_handler("/live/device/chain/get/parameters", chain_get_device_parameters)
        self.osc_server.add_handler("/live/device/chain/get/parameter_value_items", chain_get_parameter_value_items)
        self.osc_server.add_handler("/live/device/chain/set/parameter", chain_set_device_parameter)
        self.osc_server.add_handler("/live/device/chain/set/mixer", chain_set_mixer)

        #--------------------------------------------------------------------------------
        # Device: Drum Rack pad introspection
        #
        # A Drum Rack exposes `drum_pads`, a list of 128 pads indexed by MIDI note.
        # A pad is considered populated when it has at least one chain (i.e. a
        # sample/instrument has been dropped on it). For non-Drum-Rack devices the
        # getters return an empty tuple.
        #--------------------------------------------------------------------------------
        # NOTE: accessing `.drum_pads` on a non-Drum-Rack device raises
        # RuntimeError ("Only drum racks can have pads!"), which hasattr() does
        # NOT suppress (it only swallows AttributeError). Many pack "kits" are
        # actually Instrument Racks (InstrumentGroupDevice), so guard the access
        # with try/except and return empty for anything that isn't a Drum Rack.
        def device_get_num_drum_pads(device, params: Tuple[Any] = ()):
            try:
                pads = device.drum_pads
            except (RuntimeError, AttributeError):
                return ()
            return (sum(1 for pad in pads if pad.chains),)

        def device_get_drum_pads(device, params: Tuple[Any] = ()):
            # Returns a flat (note, name) sequence for every populated pad,
            # ordered by MIDI note. Empty pads are omitted to keep the reply
            # small (well under the UDP MTU for typical kits).
            try:
                pads = device.drum_pads
            except (RuntimeError, AttributeError):
                return ()
            result = []
            for pad in pads:
                if pad.chains:
                    result.append(pad.note)
                    result.append(pad.name)
            return tuple(result)

        self.osc_server.add_handler("/live/device/get/num_drum_pads", create_device_callback(device_get_num_drum_pads))
        self.osc_server.add_handler("/live/device/get/drum_pads", create_device_callback(device_get_drum_pads))
