/**
 * OpenAI Realtime Session Tests
 *
 * Tests the server-event mapping onto the provider-agnostic session event
 * surface by driving _handleMessage directly. No network required.
 *
 * Run with: node --test test/openai-realtime.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert');
var { OpenAIRealtimeSession } = require('../lib/providers/openai-realtime');

function createTestSession() {
  return new OpenAIRealtimeSession({
    apiKey: 'test-key-not-real',
    systemPrompt: 'Test instructions',
    voiceName: 'marin'
  });
}

describe('OpenAIRealtimeSession', function () {
  it('requires an apiKey', function () {
    assert.throws(function () {
      new OpenAIRealtimeSession({});
    }, /apiKey/);
  });

  describe('_buildSessionUpdate', function () {
    it('configures a realtime audio session', function () {
      var session = createTestSession();
      var msg = session._buildSessionUpdate();

      assert.strictEqual(msg.type, 'session.update');
      assert.strictEqual(msg.session.type, 'realtime');
      assert.strictEqual(msg.session.instructions, 'Test instructions');
      assert.deepStrictEqual(msg.session.output_modalities, ['audio']);
      assert.deepStrictEqual(msg.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
      assert.deepStrictEqual(msg.session.audio.output.format, { type: 'audio/pcm', rate: 24000 });
      assert.strictEqual(msg.session.audio.output.voice, 'marin');
      assert.strictEqual(msg.session.audio.input.turn_detection.type, 'server_vad');
      assert.ok(msg.session.audio.input.transcription.model);
    });
  });

  describe('_handleMessage', function () {
    it('emits audio buffers from response.output_audio.delta', function () {
      var session = createTestSession();
      var pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      var received = null;
      session.on('audio', function (buf) { received = buf; });

      session._handleMessage({ type: 'response.output_audio.delta', delta: pcm.toString('base64') });

      assert.ok(received);
      assert.ok(received.equals(pcm));
    });

    it('emits transcript chunks from output transcript deltas', function () {
      var session = createTestSession();
      var chunks = [];
      session.on('transcript', function (text) { chunks.push(text); });

      session._handleMessage({ type: 'response.output_audio_transcript.delta', delta: 'Hello ' });
      session._handleMessage({ type: 'response.output_audio_transcript.delta', delta: 'world' });

      assert.deepStrictEqual(chunks, ['Hello ', 'world']);
    });

    it('emits inputTranscription only for completed transcripts', function () {
      var session = createTestSession();
      var chunks = [];
      session.on('inputTranscription', function (text) { chunks.push(text); });

      session._handleMessage({ type: 'conversation.item.input_audio_transcription.delta', delta: 'partial' });
      session._handleMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'full utterance' });

      assert.deepStrictEqual(chunks, ['full utterance']);
    });

    it('emits interrupted on speech_started only while a response is active', function () {
      var session = createTestSession();
      var interruptions = 0;
      session.on('interrupted', function () { interruptions++; });

      // No active response: user starting to speak is not a barge-in
      session._handleMessage({ type: 'input_audio_buffer.speech_started' });
      assert.strictEqual(interruptions, 0);

      session._handleMessage({ type: 'response.created' });
      session._handleMessage({ type: 'input_audio_buffer.speech_started' });
      assert.strictEqual(interruptions, 1);

      // After the response finishes, speech is again not a barge-in
      session._handleMessage({ type: 'response.done' });
      session._handleMessage({ type: 'input_audio_buffer.speech_started' });
      assert.strictEqual(interruptions, 1);
    });

    it('emits turnComplete on response.done', function () {
      var session = createTestSession();
      var turns = 0;
      session.on('turnComplete', function () { turns++; });

      session._handleMessage({ type: 'response.created' });
      session._handleMessage({ type: 'response.done' });

      assert.strictEqual(turns, 1);
    });

    it('emits error events for server errors', function () {
      var session = createTestSession();
      var received = null;
      session.on('error', function (err) { received = err; });

      session._handleMessage({ type: 'error', error: { message: 'something broke' } });

      assert.ok(received);
      assert.match(received.message, /something broke/);
    });

    it('ignores unknown event types', function () {
      var session = createTestSession();
      assert.doesNotThrow(function () {
        session._handleMessage({ type: 'rate_limits.updated' });
        session._handleMessage({ type: 'response.output_text.delta', delta: 'x' });
      });
    });
  });
});

describe('OpenAIRealtimeSession tools', function () {
  function createToolSession() {
    return new OpenAIRealtimeSession({
      apiKey: 'test-key-not-real',
      tools: [{ name: 'end_call', description: 'End the phone call' }]
    });
  }

  it('includes tools in the session update when configured', function () {
    var msg = createToolSession()._buildSessionUpdate();
    assert.strictEqual(msg.session.tools.length, 1);
    assert.deepStrictEqual(msg.session.tools[0], {
      type: 'function',
      name: 'end_call',
      description: 'End the phone call',
      parameters: { type: 'object', properties: {} }
    });
    assert.strictEqual(msg.session.tool_choice, 'auto');
  });

  it('omits tools from the session update by default', function () {
    var msg = new OpenAIRealtimeSession({ apiKey: 'test-key-not-real' })._buildSessionUpdate();
    assert.strictEqual(msg.session.tools, undefined);
    assert.strictEqual(msg.session.tool_choice, undefined);
  });

  it('emits toolCall for completed function_call output items', function () {
    var session = createToolSession();
    var calls = [];
    session.on('toolCall', function (call) { calls.push(call); });

    session._handleMessage({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'end_call', call_id: 'call_1', arguments: '{}' }
    });
    session._handleMessage({
      type: 'response.output_item.done',
      item: { type: 'message', content: [] }
    });

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { id: 'call_1', name: 'end_call', args: {} });
  });
});
