// Compatibility entry point: node --test tests/frontend.test.cjs
// React behavior tests now live alongside the TypeScript source.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const result = spawnSync("npm", ["test"], {
  cwd: path.join(__dirname, "../frontend"), stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
