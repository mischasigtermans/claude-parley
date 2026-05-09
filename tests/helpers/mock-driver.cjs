// CommonJS mock driver for the spawned MCP server harness.
// Loaded via PARLEY_DRIVER_OVERRIDE so dist/server.js can resolve it via createRequire.
//
// Configuration is read from the JSON file at process.env.PARLEY_MOCK_CONFIG on each
// invocation, so tests can rewrite that file between calls without restarting the server.
//
// Config schema (all optional):
//   {
//     "output": "string returned as the spawn result text",
//     "sessionId": "claude session UUID returned",
//     "throwMessage": "if set, the spawn throws Error(throwMessage)",
//     "logFile": "absolute path; each spawn appends one JSON line per call"
//   }

const fs = require('node:fs');

function readConfig() {
  const path = process.env.PARLEY_MOCK_CONFIG;
  if (!path) return {};
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

const driver = {
  name: 'claude',
  async spawn(call) {
    const cfg = readConfig();
    if (cfg.logFile) {
      try {
        fs.appendFileSync(
          cfg.logFile,
          JSON.stringify({
            cwd: call.cwd,
            prompt: call.prompt,
            sessionId: call.sessionId,
            model: call.model,
            mcpServers: call.mcpServers,
            skipPermissions: call.skipPermissions,
            timeoutMs: call.timeoutMs,
            ts: Date.now(),
          }) + '\n',
        );
      } catch {
        // ignore log failures
      }
    }
    if (cfg.throwMessage) {
      throw new Error(cfg.throwMessage);
    }
    return {
      output: cfg.output ?? 'mock-output',
      sessionId: cfg.sessionId ?? 'mock-session-id',
    };
  },
};

module.exports = {
  default: driver,
  getDriver(_name) {
    return driver;
  },
};
