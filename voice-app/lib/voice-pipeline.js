/**
 * Voice Pipeline Dispatcher
 *
 * Single entry point for starting a voice conversation on a connected call.
 * Selects the provider from (in priority order):
 *   1. options.provider (explicit override)
 *   2. deviceConfig.provider (per-device field in devices.json)
 *   3. VOICE_PROVIDER env var
 *   4. 'gemini' (default, backward compatible)
 *
 * Providers:
 *   - Realtime speech-to-speech descriptors from lib/providers (gemini, openai)
 *   - 'classic': the turn-based STT -> Claude -> TTS pipeline (conversation-loop.js)
 */

var logger = require('./logger');
var providers = require('./providers');
var { runRealtimeVoiceLoop } = require('./realtime-voice-loop');

/**
 * Resolve the provider name for a call.
 * @param {Object} [deviceConfig] - Device configuration (may carry a provider field)
 * @returns {string}
 */
function resolveProviderName(deviceConfig) {
  return (deviceConfig && deviceConfig.provider) || process.env.VOICE_PROVIDER || 'gemini';
}

function missingEnv(requiredEnv) {
  return (requiredEnv || []).filter(function(name) {
    return !process.env[name];
  });
}

/**
 * Run the configured voice pipeline for a connected call.
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {Object} dialog - SIP dialog
 * @param {string} callUuid - Unique call identifier
 * @param {Object} options - Same options as the underlying loops, plus:
 * @param {string} [options.provider] - Explicit provider name override
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function runVoicePipeline(endpoint, dialog, callUuid, options) {
  var name = (options && options.provider) || resolveProviderName(options && options.deviceConfig);

  if (name === 'classic') {
    // Classic pipeline STT/TTS are Google-backed in this fork
    var classicMissing = missingEnv(['GOOGLE_API_KEY']);
    if (classicMissing.length > 0) {
      logger.warn('Classic pipeline requires ' + classicMissing.join(', '), { callUuid: callUuid });
      return { success: false, error: classicMissing.join(', ') + ' not set' };
    }

    logger.info('Voice pipeline dispatching', { callUuid: callUuid, provider: 'classic' });
    // Lazy require: these modules have require-time side effects (audio dir,
    // cleanup timers) that realtime-only deployments should not pay for
    var { runConversationLoop } = require('./conversation-loop');
    await runConversationLoop(endpoint, dialog, callUuid, {
      audioForkServer: options.audioForkServer,
      whisperClient: require('./whisper-client'),
      claudeBridge: require('./claude-bridge'),
      ttsService: require('./tts-service'),
      wsPort: options.wsPort,
      deviceConfig: options.deviceConfig,
      callerExtension: options.callerExtension,
      initialContext: options.initialContext,
      skipGreeting: options.skipGreeting
    });
    return { success: true };
  }

  var provider = providers.get(name);
  if (!provider) {
    logger.error('Unknown voice provider', {
      callUuid: callUuid,
      provider: name,
      available: providers.names().concat(['classic']).join(', ')
    });
    return { success: false, error: 'Unknown voice provider: ' + name };
  }

  var missing = missingEnv(provider.requiredEnv);
  if (missing.length > 0) {
    logger.warn(provider.name + ' provider requires ' + missing.join(', '), { callUuid: callUuid });
    return { success: false, error: missing.join(', ') + ' not set' };
  }

  logger.info('Voice pipeline dispatching', { callUuid: callUuid, provider: provider.name });
  return runRealtimeVoiceLoop(provider, endpoint, dialog, callUuid, options);
}

module.exports = { runVoicePipeline, resolveProviderName };
