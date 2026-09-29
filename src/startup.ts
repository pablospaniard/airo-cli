export function shouldRunInitialSetup(raw: string[], isTTY: boolean, hasConfig: boolean): boolean {
  if (hasConfig || !isTTY) return false;
  const command = raw[0] ?? "";
  const managementCommands = [
    "account",
    "config",
    "doctor",
    "feedback",
    "history",
    "learning",
    "logs",
    "models",
    "repository",
    "sessions",
    "setup",
    "sync",
    "usage",
  ];
  if (managementCommands.includes(command)) return false;
  if (command === "session" && !(raw[1] === "new" && raw.length > 2)) return false;
  return (
    !raw.includes("--help") &&
    !raw.includes("-h") &&
    !raw.includes("--version") &&
    !raw.includes("-v")
  );
}

/** Show the branded orientation before every interactive CLI invocation. */
export function shouldShowWelcome(raw: string[], isTTY: boolean): boolean {
  if (!isTTY) return false;
  return (
    !raw.includes("--help") &&
    !raw.includes("-h") &&
    !raw.includes("--version") &&
    !raw.includes("-v")
  );
}
