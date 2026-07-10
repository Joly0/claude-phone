/**
 * OpenAI Realtime Session
 * Manages a WebSocket connection to the OpenAI Realtime API for real-time
 * bidirectional audio streaming (speech-to-speech).
 *
 * Sends PCM 16kHz audio (upsampled to the API's 24kHz), receives PCM 24kHz
 * audio, and emits the same event surface as GeminiLiveSession so the
 * realtime voice loop can drive either provider.
 *
 * Works with gpt-realtime-* models today; when OpenAI opens up the GPT-Live
 * models (gpt-live-1) on this API, set OPENAI_REALTIME_MODEL to switch.
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const logger = require('../logger');
const { createPcmResampler } = require('../audio-utils');

const DEFAULT_MODEL = 'gpt-realtime-2.1';
const DEFAULT_VOICE = 'marin';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const API_SAMPLE_RATE = 24000;
const INPUT_SAMPLE_RATE = 16000;
const SETUP_TIMEOUT_MS = 10000;
const MAX_RECONNECT_ATTEMPTS = 3;

class OpenAIRealtimeSession extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - OpenAI API key (required)
   * @param {string} [opts.model] - Realtime model identifier
   * @param {string} [opts.systemPrompt] - Session instructions
   * @param {string} [opts.voiceName] - OpenAI realtime voice name
   * @param {string} [opts.transcribeModel] - Input transcription model
   */
  constructor({ apiKey, model, systemPrompt, voiceName, transcribeModel }) {
    super();

    if (!apiKey) {
      throw new Error('OpenAIRealtimeSession requires an apiKey');
    }

    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.systemPrompt = systemPrompt || '';
    this.voiceName = voiceName || DEFAULT_VOICE;
    this.transcribeModel = transcribeModel || DEFAULT_TRANSCRIBE_MODEL;

    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
    this._reconnectTimer = null;
    this._reconnecting = false;
    this._sessionReady = false;
    this._responseActive = false;
    this._resampler = null;
  }

  /**
   * Build the session.update payload that configures audio formats,
   * transcription and turn detection. Separate method for unit testing.
   * @returns {Object}
   */
  _buildSessionUpdate() {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.systemPrompt,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: API_SAMPLE_RATE },
            transcription: { model: this.transcribeModel },
            turn_detection: { type: 'server_vad', interrupt_response: true }
          },
          output: {
            format: { type: 'audio/pcm', rate: API_SAMPLE_RATE },
            voice: this.voiceName
          }
        }
      }
    };
  }

  /**
   * Open WebSocket to the OpenAI Realtime API and configure the session.
   * Resolves once session.updated confirms the configuration is applied,
   * so sendText/sendAudio are safe immediately after.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      var url = 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(this.model);

      logger.info('OpenAI Realtime connecting', { model: this.model, voice: this.voiceName });

      var ws;
      try {
        ws = new WebSocket(url, {
          headers: { 'Authorization': 'Bearer ' + this.apiKey }
        });
      } catch (err) {
        logger.error('OpenAI Realtime WebSocket creation failed', { error: err.message });
        reject(err);
        return;
      }

      this.ws = ws;
      this._sessionReady = false;
      this._responseActive = false;

      var settled = false;

      var setupTimer = setTimeout(function () {
        if (!this._sessionReady) {
          logger.error('OpenAI Realtime setup timed out', { timeoutMs: SETUP_TIMEOUT_MS });
          ws.close();
          if (!settled) {
            settled = true;
            reject(new Error('OpenAI Realtime setup timed out after ' + SETUP_TIMEOUT_MS + 'ms'));
          }
        }
      }.bind(this), SETUP_TIMEOUT_MS);

      ws.on('open', function () {
        logger.info('OpenAI Realtime WebSocket opened, waiting for session.created');
      });

      ws.on('message', function (rawData) {
        var data;
        try {
          data = JSON.parse(rawData.toString());
        } catch (err) {
          logger.warn('OpenAI Realtime received unparseable message', { error: err.message });
          return;
        }

        // Handshake: configure the session, then wait for confirmation
        if (data.type === 'session.created') {
          try {
            ws.send(JSON.stringify(this._buildSessionUpdate()));
          } catch (err) {
            logger.error('OpenAI Realtime failed to send session.update', { error: err.message });
          }
          return;
        }

        if (data.type === 'session.updated' && !this._sessionReady) {
          this._sessionReady = true;
          this.connected = true;
          this.reconnectAttempts = 0;
          clearTimeout(setupTimer);

          logger.info('OpenAI Realtime session configured');
          this.emit('ready');

          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (data.type === 'error' && !this._sessionReady) {
          var setupErr = new Error('OpenAI Realtime setup error: ' + (data.error && data.error.message ? data.error.message : 'unknown'));
          logger.error('OpenAI Realtime setup failed', { error: setupErr.message });
          clearTimeout(setupTimer);
          if (!settled) {
            settled = true;
            ws.close();
            reject(setupErr);
          }
          return;
        }

        if (this._sessionReady) {
          this._handleMessage(data);
        }
      }.bind(this));

      ws.on('error', function (err) {
        logger.error('OpenAI Realtime WebSocket error', { error: err.message });

        if (!settled) {
          settled = true;
          clearTimeout(setupTimer);
          reject(err);
          return;
        }

        this.emit('error', err);
      }.bind(this));

      ws.on('close', function (code, reason) {
        var wasConnected = this.connected;
        this.connected = false;
        this._sessionReady = false;
        this._responseActive = false;
        this._resampler = null;

        logger.info('OpenAI Realtime WebSocket closed', {
          code: code,
          reason: reason ? reason.toString() : '',
          wasConnected: wasConnected
        });

        if (!settled) {
          settled = true;
          clearTimeout(setupTimer);
          reject(new Error('OpenAI Realtime WebSocket closed before setup complete (code ' + code + ')'));
          return;
        }

        this.emit('close');

        // Attempt reconnect if the connection was established and dropped unexpectedly
        if (wasConnected && code !== 1000) {
          this._reconnect();
        }
      }.bind(this));
    });
  }

  /**
   * Send raw PCM audio to OpenAI, upsampling to the API rate.
   * @param {Buffer} pcmBuffer - 16kHz 16-bit mono PCM (little-endian)
   */
  sendAudio(pcmBuffer) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this._resampler) {
      this._resampler = createPcmResampler();
    }
    var pcm24k = this._resampler.resample(pcmBuffer, INPUT_SAMPLE_RATE, API_SAMPLE_RATE);
    if (pcm24k.length === 0) {
      return;
    }

    var msg = JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcm24k.toString('base64')
    });

    try {
      this.ws.send(msg);
    } catch (err) {
      logger.warn('OpenAI Realtime failed to send audio', { error: err.message, bytes: pcmBuffer.length });
    }
  }

  /**
   * Send a text message as a user conversation item and request a response.
   * Used for greetings, outbound call context, and relay-mode answers.
   * @param {string} text
   */
  sendText(text) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      // Server VAD may have auto-started a response; creating another while
      // one is active is a protocol error, so cancel it first
      if (this._responseActive) {
        this.ws.send(JSON.stringify({ type: 'response.cancel' }));
      }

      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: text }]
        }
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
      logger.info('OpenAI Realtime sent text input', { length: text.length });
    } catch (err) {
      logger.warn('OpenAI Realtime failed to send text', { error: err.message });
    }
  }

  /**
   * Close the WebSocket connection cleanly.
   */
  close() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this.connected = false;
    this._sessionReady = false;
    this._reconnecting = false;
    this._responseActive = false;
    this._resampler = null;
    this.reconnectAttempts = 0;

    if (this.ws) {
      try {
        this.ws.close(1000, 'Client closing');
      } catch (err) {
        logger.warn('OpenAI Realtime error during close', { error: err.message });
      }
      this.ws = null;
    }

    logger.info('OpenAI Realtime session closed');
  }

  /**
   * Parse and dispatch an incoming Realtime API server event, mapping it
   * onto the provider-agnostic session event surface.
   * @param {Object} data - Parsed JSON server event
   * @private
   */
  _handleMessage(data) {
    switch (data.type) {
      case 'response.created':
        this._responseActive = true;
        break;

      case 'response.output_audio.delta':
        if (data.delta) {
          var pcm24 = Buffer.from(data.delta, 'base64');
          logger.debug('OpenAI Realtime audio chunk', { bytes: pcm24.length });
          this.emit('audio', pcm24);
        }
        break;

      case 'response.output_audio_transcript.delta':
        if (data.delta) {
          logger.debug('OpenAI Realtime transcript', { text: String(data.delta).substring(0, 100) });
          this.emit('transcript', data.delta);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Emit only the completed transcript: deltas arrive in a post-VAD
        // burst, and emitting both would duplicate text in the loop's buffer
        if (data.transcript) {
          logger.debug('OpenAI Realtime input transcript', { text: String(data.transcript).substring(0, 100) });
          this.emit('inputTranscription', data.transcript);
        }
        break;

      case 'input_audio_buffer.speech_started':
        // Only a barge-in when the model is mid-response; in LISTENING state
        // the loop treats 'interrupted' as a signal to wipe its buffers
        if (this._responseActive) {
          logger.info('OpenAI Realtime interrupted (barge-in)');
          this.emit('interrupted');
        }
        break;

      case 'response.done':
        this._responseActive = false;
        logger.debug('OpenAI Realtime turn complete');
        this.emit('turnComplete');
        break;

      case 'error':
        var errMsg = data.error && data.error.message ? data.error.message : 'unknown error';
        logger.error('OpenAI Realtime server error', { error: errMsg });
        this.emit('error', new Error(errMsg));
        break;

      default:
        break;
    }
  }

  /**
   * Attempt to reconnect with exponential backoff.
   * @private
   */
  _reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._reconnecting = false;
      var errMsg = 'Max reconnect attempts reached (' + this.maxReconnectAttempts + ')';
      logger.error('OpenAI Realtime ' + errMsg);
      this.emit('error', new Error(errMsg));
      return;
    }

    this.reconnectAttempts++;
    var delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);

    logger.info('OpenAI Realtime reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay
    });

    this._reconnectTimer = setTimeout(function () {
      this._reconnectTimer = null;

      this.connect()
        .then(function () {
          logger.info('OpenAI Realtime reconnected successfully');
          this.reconnectAttempts = 0;
          this._reconnecting = false;
        }.bind(this))
        .catch(function (err) {
          logger.error('OpenAI Realtime reconnect attempt failed', {
            attempt: this.reconnectAttempts,
            error: err.message
          });
          this._reconnecting = false;
          this._reconnect();
        }.bind(this));
    }.bind(this), delay);
  }
}

var descriptor = {
  name: 'openai',
  requiredEnv: ['OPENAI_API_KEY'],
  defaultVoice: process.env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
  knownVoices: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
  inputSampleRate: INPUT_SAMPLE_RATE,
  outputSampleRate: API_SAMPLE_RATE,
  createSession: function(opts) {
    return new OpenAIRealtimeSession({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_REALTIME_MODEL,
      systemPrompt: opts.systemPrompt,
      voiceName: opts.voiceName,
      transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL
    });
  }
};

module.exports = { OpenAIRealtimeSession, descriptor };
