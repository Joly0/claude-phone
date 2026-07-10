/**
 * Multi-Extension SIP Registrar
 * Registers multiple extensions independently.
 * Supports DNS SRV resolution with failover across registrar targets.
 */

var srvResolver = require('./srv-resolver');

class MultiRegistrar {
  constructor(srf, baseConfig) {
    this.srf = srf;
    this.baseConfig = baseConfig;
    this.registrations = new Map();
    this.timers = new Map();
    // Resolved SRV targets (shared across devices, re-resolved on TTL expiry)
    this.resolvedTargets = null;
    this.resolvedAt = 0;
    this.resolveTtl = 0;
  }

  /**
   * Register all devices from config object
   * @param {Object} devices - Object keyed by extension with device configs
   */
  registerAll(devices) {
    const extensions = Object.keys(devices);
    console.log('[MULTI-REGISTRAR] Starting registration for ' + extensions.length + ' devices');

    for (const [extension, device] of Object.entries(devices)) {
      this.registerDevice(device);
    }
  }

  /**
   * Register a single device
   */
  registerDevice(device) {
    const config = {
      extension: device.extension,
      auth_id: device.authId,
      password: device.password,
      domain: this.baseConfig.domain,
      registrar: this.baseConfig.registrar,
      registrar_port: this.baseConfig.registrar_port,
      transport: this.baseConfig.transport || 'udp',
      expiry: this.baseConfig.expiry,
      local_address: this.baseConfig.local_address,
      local_port: this.baseConfig.local_port
    };

    console.log('[MULTI-REGISTRAR] Registering ' + device.name + ' (ext ' + device.extension + ')');
    this.resolveAndRegister(device, config);
  }

  /**
   * Resolve SRV records, then send REGISTER to the best available target.
   * Re-resolves when the TTL expires.
   */
  resolveAndRegister(device, config) {
    const self = this;
    const now = Date.now();
    var needsResolve = !this.resolvedTargets || (now - this.resolvedAt) > (this.resolveTtl * 1000);

    if (!needsResolve) {
      self.sendRegisterWithTargets(device, config, self.resolvedTargets);
      return;
    }

    srvResolver.resolveRegistrar(config.registrar, config.registrar_port, config.transport)
      .then(function(result) {
        self.resolvedTargets = result.targets;
        self.resolvedAt = Date.now();
        self.resolveTtl = result.ttl;
        self.sendRegisterWithTargets(device, config, result.targets);
      })
      .catch(function(err) {
        console.error('[MULTI-REGISTRAR] ' + device.name + ' SRV resolve error: ' + err.message);
        self.sendRegisterWithTargets(device, config, [{ host: config.registrar, port: config.registrar_port }]);
      });
  }

  /**
   * Try sending REGISTER to each target in order until one succeeds
   */
  sendRegisterWithTargets(device, config, targets, targetIndex) {
    targetIndex = targetIndex || 0;
    if (targetIndex >= targets.length) {
      console.error('[MULTI-REGISTRAR] ' + device.name + ' all targets failed, retrying in 60s');
      this.scheduleRetry(device, config, 60);
      return;
    }

    const self = this;
    const target = targets[targetIndex];
    const transport = config.transport || 'udp';
    const uri = 'sip:' + target.host + ':' + target.port + ';transport=' + transport;
    // For TLS, use the TLS port (drachtio's TLS listener) regardless of local_port setting
    const localPort = (transport === 'tls') ? (parseInt(process.env.DRACHTIO_TLS_PORT) || 5061) : (config.local_port || 5060);
    const contactTransport = (transport === 'tls') ? ';transport=tls' : '';
    const contact = 'sip:' + config.extension + '@' + config.local_address + ':' + localPort + contactTransport;

    console.log('[MULTI-REGISTRAR] REGISTER ' + device.name + ' to ' + uri);
    console.log('[MULTI-REGISTRAR]   Contact: ' + contact);

    this.srf.request(uri, {
      method: 'REGISTER',
      headers: {
        'From': '<sip:' + config.extension + '@' + config.domain + '>',
        'To': '<sip:' + config.extension + '@' + config.domain + '>',
        'Contact': '<' + contact + '>;expires=' + config.expiry,
        'Expires': config.expiry,
        'User-Agent': 'NetworkChuck-VoiceServer/1.0'
      },
      auth: {
        username: config.auth_id,
        password: config.password
      }
    }, function(err, req) {
      if (err) {
        console.error('[MULTI-REGISTRAR] ' + device.name + ' request error to ' + target.host + ': ' + err.message);
        // Try next target
        self.sendRegisterWithTargets(device, config, targets, targetIndex + 1);
        return;
      }

      req.on('response', function(res) {
        if (res.status === 200) {
          console.log('[MULTI-REGISTRAR] ' + device.name + ' SUCCESS - Registered as ext ' + config.extension + ' via ' + target.host);

          var expiry = config.expiry;
          var contactHeader = res.get('Contact');
          if (contactHeader) {
            var match = contactHeader.match(/expires=(\d+)/i);
            if (match) expiry = parseInt(match[1], 10);
          }

          self.registrations.set(config.extension, {
            device: device,
            config: config,
            expiry: expiry,
            registeredAt: Date.now(),
            target: target
          });

          var refreshTime = Math.floor(expiry * 0.9);
          console.log('[MULTI-REGISTRAR] ' + device.name + ' refresh in ' + refreshTime + 's');
          self.scheduleRefresh(device, config, refreshTime);

        } else if (res.status === 401 || res.status === 407) {
          console.log('[MULTI-REGISTRAR] ' + device.name + ' auth challenge - handled by drachtio');
        } else if (res.status === 503) {
          console.error('[MULTI-REGISTRAR] ' + device.name + ' 503 from ' + target.host + ', trying next target');
          self.sendRegisterWithTargets(device, config, targets, targetIndex + 1);
        } else {
          console.error('[MULTI-REGISTRAR] ' + device.name + ' FAILED: ' + res.status + ' ' + res.reason);
          self.scheduleRetry(device, config, 60);
        }
      });
    });
  }

  scheduleRefresh(device, config, seconds) {
    const self = this;
    const key = device.extension || device.name;
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(function() {
      console.log('[MULTI-REGISTRAR] Refreshing ' + device.name);
      self.resolveAndRegister(device, config);
    }, seconds * 1000));
  }

  scheduleRetry(device, config, seconds) {
    const self = this;
    const key = device.extension || device.name;
    console.log('[MULTI-REGISTRAR] ' + device.name + ' retry in ' + seconds + 's');
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(function() {
      self.resolveAndRegister(device, config);
    }, seconds * 1000));
  }

  stop() {
    this.timers.forEach(function(timer) { clearTimeout(timer); });
    this.timers.clear();
    this.registrations.clear();
    console.log('[MULTI-REGISTRAR] Stopped all registrations');
  }
}

module.exports = MultiRegistrar;
