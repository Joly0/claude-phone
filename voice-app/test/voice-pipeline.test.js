/**
 * Voice Pipeline Dispatcher Tests
 *
 * Tests provider name resolution and graceful failure paths.
 * No network or FreeSWITCH required.
 *
 * Run with: node --test test/voice-pipeline.test.js
 */

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert');
var { runVoicePipeline, resolveProviderName } = require('../lib/voice-pipeline');

var savedEnv = {};
var ENV_KEYS = ['VOICE_PROVIDER', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'];

beforeEach(function () {
  ENV_KEYS.forEach(function (key) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  });
});

afterEach(function () {
  ENV_KEYS.forEach(function (key) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
});

describe('voice-pipeline', function () {
  describe('resolveProviderName', function () {
    it('defaults to gemini with no config', function () {
      assert.strictEqual(resolveProviderName(null), 'gemini');
      assert.strictEqual(resolveProviderName({}), 'gemini');
    });

    it('uses VOICE_PROVIDER env var when set', function () {
      process.env.VOICE_PROVIDER = 'openai';
      assert.strictEqual(resolveProviderName(null), 'openai');
    });

    it('prefers the device provider field over the env var', function () {
      process.env.VOICE_PROVIDER = 'openai';
      assert.strictEqual(resolveProviderName({ provider: 'classic' }), 'classic');
    });
  });

  describe('runVoicePipeline', function () {
    it('fails gracefully on an unknown provider', async function () {
      var result = await runVoicePipeline({}, {}, 'test-call', {
        provider: 'does-not-exist'
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error, /Unknown voice provider/);
    });

    it('fails gracefully when the provider API key is missing', async function () {
      var result = await runVoicePipeline({}, {}, 'test-call', {
        provider: 'gemini'
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error, /GOOGLE_API_KEY not set/);
    });

    it('resolves the provider from the device config', async function () {
      var result = await runVoicePipeline({}, {}, 'test-call', {
        deviceConfig: { provider: 'does-not-exist' }
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error, /Unknown voice provider/);
    });
  });
});
