const interactive = Boolean(process.stdout.isTTY);
const enabled = (interactive || process.env.AIRO_COLOR === "1") && !process.env.NO_COLOR;
const wrap = (open: string, close: string, value: string) =>
  enabled ? `${open}${value}${close}` : value;

export const ui = {
  dim: (s: string) => wrap("\x1b[2m", "\x1b[22m", s),
  bold: (s: string) => wrap("\x1b[1m", "\x1b[22m", s),
  cyan: (s: string) => wrap("\x1b[36m", "\x1b[39m", s),
  blue: (s: string) => wrap("\x1b[34m", "\x1b[39m", s),
  green: (s: string) => wrap("\x1b[32m", "\x1b[39m", s),
  yellow: (s: string) => wrap("\x1b[33m", "\x1b[39m", s),
  red: (s: string) => wrap("\x1b[31m", "\x1b[39m", s),
  magenta: (s: string) => wrap("\x1b[35m", "\x1b[39m", s),
  gray: (s: string) => wrap("\x1b[90m", "\x1b[39m", s),
  white: (s: string) => wrap("\x1b[37m", "\x1b[39m", s),
  rgb: (...args: [number, number, number, string] | [string]) => {
    if (args.length === 1) return args[0];
    const [red, green, blue, s] = args;
    return wrap(`\x1b[38;2;${red};${green};${blue}m`, "\x1b[39m", s);
  },
};

export function brand(s = "airo"): string {
  return ui.bold(ui.cyan(s));
}
export function agentColor(agent: "claude" | "codex" | "gemini" | "copilot", s: string): string {
  if (agent === "claude") return ui.magenta(s);
  // Gemini uses Google's multicolor gradient; Google blue is the readable terminal accent.
  if (agent === "gemini") return ui.rgb(66, 133, 244, s);
  // GitHub's official Copilot Purple: #8534F3.
  if (agent === "copilot") return ui.rgb(133, 52, 243, s);
  return ui.cyan(s);
}
export function tierColor(tier: string): string {
  return tier === "fast" ? ui.green(tier) : tier === "balanced" ? ui.yellow(tier) : ui.red(tier);
}
export function statusIcon(kind: "ok" | "error" | "work" | "ask" | "info"): string {
  if (kind === "ok") return ui.green("✓");
  if (kind === "error") return ui.red("✗");
  if (kind === "ask") return ui.yellow("?");
  if (kind === "work") return ui.blue("◆");
  return ui.gray("•");
}
export function divider(title?: string): string {
  const body = title ? ` ${title} ` : "";
  const width = Math.max(24, 58 - body.length);
  return ui.gray(`${"─".repeat(Math.floor(width / 2))}${body}${"─".repeat(Math.ceil(width / 2))}`);
}
export function sectionRule(title: string, width = 68): string {
  const label = ` ${title} `;
  const remaining = Math.max(0, width - visibleLength(label));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return ui.gray(`${"─".repeat(left)}${label}${"─".repeat(right)}`);
}
export function promptLabel(): string {
  return `${ui.green("❯")} `;
}
export function command(s: string): string {
  return ui.bold(ui.cyan(s));
}

export function plainText(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}
export function visibleLength(value: string): number {
  return plainText(value).length;
}

export function outputWidth(): number {
  return Math.max(24, Math.min(100, process.stdout.columns || 80));
}

/** Render compact, ANSI-safe rows for terminal reports. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const columns = headers.map((header, index) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[index] ?? ""))),
  );
  const render = (row: readonly string[]) =>
    row
      .map((value, index) => `${value}${" ".repeat(columns[index] - visibleLength(value))}`)
      .join("  ");
  return [
    ui.bold(render(headers)),
    ui.gray(columns.map((width) => "─".repeat(width)).join("  ")),
    ...rows.map(render),
  ].join("\n");
}

function styleWords(value: string, style: (word: string) => string): string {
  return value
    .split(/(\s+)/)
    .map((part) => (/\s+/.test(part) ? part : style(part)))
    .join("");
}

function inlineMarkdown(value: string): string {
  return value.replace(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g, (token) => {
    if (token.startsWith("`")) return styleWords(token.slice(1, -1), ui.cyan);
    if (token.startsWith("**")) return styleWords(token.slice(2, -2), ui.bold);
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    return link ? `${ui.cyan(link[1])} ${ui.gray(`(${link[2]})`)}` : token;
  });
}

function wrapped(value: string, firstPrefix: string, nextPrefix: string, width: number): string[] {
  const words = inlineMarkdown(value.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [firstPrefix.trimEnd()];
  const lines: string[] = [];
  let prefix = firstPrefix;
  let line = prefix;
  for (const word of words) {
    const spacer = visibleLength(line) > visibleLength(prefix) ? " " : "";
    if (spacer && visibleLength(line) + 1 + visibleLength(word) > width) {
      lines.push(line);
      prefix = nextPrefix;
      line = `${prefix}${word}`;
    } else {
      line += `${spacer}${word}`;
    }
  }
  lines.push(line);
  return lines;
}

function markdownTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return undefined;
  const cells = trimmed
    .replace(/^\|\s*/, "")
    .replace(/\s*\|$/, "")
    .split("|");
  return cells.map((cell) => cell.trim());
}

