#!/usr/bin/env node
// Pre-hook of test / lint / typecheck / dev / build / e2e (DESIGN.md §6.2 item 1).
//
// Vite 8, rolldown, @vitejs/plugin-react 6 and oxlint 1.86 need Node ^20.19 || >=22.12. On an older Node,
// npm silently skips their native bindings and the tools then fail in confusing ways, so a wrong runtime
// must fail loudly, before the tool starts.
//
// Exits 1 with the nvm one-liner when Node < 22.12; warns (exit 0) when npm < 11.
// Written in plain ES5-style JavaScript on purpose: every Node that can load an .mjs file at all (12.17 and
// newer) must be able to run it and explain itself, instead of stopping at a syntax error.
//
// On npm 10.9 and newer, `devEngines` in package.json stops a wrong Node before any script runs (npm prints
// EBADDEVENGINES); this hook is what answers on an npm that does not know `devEngines`.

var MIN_NODE = [22, 12, 0];
var MIN_NPM_MAJOR = 11;
var NVM_ONE_LINER = 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <your command>';

function parseVersion(text) {
  var m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(version, min) {
  for (var i = 0; i < 3; i++) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

var node = parseVersion(process.versions.node);
if (!node || !atLeast(node, MIN_NODE)) {
  console.error(
    [
      '',
      'check-node: this project needs Node >= ' + MIN_NODE[0] + '.' + MIN_NODE[1] + ' (Node 22 LTS), but this shell runs Node ' +
        process.versions.node + '.',
      'Run the command again under Node 22:',
      '',
      '  ' + NVM_ONE_LINER,
      '',
      '(a shell that keeps no state between commands needs the prefix on every command; see README.md, "Requirements")',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// npm sets npm_config_user_agent to e.g. "npm/10.9.9 node/v22.23.3 darwin arm64 workspaces/false".
var agent = /(?:^|\s)npm\/(\d+)\.(\d+)\.(\d+)/.exec(process.env.npm_config_user_agent || '');
if (agent && Number(agent[1]) < MIN_NPM_MAJOR) {
  console.warn(
    'check-node: npm ' + agent[1] + '.' + agent[2] + '.' + agent[3] + ' is older than npm ' + MIN_NPM_MAJOR +
      '. Running scripts and `npm ci` is fine; change the lockfile only with `npx -y npm@11.21.0 install`.',
  );
}
