/**
 * Audio Utilities
 * Shared PCM helpers for realtime voice providers.
 */

/**
 * Create a stateful PCM resampler.
 *
 * Uses 4-point cubic Hermite interpolation and keeps a small overlap of
 * samples between calls so successive chunks resample without clicks.
 * One resampler instance must only be used for a single continuous stream
 * (one direction, one rate pair).
 *
 * @returns {{ resample: function(Buffer, number, number): Buffer }}
 */
function createPcmResampler() {
  var state = null;

  /**
   * Resample 16-bit signed little-endian PCM audio.
   *
   * @param {Buffer} inputBuffer - 16-bit signed PCM (little-endian)
   * @param {number} fromRate - Source sample rate (e.g. 24000)
   * @param {number} toRate - Target sample rate (e.g. 8000)
   * @returns {Buffer} Resampled 16-bit signed PCM (little-endian)
   */
  function resample(inputBuffer, fromRate, toRate) {
    if (fromRate === toRate) {
      return inputBuffer;
    }

    var inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      Math.floor(inputBuffer.length / 2)
    );
    var inputLength = inputSamples.length;

    if (inputLength === 0) {
      return Buffer.alloc(0);
    }

    var ratio = fromRate / toRate;

    // Keep leftover samples from previous chunk for continuity
    if (!state) {
      state = { offset: 0, prevSamples: new Float64Array(0) };
    }

    // Prepend previous chunk's tail for filter overlap
    var overlapSize = 8; // samples of overlap
    var prev = state.prevSamples;
    var totalLength = prev.length + inputLength;
    var combined = new Float64Array(totalLength);
    combined.set(prev, 0);
    for (var k = 0; k < inputLength; k++) {
      combined[prev.length + k] = inputSamples[k];
    }

    // Save tail for next chunk
    var tailSize = Math.min(overlapSize, inputLength);
    state.prevSamples = new Float64Array(tailSize);
    for (var t = 0; t < tailSize; t++) {
      state.prevSamples[t] = inputSamples[inputLength - tailSize + t];
    }

    // Resample with 4-point cubic interpolation + implicit anti-alias from averaging
    var srcPos = state.offset + prev.length;
    var outputSamples = [];
    var endPos = prev.length + inputLength - 2;

    while (srcPos < endPos) {
      var idx = Math.floor(srcPos);
      var frac = srcPos - idx;

      // Cubic Hermite interpolation (4 points)
      var s0 = idx > 0 ? combined[idx - 1] : combined[idx];
      var s1 = combined[idx];
      var s2 = idx + 1 < totalLength ? combined[idx + 1] : s1;
      var s3 = idx + 2 < totalLength ? combined[idx + 2] : s2;

      var a = -0.5 * s0 + 1.5 * s1 - 1.5 * s2 + 0.5 * s3;
      var b = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
      var c = -0.5 * s0 + 0.5 * s2;
      var d = s1;

      var sample = a * frac * frac * frac + b * frac * frac + c * frac + d;
      sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
      outputSamples.push(sample);
      srcPos += ratio;
    }

    state.offset = srcPos - endPos - 2;

    var result = new Int16Array(outputSamples.length);
    for (var i = 0; i < outputSamples.length; i++) {
      result[i] = outputSamples[i];
    }
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  }

  return { resample: resample };
}

module.exports = { createPcmResampler };
