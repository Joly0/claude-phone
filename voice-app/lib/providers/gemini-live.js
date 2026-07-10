/**
 * Gemini Live provider descriptor
 * Wraps GeminiLiveSession for the realtime voice loop.
 */

var GeminiLiveSession = require('../gemini-live-session').GeminiLiveSession;

var descriptor = {
  name: 'gemini',
  requiredEnv: ['GOOGLE_API_KEY'],
  defaultVoice: 'Puck',
  knownVoices: null,
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  createSession: function(opts) {
    return new GeminiLiveSession({
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_LIVE_MODEL,
      systemPrompt: opts.systemPrompt,
      voiceName: opts.voiceName
    });
  }
};

module.exports = { descriptor };
