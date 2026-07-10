/**
 * Realtime Voice Provider Registry
 *
 * A provider descriptor tells the realtime voice loop how to talk to a
 * speech-to-speech backend:
 *
 *   {
 *     name: 'gemini',                  // registry key, used in logs and filenames
 *     requiredEnv: ['GOOGLE_API_KEY'], // env vars validated before a call starts
 *     defaultVoice: 'Puck',            // used when deviceConfig.voiceId is absent
 *     knownVoices: [...] | null,       // if set, unknown voiceIds fall back to defaultVoice
 *     inputSampleRate: 16000,          // PCM rate sendAudio() accepts (= fork capture rate)
 *     outputSampleRate: 24000,         // PCM rate of 'audio' event buffers
 *     createSession: function(opts) {} // opts: { systemPrompt, voiceName, tools } -> session
 *   }
 *
 * Session contract (EventEmitter):
 *   Methods: connect() -> Promise (resolved = ready for sendText),
 *            sendAudio(pcm16 mono LE @ inputSampleRate), sendText(text), close(),
 *            sendToolResponse(id, name, response) when tools are supported
 *   Events:  ready, audio (Buffer pcm16 @ outputSampleRate), transcript,
 *            inputTranscription, turnComplete, interrupted, error, close,
 *            toolCall ({ id, name, args }) when tools were passed to createSession
 *   Permanent failure: 'error' whose message contains 'Max reconnect attempts'
 *
 * The 'classic' turn-based pipeline is not a descriptor; it is dispatched
 * separately in lib/voice-pipeline.js.
 */

var geminiLive = require('./gemini-live');
var openaiRealtime = require('./openai-realtime');

var registry = {
  gemini: geminiLive.descriptor,
  openai: openaiRealtime.descriptor
};

/**
 * Look up a provider descriptor by name.
 * @param {string} name
 * @returns {Object|null}
 */
function get(name) {
  return registry[name] || null;
}

/**
 * List registered provider names.
 * @returns {string[]}
 */
function names() {
  return Object.keys(registry);
}

module.exports = { get: get, names: names };
