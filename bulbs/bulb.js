const net = require('net');
const { id, handle } = require('../utils');

class YeeBulb {
  constructor(props, platform) {
    const { id, model, endpoint, accessory } = props;
    this.did = id;
    this.name = accessory.displayName;
    this.model = model;
    this.log = platform.log;
    this.cmds = {};
    this.sock = null;
    this.accessory = accessory;
    this.config = platform.config || {};
    this.debugMode = platform.debugMode || false;
    this.endpoint = endpoint;
    const { retries = 5, timeout = 100 } = this.config.connection || {};
    this.retries = retries;
    this.timeout = timeout;

    // Collapsed pending map by command method (last one wins)
    this.pendingByKey = {};
    // Online flag toggled by socket lifecycle
    this.online = false;
    // Prevent concurrent reconciliations
    this._reconciling = false;

    this.accessory
      .getService(global.Service.AccessoryInformation)
      .setCharacteristic(global.Characteristic.Manufacturer, 'YeeLight')
      .setCharacteristic(global.Characteristic.Model, this.model)
      .setCharacteristic(global.Characteristic.SerialNumber, this.did);

    this.service =
      this.accessory.getService(global.Service.Lightbulb) ||
      this.accessory.addService(new global.Service.Lightbulb(this.name));

    this.service.setPrimaryService();

    this.accessory.on('identify', async (_, callback) => {
      await this.identify();
      callback();
    });

    this.service
      .getCharacteristic(global.Characteristic.On)
      .on('set', async (value, callback) => {
        try {
          await this.setPower(value);
          callback(null);
        } catch (err) {
          callback(err);
        }
      })
      .on('get', async (callback) => {
        try {
          const [value] = await this.getProperty(['power']);
          this.power = value;
          callback(null, this.power);
        } catch (err) {
          callback(err, this.power);
        }
      })
      .updateValue(this.power);

    this.accessory.initialized = true;

    this.log(`Initialized device ${this.name} (${this.endpoint}).`);
  }

  get endpoint() {
    return `${this.host}:${this.port}`;
  }

  updateEndpoint(endpoint) {
    const previousEndpoint = this.endpoint;
    if (previousEndpoint === endpoint) {
      return;
    }
    this.endpoint = endpoint;
    if (this.sock && !this.sock.destroyed) {
      try {
        this.sock.destroy();
      } catch (_) {}
      this.sock = null;
    }
    if (this.debugMode) {
      this.log.debug(
        `${this.name}: endpoint changed ${previousEndpoint} -> ${this.endpoint}`
      );
    }
  }

  set endpoint(endpoint) {
    const [host, port] = endpoint.split(':');
    this.host = host;
    this.port = Number(port);
  }

  get power() {
    return !!this._power;
  }

  set power(state) {
    this._power = state === 'on' ? true : false;
  }

  updateStateFromProp(prop, value) {
    if (prop !== 'power') {
      if (this.debugMode) {
        this.log.debug(`${prop} is not supported in Homekit, skipping.`);
      }
      return;
    }
    this.power = value;
    this.service
      .getCharacteristic(global.Characteristic.On)
      .updateValue(this.power);
  }

  async setPower(power) {
    if (this.power === power) {
      return power;
    }
    const { power: transition = 400 } = this.config.transitions || {};
    const state = power ? 'on' : 'off';
    const req = {
      method: 'set_power',
      params: [state, 'smooth', transition],
    };
    await this.sendCmd(req);
    this.power = state;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.sock && !this.sock.destroyed) {
        resolve();
        return;
      }

      this.sock = net.connect(this.port, this.host, () => {
        if (this.debugMode) {
          this.log.debug(
            `connected to ${this.host}:${this.port} (device ${this.did}).`
          );
        }
        this.online = true;
        // Attempt to flush any pending commands on (re)connect
        this._onConnected();
        resolve();
      });

      this.sock.on(
        'data',
        handle([this.responseHandler.bind(this), this.stateHandler.bind(this)])
      );

      this.sock.on('error', (error) => {
        this.log.error(
          `${this.did}@${this.host}:${this.port} error: ${error.message}.`
        );
        this.online = false;
        reject(error.code);
      });