function markdownTableSeparator(row: readonly string[]): boolean {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export interface MarkdownRenderOptions {
  width?: number;
  rich?: boolean;
}

/** Render common Markdown as readable terminal text without changing persisted output. */
export function renderTerminalMarkdown(value: string, options: MarkdownRenderOptions = {}): string {
  if (!(options.rich ?? interactive)) return value;
  const width = options.width ?? outputWidth();
  const source = value.replace(/\r/g, "").trim().split("\n");
  const output: string[] = [];
  let inCode = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(...wrapped(paragraph.join(" "), "  ", "  ", width));
    paragraph = [];
  };

  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const raw = source[sourceIndex];
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      flushParagraph();
      inCode = !inCode;
      if (inCode) output.push(ui.gray(`  ${"─".repeat(Math.max(8, width - 4))}`));
      else output.push(ui.gray(`  ${"─".repeat(Math.max(8, width - 4))}`));
      continue;
    }
    if (inCode) {
      output.push(`${ui.cyan("  │")} ${line}`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      if (output.at(-1) !== "") output.push("");
      continue;
    }

    const tableHeader = markdownTableRow(line);
    const tableDivider =
      sourceIndex + 1 < source.length ? markdownTableRow(source[sourceIndex + 1]) : undefined;
    if (tableHeader && tableDivider && markdownTableSeparator(tableDivider)) {
      flushParagraph();
      const rows: string[][] = [tableHeader];
      sourceIndex += 2;
      while (sourceIndex < source.length) {
        const row = markdownTableRow(source[sourceIndex]);
        if (!row) break;
        rows.push(row);
        sourceIndex += 1;
      }
      sourceIndex -= 1;
      const headers = rows[0];
      const body = rows.slice(1);
      output.push(
        ...headers
          .map((header, index) => {
            const values = body.map((row) => row[index] ?? "");
            const label = `${header}:`;
            const prefix = `  ${ui.bold(label)} `;
            return values.length
              ? values.flatMap((value) =>
                  wrapped(value, prefix, " ".repeat(visibleLength(prefix)), width),
                )
              : wrapped("", prefix, " ".repeat(visibleLength(prefix)), width);
          })
          .flat(),
      );
      if (!body.length) output.push(...wrapped(headers.join(" · "), "  ", "  ", width));
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);

    if (heading) {
      flushParagraph();
      const label = inlineMarkdown(heading[2].replace(/\s+#+\s*$/, ""));
      output.push(heading[1].length === 1 ? `  ${ui.bold(ui.cyan(label))}` : `  ${ui.bold(label)}`);
    } else if (bullet) {
      flushParagraph();
      const depth = Math.min(3, Math.floor(bullet[1].length / 2));
      const indent = "  ".repeat(depth + 1);
      const prefix = `${indent}${ui.cyan("•")} `;
      output.push(...wrapped(bullet[2], prefix, " ".repeat(visibleLength(prefix)), width));
    } else if (numbered) {
      flushParagraph();
      const depth = Math.min(3, Math.floor(numbered[1].length / 2));
      const indent = "  ".repeat(depth + 1);
      const marker = `${numbered[2]}.`;
      const prefix = `${indent}${ui.cyan(marker)} `;
      output.push(...wrapped(numbered[3], prefix, " ".repeat(visibleLength(prefix)), width));
    } else if (quote) {
      flushParagraph();
      output.push(...wrapped(quote[1], `${ui.gray("  │")} `, "    ", width).map(ui.dim));
    } else if (rule) {
      flushParagraph();
      output.push(ui.gray(`  ${"─".repeat(Math.max(8, width - 4))}`));
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  while (output.at(-1) === "") output.pop();
  return output.join("\n");
}

export function panel(title: string, lines: string[], width = 68): string {
  const inner = Math.max(24, width - 4);
  const topTitle = ` ${title} `;
  const top = `╭${topTitle}${"─".repeat(Math.max(0, width - topTitle.length - 2))}╮`;
  const body = lines.map((line) => {
    const clipped =
      visibleLength(line) > inner ? `${plainText(line).slice(0, Math.max(0, inner - 1))}…` : line;
    return `│ ${clipped}${" ".repeat(Math.max(0, inner - visibleLength(clipped)))} │`;
  });
  return [ui.cyan(top), ...body, ui.cyan(`╰${"─".repeat(width - 2)}╯`)].join("\n");
}
