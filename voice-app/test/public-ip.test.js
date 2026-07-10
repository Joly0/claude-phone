/**
 * Public IP Detection Tests
 *
 * Tests IPv4 parsing, service fallback, change detection and getPublicIp
 * precedence with an injected fetcher. No network required.
 *
 * Run with: node --test test/public-ip.test.js
 */

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert');
var publicIp = require('../lib/public-ip');

var savedEnv = {};
var ENV_KEYS = ['PUBLIC_IP', 'EXTERNAL_IP', 'PUBLIC_IP_CHECK_INTERVAL'];

beforeEach(function () {
  ENV_KEYS.forEach(function (key) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  });
  publicIp._reset();
});

afterEach(function () {
  ENV_KEYS.forEach(function (key) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
  publicIp._reset();
});

describe('public-ip', function () {
  describe('isAuto', function () {
    it('is true only for the auto keyword', function () {
      process.env.PUBLIC_IP = 'auto';
      assert.strictEqual(publicIp.isAuto(), true);
      process.env.PUBLIC_IP = 'AUTO';
      assert.strictEqual(publicIp.isAuto(), true);
      process.env.PUBLIC_IP = '203.0.113.10';
      assert.strictEqual(publicIp.isAuto(), false);
      delete process.env.PUBLIC_IP;
      assert.strictEqual(publicIp.isAuto(), false);
    });
  });

  describe('parseIpv4', function () {
    it('accepts valid addresses and trims whitespace', function () {
      assert.strictEqual(publicIp.parseIpv4('203.0.113.10'), '203.0.113.10');
      // icanhazip.com returns a trailing newline
      assert.strictEqual(publicIp.parseIpv4('203.0.113.10\n'), '203.0.113.10');
      assert.strictEqual(publicIp.parseIpv4('  8.8.8.8  '), '8.8.8.8');
    });

    it('rejects invalid input', function () {
      assert.strictEqual(publicIp.parseIpv4('not an ip'), null);
      assert.strictEqual(publicIp.parseIpv4('256.1.1.1'), null);
      assert.strictEqual(publicIp.parseIpv4('1.2.3'), null);
      assert.strictEqual(publicIp.parseIpv4('<html>error</html>'), null);
      assert.strictEqual(publicIp.parseIpv4(''), null);
      assert.strictEqual(publicIp.parseIpv4(null), null);
    });
  });

  describe('detect', function () {
    it('returns the first valid response', async function () {
      var calls = [];
      publicIp._setFetcher(function (url) {
        calls.push(url);
        return Promise.resolve('203.0.113.10\n');
      });

      var ip = await publicIp.detect();
      assert.strictEqual(ip, '203.0.113.10');
      assert.strictEqual(calls.length, 1);
    });

    it('falls back to the next service on failure or garbage', async function () {
      var calls = [];
      publicIp._setFetcher(function (url) {
        calls.push(url);
        if (calls.length === 1) return Promise.reject(new Error('timeout'));
        if (calls.length === 2) return Promise.resolve('<html>blocked</html>');
        return Promise.resolve('198.51.100.7');
      });

      var ip = await publicIp.detect();
      assert.strictEqual(ip, '198.51.100.7');
      assert.strictEqual(calls.length, 3);
    });

    it('returns null when every service fails', async function () {
      publicIp._setFetcher(function () {
        return Promise.reject(new Error('offline'));
      });

      var ip = await publicIp.detect();
      assert.strictEqual(ip, null);
    });
  });

  describe('start', function () {
    it('detects the initial IP without firing onChange', async function () {
      publicIp._setFetcher(function () {
        return Promise.resolve('203.0.113.10');
      });
      var changes = [];

      var ip = await publicIp.start({
        intervalSeconds: 3600,
        onChange: function (newIp, oldIp) { changes.push([newIp, oldIp]); }
      });

      assert.strictEqual(ip, '203.0.113.10');
      assert.deepStrictEqual(changes, []);
      assert.strictEqual(publicIp.getPublicIp(), '203.0.113.10');
    });

    it('fires onChange once per change on subsequent checks', async function () {
      var responses = ['203.0.113.10', '203.0.113.10', '198.51.100.7'];
      var callCount = 0;
      publicIp._setFetcher(function () {
        var ip = responses[Math.min(callCount, responses.length - 1)];
        callCount++;
        return Promise.resolve(ip);
      });
      var changes = [];

      await publicIp.start({
        intervalSeconds: 3600,
        onChange: function (newIp, oldIp) { changes.push([newIp, oldIp]); }
      });

      // Drive checks directly instead of waiting for the interval
      await publicIp.detect().then(function () {});
      await publicIp.start({});   // no-op: already started
      assert.deepStrictEqual(changes, []);

      // Simulate two interval ticks via the internal check path
      await publicIp._checkForTests();
      assert.deepStrictEqual(changes, [['198.51.100.7', '203.0.113.10']]);

      await publicIp._checkForTests();
      assert.deepStrictEqual(changes, [['198.51.100.7', '203.0.113.10']]);
    });

    it('keeps the previous value when detection starts failing', async function () {
      var fail = false;
      publicIp._setFetcher(function () {
        return fail ? Promise.reject(new Error('offline')) : Promise.resolve('203.0.113.10');
      });

      await publicIp.start({ intervalSeconds: 3600 });
      fail = true;
      await publicIp._checkForTests();

      assert.strictEqual(publicIp.getPublicIp(), '203.0.113.10');
    });
  });

  describe('getPublicIp', function () {
    it('prefers a static PUBLIC_IP over EXTERNAL_IP when not auto', function () {
      process.env.PUBLIC_IP = '203.0.113.10';
      process.env.EXTERNAL_IP = '10.0.0.5';
      assert.strictEqual(publicIp.getPublicIp(), '203.0.113.10');
    });

    it('falls back to EXTERNAL_IP in auto mode before first detection', function () {
      process.env.PUBLIC_IP = 'auto';
      process.env.EXTERNAL_IP = '10.0.0.5';
      assert.strictEqual(publicIp.getPublicIp(), '10.0.0.5');
    });

    it('prefers the detected address over everything', async function () {
      process.env.PUBLIC_IP = 'auto';
      process.env.EXTERNAL_IP = '10.0.0.5';
      publicIp._setFetcher(function () {
        return Promise.resolve('198.51.100.7');
      });

      await publicIp.start({ intervalSeconds: 3600 });
      assert.strictEqual(publicIp.getPublicIp(), '198.51.100.7');
    });
  });
});
