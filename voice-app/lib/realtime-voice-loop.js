/**
 * Realtime Voice Conversation Loop — OpenClaw Relay Mode
 *
 * A realtime voice provider (Gemini Live, OpenAI Realtime, ...) handles
 * speech recognition and speech synthesis via a provider descriptor.
 * OpenClaw provides the AI brain (context, memory, tools).
 *
 * Supports mid-call mode switching:
 *   RELAY: Caller → provider STT → OpenClaw → provider TTS → Caller
 *   DIRECT (default): Caller → provider answers natively (sub-second, no context)
 *
 * Trigger words: "direct mode"/"fast mode" and "brain mode"/"smart mode"
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var WaveFile = require('wavefile').WaveFile;
var logger = require('./logger');
var openclawBridge = require('./openclaw-bridge');
var openclawConfig = require('./openclaw-config');
var claudeBridge = require('./claude-bridge');
var prompts = require('./prompts');

var MEDIA_HOST = require('./media-host');
var HTTP_PORT = process.env.HTTP_PORT || 3000;

var STATE_LISTENING = 'LISTENING';
var STATE_SPEAKING = 'SPEAKING';

// Trigger phrases for mode switching (case-insensitive)
var DIRECT_MODE_TRIGGERS = ['direct mode', 'fast mode', 'quick mode', 'מצב ישיר', 'מצב מהיר'];
var RELAY_MODE_TRIGGERS = ['brain mode', 'smart mode', 'clawdbot', 'מצב מלא', 'מצב חכם'];

// Tool offered to the model in direct mode so it can end the call itself
var END_CALL_TOOL = {
  name: 'end_call',
  description: 'Hang up the phone call. You MUST call this immediately after ' +
    'saying your farewell whenever the caller signals the conversation is ' +
    'over, in whatever language they speak: saying goodbye, asking you to ' +
    'hang up, or declining further help when you offer it. Never say ' +
    'goodbye or a farewell of any kind without also calling this tool in ' +
    'the same turn.'
};

// Appended to the system prompt whenever the end_call tool is available, so
// hangup behavior does not depend on each operator's own prompt wording
var END_CALL_PROMPT =
  'IMPORTANT: You have an end_call tool that hangs up the call. The caller may ' +
  'speak any language. Whenever the caller indicates the conversation is over ' +
  '(saying goodbye, declining further help, or asking you to hang up), you must ' +
  'say a brief farewell and then call end_call. Ending your farewell without ' +
  'calling end_call is an error.';

// Marker a relay backend can include in its reply to end the call
var HANGUP_MARKER = /\[HANGUP\]/gi;

/**
 * Detect and strip the [HANGUP] marker from a relay backend response.
 * @param {string} text
 * @returns {{ text: string, hangup: boolean }}
 */
function extractHangupMarker(text) {
  if (typeof text !== 'string' || !HANGUP_MARKER.test(text)) {
    HANGUP_MARKER.lastIndex = 0;
    return { text: text, hangup: false };
  }
  HANGUP_MARKER.lastIndex = 0;
  return {
    text: text.replace(HANGUP_MARKER, '').replace(/\s{2,}/g, ' ').trim(),
    hangup: true
  };
}

function checkModeTrigger(transcript) {
  var lower = transcript.toLowerCase().trim();
  for (var i = 0; i < DIRECT_MODE_TRIGGERS.length; i++) {
    if (lower === DIRECT_MODE_TRIGGERS[i] || lower.indexOf(DIRECT_MODE_TRIGGERS[i]) !== -1) {
      return 'direct';
    }
  }
  for (var j = 0; j < RELAY_MODE_TRIGGERS.length; j++) {
    if (lower === RELAY_MODE_TRIGGERS[j] || lower.indexOf(RELAY_MODE_TRIGGERS[j]) !== -1) {
      return 'relay';
    }
  }
  return null;
}

function pcmToWav(pcmBuffer, sampleRate) {
  var wav = new WaveFile();
  var samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.length / 2)
  );
  wav.fromScratch(1, sampleRate, '16', samples);
  return Buffer.from(wav.toBuffer());
}

