/**
 * end_call Tool Behavior Evaluation
 *
 * Drives real Gemini Live sessions through scripted conversations and
 * measures whether the model calls the end_call tool when it should (and
 * doesn't when it shouldn't). Use this to iterate on the system prompt and
 * tool description with data instead of live phone calls.
 *
 * Uses the production system prompt (config/prompts.json, direct mode) and
 * the production END_CALL_TOOL definition.
 *
 * Usage:
 *   GOOGLE_API_KEY=... node eval/endcall-eval.js [runsPerScenario]
 *   (falls back to reading GOOGLE_API_KEY from ../.env)
 *
 * Note: user turns are sent as text input. Real calls use audio, where
 * adherence can differ, but prompt regressions show up here first.
 */

var fs = require('fs');
var path = require('path');
var { GeminiLiveSession } = require('../lib/gemini-live-session');
var { END_CALL_TOOL, END_CALL_PROMPT, END_CALL_NUDGE } = require('../lib/realtime-voice-loop');
var prompts = require('../lib/prompts');

var TURN_TIMEOUT_MS = 20000;

// Each scenario is a list of user turns; expectEndCall refers to the final turn
var SCENARIOS = [
  {
    name: 'explicit goodbye (German)',
    turns: ['Hallo!', 'Tschüss!'],
    expectEndCall: true
  },
  {
    name: 'hang-up request (English)',
    turns: ['Hi there!', 'Please hang up now.'],
    expectEndCall: true
  },
  {
    name: 'decline after thanks (German)',
    turns: ['Danke, das hilft mir sehr.', 'Nein danke, das war alles.'],
    expectEndCall: true
  },
  {
    name: 'decline (English)',
    turns: ['Thanks for your help!', 'No thanks, that is all.'],
    expectEndCall: true
  },
  {
    name: 'goodbye (French)',
    turns: ['Bonjour!', 'Merci, au revoir!'],
    expectEndCall: true
  },
  {
    name: 'silence nudge after decline (German)',
    turns: ['Danke, das hilft mir sehr.', 'Nein danke, das war alles.'],
    nudgeIfMissed: true,
    expectEndCall: true
  },
  {
    name: 'control: ongoing question (German)',
    turns: ['Hallo!', 'Kannst du mir sagen, was du alles kannst?'],
    expectEndCall: false
  },
  {
    name: 'control: nudge must not hang up mid-conversation (German)',
    turns: ['Hallo!', 'Kannst du mir sagen, was du alles kannst?'],
    nudgeIfMissed: true,
    expectEndCall: false
  }
];

function loadApiKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    var env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
    var match = env.match(/^GOOGLE_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch (e) { /* no .env, fall through */ }
  return null;
}

/**
 * Run one scenario: fresh session, send each user turn, wait for the model
 * to finish (turnComplete) or call a tool. Returns what happened on the
 * final turn.
 */
function runScenario(apiKey, systemPrompt, scenario) {
  return new Promise(function(resolve) {
    var session = new GeminiLiveSession({
      apiKey: apiKey,
      systemPrompt: systemPrompt,
      tools: [END_CALL_TOOL]
    });

    var turnIndex = -1;
    var sawEndCall = false;
    var spoken = [];
    var turnTimer = null;
    var done = false;

    function finish(error) {
      if (done) return;
      done = true;
      if (turnTimer) clearTimeout(turnTimer);
      try { session.close(); } catch (e) { /* already closed */ }
      resolve({ sawEndCall: sawEndCall, spoken: spoken.join(''), error: error || null });
    }

    var nudged = false;

    function nextTurn() {
      if (turnTimer) clearTimeout(turnTimer);
      turnIndex++;
      if (sawEndCall || (turnIndex >= scenario.turns.length && (!scenario.nudgeIfMissed || nudged))) {
        finish();
        return;
      }

      if (turnIndex >= scenario.turns.length) {
        // Simulate caller silence after the final turn: send the nudge the
        // voice loop would send and give the model one more chance
        nudged = true;
        session.sendText(END_CALL_NUDGE);
      } else {
        session.sendText(scenario.turns[turnIndex]);
      }

      turnTimer = setTimeout(function() {
        // A silent (no turnComplete) reaction to the nudge is a valid outcome
        if (nudged) { finish(); return; }
        finish('turn ' + (turnIndex + 1) + ' timed out');
      }, TURN_TIMEOUT_MS);
    }

    session.on('toolCall', function(call) {
      if (call.name === 'end_call') {
        sawEndCall = true;
        session.sendToolResponse(call.id, call.name, { result: 'ok' });
        finish();
      }
    });
    session.on('transcript', function(t) {
      if (turnIndex === scenario.turns.length - 1) spoken.push(t);
    });
    session.on('turnComplete', function() {
      // Give a trailing tool call a moment to arrive before the next turn
      setTimeout(nextTurn, 1500);
    });
    session.on('error', function(err) { finish(err.message); });

    session.connect().then(nextTurn).catch(function(err) {
      finish('connect failed: ' + err.message);
    });
  });
}

async function main() {
  var apiKey = loadApiKey();
  if (!apiKey) {
    console.error('GOOGLE_API_KEY not set and not found in ../.env');
    process.exit(2);
  }

  var runs = parseInt(process.argv[2], 10) || 3;
  var cfg = prompts.load();
  var systemPrompt = (cfg.directModeSystemPrompt ||
    'You are a helpful voice assistant. Answer questions naturally and conversationally. Be concise.') +
    '\n\n' + END_CALL_PROMPT;

  console.log('end_call evaluation: ' + runs + ' run(s) per scenario');
  console.log('system prompt: ' + systemPrompt.substring(0, 120) + '...\n');

  var failures = 0;

  for (var s = 0; s < SCENARIOS.length; s++) {
    var scenario = SCENARIOS[s];
    var hits = 0;
    var errors = 0;

    for (var r = 0; r < runs; r++) {
      var result = await runScenario(apiKey, systemPrompt, scenario);
      if (result.error) {
        errors++;
        process.stdout.write('E');
      } else {
        if (result.sawEndCall) hits++;
        process.stdout.write(result.sawEndCall ? '#' : '.');
      }
    }

    var ok = scenario.expectEndCall ? (hits === runs - errors && errors < runs) : (hits === 0);
    if (!ok) failures++;

    console.log(
      '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + scenario.name +
      '  (end_call ' + hits + '/' + runs + (errors ? ', errors ' + errors : '') +
      ', expected ' + (scenario.expectEndCall ? 'always' : 'never') + ')'
    );
  }

  console.log('\n' + (failures === 0 ? 'All scenarios behaved as expected.' :
    failures + ' scenario(s) show unwanted behavior.'));
  process.exit(failures === 0 ? 0 : 1);
}

main();
