const dgram = require('dgram');
const devices = require('./devices.json');
const YeeBulb = require('./bulbs/bulb');
const Brightness = require('./bulbs/brightness');
const MoonlightMode = require('./bulbs/moonlight');
const Color = require('./bulbs/color');
const Temperature = require('./bulbs/temperature');
const Backlight = require('./bulbs/backlight/bulb');
const BacklightBrightness = require('./bulbs/backlight/brightness');
const BacklightColor = require('./bulbs/backlight/color');
const { getDeviceId, getName, blacklist, sleep, pipe } = require('./utils');

class YeePlatform {
  constructor(log, config, api) {
    if (!api) return;

    this.searchMessage = Buffer.from(
      ['M-SEARCH * HTTP/1.1', 'MAN: "ssdp:discover"', 'ST: wifi_bulb'].join(
        global.EOL
      )
    );
    this.addr = '239.255.255.250';
    this.port = 1982;
    this.log = log;
    this.config = config;
    this.debugMode = config?.debug || false;

    if (this.debugMode) {
      log.debug(`starting YeePlatform using homebridge API v${api.version}`);
    }
    this.sock = dgram.createSocket('udp4');
    this.devices = {};

    this.sock.bind(this.port, () => {
      this.sock.setBroadcast(true);
      this.sock.setMulticastTTL(128);
      this.sock.addMembership(this.addr);
      const multicastInterface = config?.interface;
      if (multicastInterface) {
        this.sock.setMulticastInterface(multicastInterface);
      }
    });

    this.api = api;
    this.api.on('didFinishLaunching', async () => {
      this.sock.on('message', this.handleMessage.bind(this));
      log(`Searching for known devices...`);
      do {
        this.search();
        // eslint-disable-next-line no-await-in-loop
        await sleep(15000);
      } while (
        Object.values(this.devices).some((accessory) => !accessory.initialized)
      );

      log(`All known devices found. Stopping proactive search.`);
    });
  }

  configureAccessory(accessory) {
    this.log(`Loaded accessory ${accessory.displayName}.`);
    accessory.initialized = false;
    this.devices[accessory.context.did] = accessory;
  }

  search() {
    if (this.debugMode) {
      this.log('Sending search request...');
    }
    this.sock.send(
      this.searchMessage,
      0,
      this.searchMessage.length,
      this.port,
      this.addr
    );
  }

  handleMessage(message) {
    const headers = {};
    const [method, ...kvs] = message.toString().split(global.EOL);

    if (method.startsWith('M-SEARCH')) return;

    kvs.forEach((kv) => {
      const [k, v] = kv.split(': ');
      headers[k] = v;
    });
    const endpoint = headers.Location.split('//')[1];
    if (this.debugMode) {
      const ip = endpoint.split(':')[0];
      this.log(`Received advertisement from ${getDeviceId(headers.id)} at ${ip}.`);
    }
    this.buildDevice(endpoint, headers);
  }

  buildDevice(endpoint, { id, model, support, ...props }) {
    const deviceId = getDeviceId(id);
    const name = getName(`${model}-${deviceId}`, this.config);
    const hidden = blacklist(deviceId, this.config);
    let accessory = this.devices[deviceId];

    if (hidden === true) {
      if (this.debugMode) {
        this.log.debug(`Device ${name} is blacklisted, ignoring...`);
      }
      try {
        delete this.devices[deviceId];
        this.api.unregisterPlatformAccessories(
          'homebridge-yeelight',
          'yeelight',
          [accessory]
        );
        this.log(`Device ${name} was unregistered`);
        // eslint-disable-next-line no-empty
      } catch (_) {}
      return;
    }

    const features = support
      .split(' ')
      .concat(Object.keys(props))
      .filter((f) => !hidden.includes(f));

    if (!accessory) {
      this.log(`Initializing new accessory ${deviceId} with name ${name}...`);
      const uuid = global.UUIDGen.generate(deviceId);
      accessory = new global.Accessory(name, uuid);
      accessory.context.did = deviceId;
      accessory.context.model = model;
      this.devices[deviceId] = accessory;
      this.api.registerPlatformAccessories('homebridge-yeelight', 'yeelight', [
        accessory,
      ]);
    }

    // If accessory already initialized, just update endpoint and return
    if (accessory?.initialized && accessory.bulb) {
      accessory.bulb.updateEndpoint(endpoint);
      return;
    }

    const mixins = [];
    const limits = devices[model] || devices['default'];

    if (!hidden.includes('active_mode')) {
      mixins.push(MoonlightMode);
    }

    if (features.includes('set_bright')) {
      if (this.debugMode) {
        this.log(`Device ${name} supports brightness`);
      }
      mixins.push(Brightness);
    }

    if (features.includes('set_hsv')) {
      if (this.debugMode) {
        this.log(`Device ${name} supports color`);
      }
      mixins.push(Color);
    }

    if (features.includes('set_ct_abx')) {
      if (this.debugMode) {
        this.log(`Device ${name} supports color temperature`);
      }
      mixins.push(Temperature);
    }

    if (features.includes('bg_set_power')) {
      if (this.debugMode) {
        this.log(`Device ${name} supports backlight`);
      }
      mixins.push(Backlight);
    }

    if (features.includes('bg_set_bright')) {
      if (this.debugMode) {
        this.log(`Device ${name} supports backlight brightness`);
      }
      mixins.push(BacklightBrightness);
    }

    if (features.includes('bg_set_hsv')) {
      if (this.debugMode) {
        this.log(`Device ${name} supports backlight color`);
      }
      mixins.push(BacklightColor);
    }

    const Bulb = class extends pipe(...mixins)(YeeBulb) {};
    const bulb = new Bulb(
      { id: deviceId, model, endpoint, accessory, limits, ...props },
      this
    );
    // Keep reference for future endpoint updates
    accessory.bulb = bulb;
    return bulb;
  }
}

module.exports = YeePlatform;