async function saveAndGetUrl(wavBuffer, audioDir, prefix) {
  var filename = prefix + '-live-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.wav';
  var filepath = path.join(audioDir, filename);
  await fs.promises.writeFile(filepath, wavBuffer);
  return 'http://' + MEDIA_HOST + ':' + HTTP_PORT + '/audio-files/' + filename;
}

/**
 * Run a voice conversation loop using a realtime voice provider as ears/mouth
 * and OpenClaw as brain
 *
 * @param {Object} provider - Provider descriptor (see lib/providers/index.js)
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {Object} dialog - SIP dialog
 * @param {string} callUuid - Unique call identifier
 * @param {Object} options - Configuration options
 * @param {Object} options.audioForkServer - WebSocket audio fork server
 * @param {number} [options.wsPort=3001] - WebSocket port for audio fork
 * @param {Object} [options.deviceConfig] - Device configuration
 * @param {string} [options.initialContext] - Context for outbound calls
 * @param {boolean} [options.skipGreeting=false] - Skip greeting for outbound calls
 * @param {string} [options.callerExtension] - Caller's extension number
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function runRealtimeVoiceLoop(provider, endpoint, dialog, callUuid, options) {
  var audioForkServer = options.audioForkServer;
  var wsPort = options.wsPort || 3001;
  var deviceConfig = options.deviceConfig || null;
  var initialContext = options.initialContext || null;
  var skipGreeting = options.skipGreeting || false;
  var callerExtension = options.callerExtension || null;

  var audioDir = process.env.AUDIO_DIR || '/tmp/voice-audio';

  // Look up OpenClaw route for this caller, fall back to Claude API bridge
  var openclawRoute = openclawConfig.getRouteForCaller(callerExtension);
  if (!openclawRoute) {
    openclawRoute = openclawConfig.getDefault();
  }
  var useClaudeBridge = !openclawRoute;
  if (useClaudeBridge) {
    logger.info('No OpenClaw config, using Claude API bridge', { callUuid: callUuid, callerExtension: callerExtension });
  }

  var voiceId = (deviceConfig && deviceConfig.voiceId) ? deviceConfig.voiceId : provider.defaultVoice;
  if (provider.knownVoices && provider.knownVoices.indexOf(voiceId) === -1) {
    logger.warn('Voice not supported by provider, using default', {
      callUuid: callUuid,
      provider: provider.name,
      voiceId: voiceId,
      defaultVoice: provider.defaultVoice
    });
    voiceId = provider.defaultVoice;
  }

  // Audio math derived from the provider's output stream (pcm16 = 2 bytes/sample)
  var bytesPerSecond = provider.outputSampleRate * 2;

  var session = null;
  var audioSession = null;
  var forkRunning = false;
  var callActive = true;
  var flushTimer = null;
  var state = STATE_LISTENING;
  var bargedIn = false;
  var greetingActive = false;
  var inputTranscriptBuffer = '';
  var queryInProgress = false;
  var queryDebounceTimer = null;
  var directMode = true;

  // Assistant-initiated hangup (end_call tool / [HANGUP] relay marker)
  var allowHangup = !deviceConfig || deviceConfig.allowHangup !== false;
  var hangupRequested = false;
  var hangupToolCalled = false;
  var hangupTimer = null;
  var finishTimer = null;
  var endCallResolve = null;
  // Absolute time when the last audio byte sent to the fork finishes playing
  var playbackEndsAt = 0;

  function doHangup() {
    if (!callActive) return;
    logger.info('Assistant ended the call', { callUuid: callUuid });
    // drachtio only emits the dialog 'destroy' event for remote hangups, so
    // end the loop ourselves after sending the BYE
    callActive = false;
    dialog.destroy().catch(function() {});
    if (endCallResolve) endCallResolve();
  }

  function requestHangup() {
    if (hangupRequested) return;
    hangupRequested = true;
    // Safety net: hang up even if the farewell never finishes cleanly
    hangupTimer = setTimeout(doHangup, 8000);
  }

  // Hang up once the farewell audio has fully drained to the caller
  function maybeFinishHangup() {
    if (!hangupRequested || !callActive) return;
    // After an end_call tool call the turn never completes (the provider
    // waits for the tool response round trip), so only wait for the state
    // flip when the hangup came from a relay [HANGUP] marker
    if (state === STATE_SPEAKING && !hangupToolCalled) return;
    if (audioQueue.length > 0 || audioDraining) return;
    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
    // The pacing throttle sends ahead of real time, so audio can still be
    // playing at the caller when the queue drains. Wait until the last sent
    // byte has actually played out, then re-check in case more farewell
    // audio arrived in the meantime.
    var waitMs = Math.max(0, playbackEndsAt - Date.now()) + 500;
    finishTimer = setTimeout(function() {
      finishTimer = null;
      if (!callActive) return;
      if (audioQueue.length > 0 || audioDraining || Date.now() < playbackEndsAt) {
        maybeFinishHangup();
        return;
      }
      doHangup();
    }, waitMs);
  }

  var audioAccumulator = Buffer.alloc(0);
  var isPlaying = false;
  var playQueue = [];

  var onDialogDestroy = function() {
    callActive = false;
    logger.info('Call ended (dialog destroyed)', { callUuid: callUuid });
  };

  var cfg = prompts.load();
  var systemPrompt = directMode
    ? (cfg.directModeSystemPrompt || 'You are a helpful voice assistant. Answer questions naturally and conversationally. Be concise.')
    : (cfg.relayModeSystemPrompt || 'You are a voice relay interface. Only speak the exact text messages you receive.');
  if (allowHangup && directMode) {
    systemPrompt += '\n\n' + END_CALL_PROMPT;
  }
  var greetingText = cfg.greeting || 'Greet the user warmly and briefly.';

  async function flushAudio() {
    flushTimer = null;
    if (audioAccumulator.length < bytesPerSecond * 0.02) return; // ~20ms of audio

    var pcmData = audioAccumulator;
    audioAccumulator = Buffer.alloc(0);

    var wavBuf = pcmToWav(pcmData, provider.outputSampleRate);
    var url = await saveAndGetUrl(wavBuf, audioDir, provider.name);
    playQueue.push(url);
    processPlayQueue();
  }

  async function processPlayQueue() {
    if (isPlaying || playQueue.length === 0 || !callActive) return;
    isPlaying = true;
    while (callActive) {
      // Wait for at least one item, or break if nothing comes
      if (playQueue.length === 0) {
        // Wait briefly for more audio to arrive before stopping
        await new Promise(function(r) { setTimeout(r, 100); });
        if (playQueue.length === 0) break;
      }
      var url = playQueue.shift();
      try {
        await endpoint.play(url);
      } catch (e) {
        if (!callActive) break;
      }
    }
    isPlaying = false;
  }

  function clearAudioState() {
    playQueue.length = 0;
    audioAccumulator = Buffer.alloc(0);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queryDebounceTimer) {
      clearTimeout(queryDebounceTimer);
      queryDebounceTimer = null;
    }
  }

  function fireOpenClawQuery() {
    var transcript = inputTranscriptBuffer.trim();
    inputTranscriptBuffer = '';

    // Check for mode switch trigger
    var modeTrigger = checkModeTrigger(transcript);
    if (modeTrigger === 'direct') {
      logger.info('Switching to DIRECT mode', { callUuid: callUuid, trigger: transcript });
      directMode = true;
      session.sendText('You are now in direct mode. Answer the user\'s questions directly and conversationally. Be helpful and natural.');
      state = STATE_SPEAKING;
      return;
    }
    if (modeTrigger === 'relay') {
      logger.info('Switching to RELAY mode', { callUuid: callUuid, trigger: transcript });
      directMode = false;
      session.sendText('You are now in relay mode. Stop answering questions. Only speak the exact text messages you receive.');
      state = STATE_SPEAKING;
      return;
    }

    if (!transcript || transcript.length < 2) {
      logger.info('Empty or too short transcript, keep listening', { callUuid: callUuid });
      return;
    }

    if (queryInProgress) return;
    queryInProgress = true;

    logger.info('User said', { callUuid: callUuid, transcript: transcript });

    (async function() {
      try {
        var response;
        if (useClaudeBridge) {
          response = await claudeBridge.query(transcript, {
            callId: callUuid,
            devicePrompt: deviceConfig ? deviceConfig.prompt : null,
            callerExtension: callerExtension
          });
        } else {
          response = await openclawBridge.query(transcript, openclawRoute);
        }

        if (!callActive) { queryInProgress = false; return; }

        logger.info('AI responded', { callUuid: callUuid, response: response });

        // The relay backend can end the call with a [HANGUP] marker
        var hangupCheck = extractHangupMarker(response);
        if (hangupCheck.hangup && allowHangup) {
          logger.info('Relay backend requested hangup', { callUuid: callUuid });
          requestHangup();
        }

        session.sendText(hangupCheck.text || 'Goodbye!');
        state = STATE_SPEAKING;
        queryInProgress = false;

      } catch (err) {
        logger.error('AI query failed', { callUuid: callUuid, error: err.message });
        if (callActive) {
          session.sendText(err.message);
          state = STATE_SPEAKING;
        }
        queryInProgress = false;
      }
    })();
  }

  try {
    logger.info('Realtime voice OpenClaw relay starting', {
      callUuid: callUuid,
      provider: provider.name,
      skipGreeting: skipGreeting,
      hasInitialContext: !!initialContext,
      voiceId: voiceId,
      callerExtension: callerExtension,
      backend: useClaudeBridge ? 'claude-api' : openclawRoute.url,
      directMode: directMode
    });

    dialog.on('destroy', onDialogDestroy);

    // 1. Connect the realtime voice session
    session = provider.createSession({
      systemPrompt: systemPrompt,
      voiceName: voiceId,
      tools: allowHangup ? [END_CALL_TOOL] : undefined
    });

    try {
      await session.connect();
      logger.info('Realtime voice session connected', { callUuid: callUuid, provider: provider.name });
    } catch (err) {
      logger.error('Realtime voice connection failed', { callUuid: callUuid, provider: provider.name, error: err.message });
      return { success: false, error: err.message };
    }

    // 2. Greeting or initial context via provider TTS
    if (!skipGreeting && callActive) {
      session.sendText(directMode ? greetingText : 'Hello! How can I help you?');
      state = STATE_SPEAKING;
      greetingActive = true;
      logger.info('Greeting sent to provider', { callUuid: callUuid });
    }

    if (initialContext && callActive) {
      session.sendText(initialContext);
      state = STATE_SPEAKING;
      logger.info('Initial context sent to provider', { callUuid: callUuid });
    }

    if (!callActive) {
      logger.info('Call ended before audio fork could start', { callUuid: callUuid });
      return { success: true };
    }

    // 3. Start audio fork
    var wsUrl = 'ws://' + MEDIA_HOST + ':' + wsPort + '/' + encodeURIComponent(callUuid);

    var sessionPromise;
    try {
      sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });
    } catch (err) {
      logger.warn('Failed to set up session expectation', { callUuid: callUuid, error: err.message });
      return { success: true };
    }

    await endpoint.forkAudioStart({
      wsUrl: wsUrl,
      mixType: 'mono',
      sampling: (provider.inputSampleRate / 1000) + 'k',
      bidirectionalAudio: {
        enabled: 'true',
        streaming: 'true',
        sampleRate: String(provider.outputSampleRate)
      }
    });
    forkRunning = true;

    try {
      audioSession = await sessionPromise;
      logger.info('Audio fork connected', { callUuid: callUuid });

      // Instant barge-in: stop sending audio the moment caller speaks
      var bargeInTimer = null;
      audioSession.on('speechStart', function() {
        if (state === STATE_SPEAKING && !greetingActive) {
          // Wait 300ms of sustained speech before flushing, avoids "hm", breaths, etc.
          bargeInTimer = setTimeout(function() {
            bargeInTimer = null;
            if (state === STATE_SPEAKING) {
              logger.info('Local VAD barge-in', { callUuid: callUuid });
              endpoint.api('uuid_audio_fork', endpoint.uuid + ' stop_play').catch(function() {});
            }
          }, 300);
        }
      });
      // Cancel pending barge-in if speech stops quickly
      // (speech too short to be a real interruption)
      var origResetUtterance = audioSession._resetUtterance.bind(audioSession);
      audioSession._resetUtterance = function() {
        if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null; }
        origResetUtterance();
      };
    } catch (err) {
      logger.warn('Audio fork session failed', { callUuid: callUuid, error: err.message });
      if (audioForkServer.cancelExpectation) {
        audioForkServer.cancelExpectation(callUuid);
      }
      return { success: true };
    }

    // 4. Pipe raw audio from caller to the provider session
    if (audioSession.ws) {
      audioSession.ws.on('message', function(data) {
        if (Buffer.isBuffer(data)) {
          session.sendAudio(data);
        } else if (data instanceof ArrayBuffer) {
          session.sendAudio(Buffer.from(data));
        }
      });
    }

    // 5. Handle inputTranscription (what the user said) — debounce OpenClaw query
    session.on('inputTranscription', function(text) {
      if (state !== STATE_LISTENING) return;

      inputTranscriptBuffer += text;
      logger.debug('Input transcript chunk', { callUuid: callUuid, text: text, directMode: directMode });

      if (directMode) {
        // In direct mode, only check for mode switch triggers
        // The provider handles the response natively — no OpenClaw query needed
        return;
      }

      if (queryInProgress) return;

      // Debounce: fire OpenClaw query 1.5s after last transcript chunk
      if (queryDebounceTimer) {
        clearTimeout(queryDebounceTimer);
      }
      queryDebounceTimer = setTimeout(function() {
        queryDebounceTimer = null;
        fireOpenClawQuery();
      }, 1500);
    });

    // 6. Handle provider audio output, throttled to the real-time rate
    var audioSendStart = null;
    var audioBytesSent = 0;
    var audioQueue = [];
    var audioDraining = false;

    function drainAudioQueue() {
      if (audioDraining || audioQueue.length === 0) return;
      audioDraining = true;

      function sendNext() {
        if (bargedIn || !callActive || audioQueue.length === 0) {
          audioDraining = false;
          audioQueue.length = 0;
          audioSendStart = null;
          audioBytesSent = 0;
          maybeFinishHangup();
          return;
        }

        var chunk = audioQueue.shift();
        if (audioSession) {
          audioSession.sendAudio(chunk);
        }
        audioBytesSent += chunk.length;

        if (!audioSendStart) audioSendStart = Date.now();
        playbackEndsAt = audioSendStart + (audioBytesSent / bytesPerSecond) * 1000;

        // How far ahead are we? (bytes / bytesPerSecond = seconds of audio)
        var elapsedMs = Date.now() - audioSendStart;
        var sentMs = (audioBytesSent / bytesPerSecond) * 1000;
        var aheadMs = sentMs - elapsedMs;

        if (aheadMs > 60 && audioQueue.length > 0) {
          // We're ahead of real-time, wait before sending more
          setTimeout(sendNext, aheadMs - 40);
        } else {
          // Send immediately
          if (audioQueue.length > 0) {
            setImmediate(sendNext);
          } else {
            audioDraining = false;
            maybeFinishHangup();
          }
        }
      }

      sendNext();
    }

    session.on('audio', function(pcm) {
      if (state === STATE_SPEAKING || (state === STATE_LISTENING && directMode)) {
        // In SPEAKING state: always play audio (relay response or direct response)
        // In LISTENING+directMode: the provider is answering directly, play its audio
        if (state === STATE_LISTENING && directMode) {
          state = STATE_SPEAKING;
        }
        audioQueue.push(pcm);
        drainAudioQueue();
      }
      // In LISTENING state (relay mode), discard all provider audio
    });

    // 7. Handle turnComplete
    session.on('turnComplete', function() {
      bargedIn = false;
      greetingActive = false;
      if (state === STATE_LISTENING) {
        if (directMode) {
          // In direct mode, only check for mode switch back to relay
          var pendingText = inputTranscriptBuffer.trim();
          inputTranscriptBuffer = '';
          if (pendingText) {
            var trigger = checkModeTrigger(pendingText);
            if (trigger === 'relay') {
              logger.info('Switching to RELAY mode', { callUuid: callUuid, trigger: pendingText });
              directMode = false;
              session.sendText('You are now in relay mode. Stop answering questions. Only speak the exact text messages you receive.');
              state = STATE_SPEAKING;
            }
          }
        } else {
          // Relay mode: fire the OpenClaw query immediately if we have transcript
          if (queryDebounceTimer) {
            clearTimeout(queryDebounceTimer);
            queryDebounceTimer = null;
          }
          if (inputTranscriptBuffer.trim().length >= 2 && !queryInProgress) {
            fireOpenClawQuery();
          }
        }
        maybeFinishHangup();

      } else if (state === STATE_SPEAKING) {
        // Provider finished speaking — flush remaining audio
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (audioAccumulator.length > 0) {
          flushAudio();
        }

        logger.info('Provider finished speaking, switching to listening', { callUuid: callUuid });
        state = STATE_LISTENING;
        inputTranscriptBuffer = '';
        maybeFinishHangup();
      }
    });

    // 8. Handle barge-in
    session.on('interrupted', function() {
      logger.info('Barge-in detected', { callUuid: callUuid });
      clearAudioState();
      bargedIn = true;
      if (queryDebounceTimer) {
        clearTimeout(queryDebounceTimer);
        queryDebounceTimer = null;
      }
      endpoint.api('uuid_break', endpoint.uuid).catch(function() {});
      state = STATE_LISTENING;
      inputTranscriptBuffer = '';
    });

    // 9. Handle model tool calls (end_call)
    session.on('toolCall', function(call) {
      if (call.name === 'end_call' && allowHangup) {
        logger.info('Model requested hangup via end_call', { callUuid: callUuid });
        if (typeof session.sendToolResponse === 'function') {
          session.sendToolResponse(call.id, call.name, { result: 'ok, ending the call' });
        }
        hangupToolCalled = true;
        requestHangup();
        maybeFinishHangup();
      } else {
        logger.warn('Unhandled tool call', { callUuid: callUuid, name: call.name });
        if (typeof session.sendToolResponse === 'function') {
          session.sendToolResponse(call.id, call.name, { error: 'unknown tool' });
        }
      }
    });

    // 10. Handle provider errors
    session.on('error', function(err) {
      logger.error('Realtime voice error', { callUuid: callUuid, provider: provider.name, error: err.message });
    });

    // 11. Log what the provider speaks
    session.on('transcript', function(text) {
      logger.info('Provider spoke', { callUuid: callUuid, text: text });
    });

    // 12. Wait for call to end
    await new Promise(function(resolve) {
      endCallResolve = resolve;

      dialog.once('destroy', function() {
        callActive = false;
        resolve();
      });

      session.on('error', function(err) {
        if (err.message && err.message.indexOf('Max reconnect attempts') !== -1) {
          logger.error('Realtime voice session permanently failed', { callUuid: callUuid, provider: provider.name });
          resolve();
        }
      });

      session.on('close', function() {
        if (!callActive) return;
        logger.info('Realtime voice session closed', { callUuid: callUuid, provider: provider.name });
        resolve();
      });

      if (!callActive) {
        resolve();
      }
    });

    logger.info('Realtime voice relay ended normally', { callUuid: callUuid, provider: provider.name });
    return { success: true };

  } catch (error) {
    logger.error('Realtime voice loop error', {
      callUuid: callUuid,
      provider: provider.name,
      error: error.message,
      stack: error.stack
    });
    return { success: false, error: error.message };

  } finally {
    logger.info('Realtime voice loop cleanup', { callUuid: callUuid, provider: provider.name });

    dialog.off('destroy', onDialogDestroy);

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (queryDebounceTimer) {
      clearTimeout(queryDebounceTimer);
      queryDebounceTimer = null;
    }

    if (hangupTimer) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }

    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }

    if (session) {
      try { session.close(); } catch (e) {}
    }

    if (audioForkServer.cancelExpectation) {
      audioForkServer.cancelExpectation(callUuid);
    }

    if (forkRunning) {
      try { await endpoint.forkAudioStop(); } catch (e) {}
    }
  }
}

module.exports = { runRealtimeVoiceLoop, extractHangupMarker, END_CALL_TOOL, END_CALL_PROMPT };
