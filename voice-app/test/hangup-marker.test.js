/**
 * Hangup Marker Tests
 *
 * Tests the [HANGUP] marker parsing used by relay mode responses.
 *
 * Run with: node --test test/hangup-marker.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert');
var { extractHangupMarker } = require('../lib/realtime-voice-loop');

describe('extractHangupMarker', function () {
  it('passes text without a marker through unchanged', function () {
    var result = extractHangupMarker('The backup finished successfully.');
    assert.strictEqual(result.hangup, false);
    assert.strictEqual(result.text, 'The backup finished successfully.');
  });

  it('detects and strips a trailing marker', function () {
    var result = extractHangupMarker('Goodbye, talk to you later! [HANGUP]');
    assert.strictEqual(result.hangup, true);
    assert.strictEqual(result.text, 'Goodbye, talk to you later!');
  });

  it('is case-insensitive and handles markers mid-text', function () {
    var result = extractHangupMarker('Bye! [hangup] Have a nice day.');
    assert.strictEqual(result.hangup, true);
    assert.strictEqual(result.text, 'Bye! Have a nice day.');
  });

  it('returns empty text for a marker-only response', function () {
    var result = extractHangupMarker('[HANGUP]');
    assert.strictEqual(result.hangup, true);
    assert.strictEqual(result.text, '');
  });

  it('handles repeated calls with consistent results', function () {
    // Guards against lastIndex state leaking from the global regex
    assert.strictEqual(extractHangupMarker('bye [HANGUP]').hangup, true);
    assert.strictEqual(extractHangupMarker('bye [HANGUP]').hangup, true);
    assert.strictEqual(extractHangupMarker('no marker here').hangup, false);
    assert.strictEqual(extractHangupMarker('no marker here').hangup, false);
  });

  it('tolerates non-string input', function () {
    assert.strictEqual(extractHangupMarker(null).hangup, false);
    assert.strictEqual(extractHangupMarker(undefined).hangup, false);
  });
});
