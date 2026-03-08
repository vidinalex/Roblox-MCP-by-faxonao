import { describe, expect, it } from "vitest";
import { applyScriptPatch, diffLines, validateScriptPatchOps } from "../src/lib/scriptPatch.js";

describe("scriptPatch utilities", () => {
  it("validates and applies structured patch operations", () => {
    const source = ["local value = 1", "print(value)", "return value"].join("\n");
    const patched = applyScriptPatch(source, [
      { op: "replace_text", oldText: "value = 1", newText: "value = 2" },
      { op: "insert_after_line", line: 2, text: "value += 10" },
      { op: "replace_range", startLine: 4, startCol: 1, endLine: 4, endCol: 13, text: "return value + 1" }
    ]);

    expect(patched.source).toContain("value = 2");
    expect(patched.source).toContain("value += 10");
    expect(patched.source).toContain("return value + 1");
    expect(patched.operationsApplied).toBe(3);
  });

  it("rejects malformed patch ranges", () => {
    const issues = validateScriptPatchOps([
      { op: "replace_range", startLine: 3, startCol: 1, endLine: 2, endCol: 1, text: "x" }
    ]);
    expect(issues[0].code).toBe("patch_invalid");
  });

  it("throws patch_target_not_found when replace_text does not match", () => {
    expect(() =>
      applyScriptPatch("print('x')", [{ op: "replace_text", oldText: "missing", newText: "y" }])
    ).toThrowError(/target not found/i);
  });

  it("builds deterministic compact diff hunks", () => {
    const diff = diffLines("alpha\nbeta\ngamma", "alpha\nbeta changed\ngamma\ndelta");
    expect(diff.summary.changedHunks).toBeGreaterThan(0);
    expect(diff.summary.addedLines).toBeGreaterThan(0);
    expect(diff.hunks[0].addedLines.length).toBeGreaterThan(0);
  });
});
