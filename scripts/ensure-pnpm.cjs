const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
for (const name of ["package-lock.json", "yarn.lock"]) {
  try {
    fs.unlinkSync(path.join(root, name));
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}

const agent = String(process.env.npm_config_user_agent || "");
if (!agent.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
