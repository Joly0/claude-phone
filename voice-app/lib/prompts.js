var fs = require('fs');
var path = require('path');

var PROMPTS_PATH = path.join(__dirname, '..', 'config', 'prompts.json');

function load() {
  try {
    var raw = fs.readFileSync(PROMPTS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

module.exports = { load: load };
