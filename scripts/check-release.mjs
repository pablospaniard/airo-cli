import fs from "node:fs";

const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
const sourceVersion = fs
  .readFileSync("src/version.ts", "utf8")
  .match(/VERSION\s*=\s*"([^"]+)"/)?.[1];
const requestedVersion = (process.env.RELEASE_VERSION || rootPackage.version).replace(/^v/, "");

const failures = [];
if (!/^\d+\.\d+\.\d+$/.test(requestedVersion)) {
  failures.push(`Release version must be a stable semantic version, received ${requestedVersion}.`);
}
if (rootPackage.version !== requestedVersion) {
  failures.push(`package.json is ${rootPackage.version}; expected ${requestedVersion}.`);
}
if (sourceVersion !== requestedVersion) {
  failures.push(
    `src/version.ts is ${sourceVersion ?? "unreadable"}; expected ${requestedVersion}.`,
  );
}
const extensionPackageJson = fs.readFileSync("vscode-extension/package.json", "utf8");
const extensionPackage = JSON.parse(extensionPackageJson);
if (!/^\d+\.\d+\.\d+$/.test(extensionPackage.version)) {
  failures.push(
    `VS Code extension version must be a stable semantic version, received ${extensionPackage.version}.`,
  );
}
for (const [file, version] of [
  ["CHANGELOG.md", requestedVersion],
  ["vscode-extension/CHANGELOG.md", extensionPackage.version],
]) {
  const changelog = fs.readFileSync(file, "utf8");
  if (
    !new RegExp(`^## ${version.replaceAll(".", "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m").test(
      changelog,
    )
  ) {
    failures.push(`${file} is missing a dated ${version} release entry.`);
  }
}
for (const file of [
  "CHANGELOG.md",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "docs/airo-setup.png",
]) {
  if (!rootPackage.files.includes(file)) failures.push(`npm package files omit ${file}.`);
}

const readme = fs.readFileSync("README.md", "utf8");
if (/0\.7\.1|development[- ]branch/i.test(readme)) {
  failures.push("README.md still contains pre-1.0 release-boundary language.");
}

if (failures.length) {
  for (const failure of failures) console.error(`release check: ${failure}`);
  process.exit(1);
}

console.log(`release check: AIRO CLI package is ready at ${requestedVersion}`);
