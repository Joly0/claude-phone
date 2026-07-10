/**
 * Public IP Detection
 *
 * Supports PUBLIC_IP=auto: detects the current public IPv4 address via
 * well-known HTTPS services and re-checks it periodically so dynamic-IP
 * connections keep working without editing .env.
 *
 * When PUBLIC_IP is a literal address (or unset), this module is inert and
 * getPublicIp() just returns the configured value.
 */

var axios = require('axios');
var logger = require('./logger');

var IP_SERVICES = [
  'https://api.ipify.org',
  'https://checkip.amazonaws.com',
  'https://ifconfig.me/ip',
  'https://icanhazip.com'
];

var FETCH_TIMEOUT_MS = 5000;
var FIRST_DETECT_CAP_MS = 10000;
var DEFAULT_INTERVAL_SECONDS = 300;

var currentIp = null;
var timer = null;
var checking = false;
var activeOnChange = null;
var fetcher = defaultFetcher;

function defaultFetcher(url) {
  return axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    responseType: 'text',
    // Keep the body as raw text even if the service sets a JSON content type
    transformResponse: [function(data) { return data; }]
  }).then(function(res) {
    return String(res.data);
  });
}

/**
 * Whether PUBLIC_IP is set to auto-detection mode.
 * @returns {boolean}
 */
function isAuto() {
  return (process.env.PUBLIC_IP || '').trim().toLowerCase() === 'auto';
}

/**
 * Validate and normalize an IPv4 address string.
 * @param {string} raw
 * @returns {string|null} Trimmed address, or null if invalid
 */
function parseIpv4(raw) {
  if (typeof raw !== 'string') return null;
  var trimmed = raw.trim();
  var match = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  for (var i = 1; i <= 4; i++) {
    if (parseInt(match[i], 10) > 255) return null;
  }
  return trimmed;
}

/**
 * Detect the current public IP by querying services in order until one
 * returns a valid IPv4 address.
 * @returns {Promise<string|null>} The detected address, or null if all fail
 */
async function detect() {
  for (var i = 0; i < IP_SERVICES.length; i++) {
    var url = IP_SERVICES[i];
    try {
      var body = await fetcher(url);
      var ip = parseIpv4(body);
      if (ip) {
        return ip;
      }
      logger.warn('Public IP service returned an unexpected body', { service: url });
    } catch (err) {
      logger.warn('Public IP service failed', { service: url, error: err.message });
    }
  }
  return null;
}

async function check(onChange, isFirst) {
  if (checking) return;
  checking = true;
  try {
    var ip = await detect();
    if (!ip) {
      logger.warn('Public IP detection failed on all services, keeping previous value', {
        currentIp: currentIp
      });
      return;
    }

    var previous = currentIp;
    if (ip !== previous) {
      currentIp = ip;
      if (isFirst || previous === null) {
        logger.info('Public IP detected', { publicIp: ip });
      } else {
        logger.warn('Public IP changed', { from: previous, to: ip });
        if (typeof onChange === 'function') {
          try {
            onChange(ip, previous);
          } catch (err) {
            logger.error('Public IP change handler failed', { error: err.message });
          }
        }
      }
    }
  } finally {
    checking = false;
  }
}

/**
 * Start auto-detection: performs an initial detection (capped so startup
 * never hangs on it), then re-checks on an interval. The interval timer is
 * unref'd so it never keeps the process alive.
 *
 * @param {Object} [opts]
 * @param {number} [opts.intervalSeconds] - Re-check interval (default env
 *   PUBLIC_IP_CHECK_INTERVAL or 300)
 * @param {function(string, string)} [opts.onChange] - Called with
 *   (newIp, oldIp) whenever the address changes after the first detection
 * @returns {Promise<string|null>} The initially detected IP, or null
 */
async function start(opts) {
  opts = opts || {};
  if (timer) {
    return currentIp;
  }

  var intervalSeconds = opts.intervalSeconds ||
    parseInt(process.env.PUBLIC_IP_CHECK_INTERVAL, 10) ||
    DEFAULT_INTERVAL_SECONDS;

  activeOnChange = opts.onChange || null;

  // Initial detection, capped so a slow/offline network cannot stall startup
  await Promise.race([
    check(activeOnChange, true),
    new Promise(function(resolve) { setTimeout(resolve, FIRST_DETECT_CAP_MS).unref(); })
  ]);

  timer = setInterval(function() {
    check(activeOnChange, false);
  }, intervalSeconds * 1000);
  timer.unref();

  logger.info('Public IP auto-detection started', {
    publicIp: currentIp,
    intervalSeconds: intervalSeconds
  });

  return currentIp;
}

/**
 * Stop periodic detection.
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Current public IP for SIP contact headers.
 * Precedence: detected address > static PUBLIC_IP > EXTERNAL_IP.
 * @returns {string|undefined}
 */
function getPublicIp() {
  if (currentIp) return currentIp;
  if (!isAuto() && process.env.PUBLIC_IP) return process.env.PUBLIC_IP;
  return process.env.EXTERNAL_IP;
}

/**
 * Test hooks: swap the HTTP fetcher and reset module state.
 */
function _setFetcher(fn) {
  fetcher = fn || defaultFetcher;
}

function _reset() {
  stop();
  currentIp = null;
  checking = false;
  activeOnChange = null;
  fetcher = defaultFetcher;
}

function _checkForTests() {
  return check(activeOnChange, false);
}

module.exports = {
  isAuto: isAuto,
  parseIpv4: parseIpv4,
  detect: detect,
  start: start,
  stop: stop,
  getPublicIp: getPublicIp,
  _setFetcher: _setFetcher,
  _reset: _reset,
  _checkForTests: _checkForTests
};
