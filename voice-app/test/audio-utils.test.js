/**
 * Audio Utils Tests
 *
 * Tests the shared stateful PCM resampler used by realtime voice providers.
 *
 * Run with: node --test test/audio-utils.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert');
var { createPcmResampler } = require('../lib/audio-utils');

/**
 * Generate a PCM buffer containing a sine wave.
 * @param {number} frequency - Frequency in Hz
 * @param {number} sampleRate - Sample rate in Hz
 * @param {number} durationMs - Duration in milliseconds
 * @returns {Buffer} 16-bit signed PCM buffer (little-endian)
 */
function generateSineWave(frequency, sampleRate, durationMs) {
  var numSamples = Math.floor(sampleRate * durationMs / 1000);
  var buf = Buffer.alloc(numSamples * 2);
  for (var i = 0; i < numSamples; i++) {
    var sample = Math.round(16000 * Math.sin(2 * Math.PI * frequency * i / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/**
 * Generate a PCM buffer containing a linear ramp signal.
 * @param {number} numSamples - Number of samples to generate
 * @param {number} step - Value increment per sample
 * @returns {Buffer} 16-bit signed PCM buffer (little-endian)
 */
function generateRampSignal(numSamples, step) {
  var buf = Buffer.alloc(numSamples * 2);
  for (var i = 0; i < numSamples; i++) {
    buf.writeInt16LE(i * step, i * 2);
  }
  return buf;
}

/**
 * Count zero crossings in a 16-bit PCM buffer.
 * @param {Buffer} buf - 16-bit signed PCM buffer (little-endian)
 * @returns {number} Number of sign changes
 */
function countZeroCrossings(buf) {
  var crossings = 0;
  var prev = buf.readInt16LE(0);
  for (var i = 1; i < Math.floor(buf.length / 2); i++) {
    var cur = buf.readInt16LE(i * 2);
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) {
      crossings++;
    }
    prev = cur;
  }
  return crossings;
}

describe('audio-utils', function () {
  describe('createPcmResampler', function () {
    it('should pass through when source and target rates are the same', function () {
      var resampler = createPcmResampler();
      var input = generateSineWave(440, 16000, 100);
      var output = resampler.resample(input, 16000, 16000);
      assert.strictEqual(output, input);
    });

    it('should return an empty buffer for empty input', function () {
      var resampler = createPcmResampler();
      var output = resampler.resample(Buffer.alloc(0), 16000, 24000);
      assert.strictEqual(output.length, 0);
    });

    it('should upsample 16kHz to 24kHz at roughly 1.5x the sample count', function () {
      var resampler = createPcmResampler();
      var input = generateSineWave(440, 16000, 200);
      var output = resampler.resample(input, 16000, 24000);

      var inputSamples = input.length / 2;
      var outputSamples = output.length / 2;
      var expected = inputSamples * 1.5;

      // Allow tolerance for interpolation edges and overlap warmup
      assert.ok(
        Math.abs(outputSamples - expected) < expected * 0.05,
        'expected ~' + expected + ' samples, got ' + outputSamples
      );
    });

    it('should downsample 24kHz to 8kHz at roughly 1/3 the sample count', function () {
      var resampler = createPcmResampler();
      var input = generateSineWave(440, 24000, 200);
      var output = resampler.resample(input, 24000, 8000);

      var inputSamples = input.length / 2;
      var outputSamples = output.length / 2;
      var expected = inputSamples / 3;

      assert.ok(
        Math.abs(outputSamples - expected) < expected * 0.05,
        'expected ~' + expected + ' samples, got ' + outputSamples
      );
    });

    it('should preserve signal frequency when upsampling', function () {
      var resampler = createPcmResampler();
      var input = generateSineWave(440, 16000, 500);
      var output = resampler.resample(input, 16000, 24000);

      // Zero crossings per second should be unchanged (2 per cycle)
      var inputRate = countZeroCrossings(input) / 0.5;
      var outputDurationSec = (output.length / 2) / 24000;
      var outputRate = countZeroCrossings(output) / outputDurationSec;

      assert.ok(
        Math.abs(outputRate - inputRate) < inputRate * 0.1,
        'expected ~' + inputRate + ' crossings/s, got ' + outputRate
      );
    });

    it('should resample smoothly across chunk boundaries', function () {
      var numSamples = 900;
      var step = 10;
      var ramp = generateRampSignal(numSamples, step);

      // Feed the same ramp in 3 chunks through one resampler instance
      var chunked = createPcmResampler();
      var chunkBytes = (numSamples / 3) * 2;
      var parts = [];
      for (var i = 0; i < 3; i++) {
        parts.push(chunked.resample(ramp.subarray(i * chunkBytes, (i + 1) * chunkBytes), 16000, 24000));
      }
      var output = Buffer.concat(parts);

      // A resampled ramp must stay monotonic-ish: no large jumps at chunk seams
      var maxDelta = 0;
      var prev = output.readInt16LE(0);
      for (var j = 1; j < Math.floor(output.length / 2); j++) {
        var cur = output.readInt16LE(j * 2);
        maxDelta = Math.max(maxDelta, Math.abs(cur - prev));
        prev = cur;
      }

      assert.ok(
        maxDelta <= step * 4,
        'discontinuity across chunks: max delta ' + maxDelta + ' exceeds ' + (step * 4)
      );
    });

    it('should keep state independent between resampler instances', function () {
      var input = generateSineWave(440, 16000, 100);

      // Warm up the first instance with unrelated audio
      var first = createPcmResampler();
      first.resample(generateRampSignal(500, 20), 16000, 24000);

      var fresh = createPcmResampler();
      var freshOut = fresh.resample(input, 16000, 24000);

      var another = createPcmResampler();
      var anotherOut = another.resample(input, 16000, 24000);

      // Two fresh instances given identical input must produce identical output
      assert.ok(freshOut.equals(anotherOut));
    });
  });
});