      this.sock.on('close', (hadError) => {
        this.log.warn(
          `${this.did}@${this.host}:${this.port} connection closed. error? ${hadError}.`
        );
        this.cmds = {};
        this.online = false;
        reject(new Error(`close: error? ${hadError}`));
      });
    });
  }

  getProperty(properties) {
    const req = { method: 'get_prop', params: properties };
    return this.sendCmd(req);
  }

  identify() {
    // Use flash notify effect when supported
    // TODO: Check support for `start_cf`
    const req = {
      method: 'start_cf',
      params: [10, 0, '500,2,0,10,500,2,0,100'],
    };
    return this.sendCmd(req);
  }

  async sendCmd(cmd) {
    if (this.debugMode) {
      this.log.info(
        `Sending command to ${this.host} (device ${this.did}): ${JSON.stringify(
          cmd
        )}`
      );
    }
    const { retries, timeout } = this;
    const isGet = cmd && cmd.method === 'get_prop';
    // Cache raw command (by method) for later replay if needed
    if (!isGet) {
      this._cachePending(cmd);
    }
    cmd.id = id.next().value;
    for (let i = 0; i <= retries; i += 1) {
      const t = timeout << i;
      try {
        // await in loop intentionally used to implement exponential backoff
        // eslint-disable-next-line no-await-in-loop
        return await this._sendCmd(cmd, t);
      } catch (err) {
        if (this.debugMode) {
          this.log.debug(
            `${this.did}@${this.host}:${this.port} failed communication attempt ${i} after ${t}ms.`
          );
        }
        if (err === 'EHOSTUNREACH') break;
        if (i === retries) break;
      }
    }
    // If we reach here, command failed after retries
    if (this.sock && !this.sock.destroyed) {
      try {
        this.sock.destroy();
      } catch (_) {}
    }
    this.online = false;
    if (!isGet) {
      // For state-changing commands, do not reject: we'll flush on reconnect
      if (this.debugMode) {
        this.log.debug(
          `${this.did}@${this.host}:${this.port}: queued command for later flush (cmd ${cmd.id}).`
        );
      }
      return Promise.resolve([]);
    }
    this.log.error(
      `${this.did}@${this.host}:${this.port}: failed to send cmd ${cmd.id} after ${retries} retries.`
    );
    return Promise.reject(new Error(`${cmd.id}`));
  }

  _sendCmd(cmd, duration) {
    const _connect = async () => {
      if (!this.sock || this.sock.destroyed) {
        await this.connect();
      }
    };

    return new Promise((resolve, reject) => {
      _connect()
        .catch(reject)
        .then(() => {
          const msg = JSON.stringify(cmd);
          const timeout = setTimeout(() => {
            reject(new Error(`${cmd.id}`));
            delete this.cmds[cmd.id];
          }, duration);
          this.sock.write(msg + global.EOL);
          this.cmds[cmd.id] = { resolve, reject, timeout };
          if (this.debugMode) {
            this.log.debug(`${this.did}@${this.host}:${this.port} -> ${msg}`);
          }
        });
    });
  }

  responseHandler(message) {
    if (!('id' in message)) return false;
    if (!(message.id in this.cmds)) return true;

    const cmd = this.cmds[message.id];
    clearTimeout(cmd.timeout);

    if ('result' in message) {
      if (this.debugMode) {
        this.log.debug(
          `${this.did}@${this.host}:${this.port} <- ${JSON.stringify(message)}`
        );
      }
      cmd.resolve(message.result);
    } else if ('error' in message) {
      this.log.error(
        `${this.did}@${this.host}:${this.port} response error: ${JSON.stringify(
          message
        )}`
      );
      cmd.reject(message.error.message);
    } else {
      this.log.error(
        `unexpected result from ${this.did}@${this.host}:${this.port}: ${JSON.stringify(
          message
        )}`
      );
      cmd.reject(message.error.message);
    }
    delete this.cmds[message.id];
    return true;
  }

  stateHandler(message) {
    if (!('method' in message && message.method === 'props')) {
      return false;
    }
    Object.keys(message.params).forEach((param) => {
      this.updateStateFromProp(param, message.params[param]);
    });
    return true;
  }

  _cachePending(cmd) {
    if (!cmd || !cmd.method) return;
    const { method, params } = cmd;
    // Store minimal shape without id
    this.pendingByKey[method] = { method, params };
  }

  // lastKnownState tracking removed as we now rely on replaying raw commands

  async _onConnected() {
    // Avoid overlapping reconcile runs
    if (this._reconciling) return;
    this._reconciling = true;
    try {
      await this._flushPending();
    } catch (err) {
      if (this.debugMode) {
        this.log.debug(`Flush pending failed for ${this.did}: ${err && err.message}`);
      }
    } finally {
      this._reconciling = false;
    }
  }

  async _flushPending() {
    const order = [
      'set_power',
      'bg_set_power',
      'set_ct_abx',
      'set_hsv',
      'set_bright',
      'bg_set_hsv',
      'bg_set_bright',
    ];
    for (const method of order) {
      const cmd = this.pendingByKey[method];
      if (!cmd) continue;
      try {
        const req = { method: cmd.method, params: cmd.params };
        // Assign new id inside sendCmd
        await this.sendCmd(req);
        // Do not delete pending after flush; keep as desired state for future cycles
      } catch (_) {
        // Keep pending for next reconnect
      }
    }
  }
}

module.exports = YeeBulb;
