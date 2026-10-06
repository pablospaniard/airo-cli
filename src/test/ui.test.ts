import test from "node:test";
import assert from "node:assert/strict";
import {
  agentColor,
  brand,
  command,
  divider,
  outputWidth,
  panel,
  plainText,
  promptLabel,
  renderTerminalMarkdown,
  sectionRule,
  statusIcon,
  table,
  tierColor,
  ui,
  visibleLength,
} from "../ui.js";

test("renders Markdown hierarchy for an interactive terminal", () => {
  const rendered = plainText(
    renderTerminalMarkdown(
      [
        "## Review summary",
        "",
        "- **offline-rounds.ts**: closes the farming gap and verifies the allocation cap.",
        "- `auth.ts`: verifies guest credentials.",
        "",
        "> No regressions found.",
      ].join("\n"),
      { width: 48, rich: true },
    ),
  );

  assert.match(rendered, /  Review summary/);
  assert.match(rendered, /  • offline-rounds\.ts: closes the farming/);
  assert.match(rendered, /    and verifies the allocation cap\./);
  assert.match(rendered, /  • auth\.ts: verifies guest credentials\./);
  assert.match(rendered, /  │ No regressions found\./);
  assert.doesNotMatch(rendered, /\*\*|`/);
});

test("renders all supported Markdown block forms and wrapping", () => {
  const rendered = renderTerminalMarkdown(
    [
      "# Main `code` [link](https://example.com)",
      "### Small heading ###",
      "",
      "1. a numbered item containing enough words to wrap over a narrow output width",
      "  - nested bullet",
      "---",
      "```ts",
      "const value = 1;",
      "```",
      "",
    ].join("\n"),
    { width: 30, rich: true },
  );
  assert.match(plainText(rendered), /Main code link \(https:\/\/example.com\)/);
  assert.match(plainText(rendered), /1\. a numbered item/);
  assert.match(plainText(rendered), /• nested bullet/);
  assert.match(plainText(rendered), /│ const value = 1/);
});

test("renders Markdown tables as labeled rows and handles empty bodies", () => {
  const rendered = plainText(
    renderTerminalMarkdown(
      ["| Model | Cost |", "| :--- | ---: |", "| codex | $1 |", "| claude | $2 |"].join("\n"),
      { width: 40, rich: true },
    ),
  );
  assert.match(rendered, /Model:/);
  assert.match(rendered, /codex/);
  assert.match(rendered, /Cost:/);
  assert.match(rendered, /\$2/);

  const empty = plainText(
    renderTerminalMarkdown("| Name | Value |\n| --- | --- |", { rich: true }),
  );
  assert.match(empty, /Name · Value/);
});

test("renders terminal primitives, widths, and clipped panels", () => {
  assert.equal(brand(), "airo");
  assert.equal(agentColor("claude", "x"), "x");
  assert.equal(agentColor("codex", "x"), "x");
  assert.deepEqual(
    [tierColor("fast"), tierColor("balanced"), tierColor("deep")],
    ["fast", "balanced", "deep"],
  );
  assert.deepEqual(
    [
      statusIcon("ok"),
      statusIcon("error"),
      statusIcon("ask"),
      statusIcon("work"),
      statusIcon("info"),
    ],
    ["✓", "✗", "?", "◆", "•"],
  );
  assert.match(divider("Title"), /Title/);
  assert.equal(divider().length, 58);
  assert.match(sectionRule("Title", 20), /Title/);
  assert.equal(promptLabel(), "❯ ");
  assert.equal(command("run"), "run");
  assert.equal(visibleLength("\x1b[31mred\x1b[39m"), 3);
  assert.ok(outputWidth() >= 24 && outputWidth() <= 100);
  assert.match(panel("Box", ["short", "a very long line that must be clipped"], 28), /…/);
  for (const style of Object.values(ui)) assert.equal(style("text"), "text");
});

test("aligns ANSI-safe report tables", () => {
  const rendered = plainText(
    table(
      ["Model", "Cost"],
      [
        [ui.cyan("short"), "$1"],
        ["long-model", "$20"],
      ],
    ),
  );
  const [header, rule, first, second] = rendered.split("\n");
  assert.equal(header.indexOf("Cost"), first.indexOf("$1"));
  assert.equal(first.indexOf("$1"), second.indexOf("$20"));
  assert.match(rule, /─/);
});

test("renders empty and plain paragraphs in rich mode", () => {
  assert.equal(renderTerminalMarkdown("", { rich: true }), "");
  assert.match(
    renderTerminalMarkdown("one\ncontinued", { width: 20, rich: true }),
    /one continued/,
  );
});

test("preserves raw output outside rich terminal mode", () => {
  const markdown = "- **result** with `code`";
  assert.equal(renderTerminalMarkdown(markdown, { rich: false }), markdown);
});
