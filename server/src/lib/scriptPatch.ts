import { ScriptPatchOp } from "../domain/types.js";

export interface PatchValidationIssue {
  code: string;
  message: string;
  operationIndex?: number;
}

export interface DiffHunk {
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
  removedLines: string[];
  addedLines: string[];
}

function splitLines(source: string): string[] {
  return source.split("\n");
}

function offsetForPosition(source: string, line: number, col: number): number {
  if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) {
    throw new Error("Position must use 1-based positive integers");
  }
  let currentLine = 1;
  let index = 0;
  while (currentLine < line && index < source.length) {
    if (source[index] === "\n") {
      currentLine += 1;
    }
    index += 1;
  }
  if (currentLine !== line) {
    throw new Error("Line is out of range");
  }
  const lineEnd = source.indexOf("\n", index);
  const effectiveLineEnd = lineEnd >= 0 ? lineEnd : source.length;
  const lineLength = effectiveLineEnd - index;
  if (col - 1 > lineLength) {
    throw new Error("Column is out of range");
  }
  return index + col - 1;
}

function normalizeOccurrence(input: number | undefined, matches: number): number {
  if (input === undefined) {
    if (matches === 1) {
      return 1;
    }
    throw new Error("replace_text is ambiguous without occurrence");
  }
  if (!Number.isInteger(input) || input < 1 || input > matches) {
    throw new Error("replace_text occurrence is out of range");
  }
  return input;
}

export function validateScriptPatchOps(opsInput: unknown): PatchValidationIssue[] {
  if (!Array.isArray(opsInput) || opsInput.length === 0) {
    return [{ code: "patch_invalid", message: "patch must be a non-empty array" }];
  }
  const issues: PatchValidationIssue[] = [];
  opsInput.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      issues.push({ code: "patch_invalid", message: "patch operation must be an object", operationIndex: index + 1 });
      return;
    }
    const op = raw as Record<string, unknown>;
    switch (op.op) {
      case "replace_range":
        if (
          !Number.isInteger(op.startLine) ||
          !Number.isInteger(op.startCol) ||
          !Number.isInteger(op.endLine) ||
          !Number.isInteger(op.endCol) ||
          typeof op.text !== "string"
        ) {
          issues.push({ code: "patch_invalid", message: "replace_range requires start/end positions and text", operationIndex: index + 1 });
        } else if (
          (op.endLine as number) < (op.startLine as number) ||
          ((op.endLine as number) === (op.startLine as number) && (op.endCol as number) < (op.startCol as number))
        ) {
          issues.push({ code: "patch_invalid", message: "replace_range end must not be before start", operationIndex: index + 1 });
        }
        break;
      case "replace_text":
        if (typeof op.oldText !== "string" || typeof op.newText !== "string") {
          issues.push({ code: "patch_invalid", message: "replace_text requires oldText and newText", operationIndex: index + 1 });
        } else if ((op.oldText as string).length === 0) {
          issues.push({ code: "patch_invalid", message: "replace_text oldText must not be empty", operationIndex: index + 1 });
        }
        break;
      case "insert_after_line":
        if (!Number.isInteger(op.line) || typeof op.text !== "string") {
          issues.push({ code: "patch_invalid", message: "insert_after_line requires line and text", operationIndex: index + 1 });
        } else if ((op.line as number) < 1) {
          issues.push({ code: "patch_invalid", message: "insert_after_line line must be >= 1", operationIndex: index + 1 });
        }
        break;
      case "delete_range":
        if (
          !Number.isInteger(op.startLine) ||
          !Number.isInteger(op.startCol) ||
          !Number.isInteger(op.endLine) ||
          !Number.isInteger(op.endCol)
        ) {
          issues.push({ code: "patch_invalid", message: "delete_range requires start/end positions", operationIndex: index + 1 });
        } else if (
          (op.endLine as number) < (op.startLine as number) ||
          ((op.endLine as number) === (op.startLine as number) && (op.endCol as number) < (op.startCol as number))
        ) {
          issues.push({ code: "patch_invalid", message: "delete_range end must not be before start", operationIndex: index + 1 });
        }
        break;
      default:
        issues.push({ code: "patch_invalid", message: `unsupported patch op: ${String(op.op ?? "")}`, operationIndex: index + 1 });
        break;
    }
  });
  return issues;
}

export function applyScriptPatch(source: string, patch: ScriptPatchOp[]): { source: string; operationsApplied: number } {
  let current = source;
  for (let index = 0; index < patch.length; index += 1) {
    const op = patch[index];
    try {
      switch (op.op) {
        case "replace_range": {
          const start = offsetForPosition(current, op.startLine, op.startCol);
          const end = offsetForPosition(current, op.endLine, op.endCol);
          if (end < start) {
            throw new Error("replace_range end is before start");
          }
          current = `${current.slice(0, start)}${op.text}${current.slice(end)}`;
          break;
        }
        case "delete_range": {
          const start = offsetForPosition(current, op.startLine, op.startCol);
          const end = offsetForPosition(current, op.endLine, op.endCol);
          if (end < start) {
            throw new Error("delete_range end is before start");
          }
          current = `${current.slice(0, start)}${current.slice(end)}`;
          break;
        }
        case "insert_after_line": {
          const lines = splitLines(current);
          if (op.line < 1 || op.line > lines.length) {
            throw new Error("insert_after_line target line is out of range");
          }
          lines.splice(op.line, 0, op.text);
          current = lines.join("\n");
          break;
        }
        case "replace_text": {
          if (op.oldText.length === 0) {
            throw new Error("replace_text oldText must not be empty");
          }
          const matches: number[] = [];
          let searchFrom = 0;
          while (searchFrom <= current.length) {
            const found = current.indexOf(op.oldText, searchFrom);
            if (found < 0) {
              break;
            }
            matches.push(found);
            searchFrom = found + Math.max(1, op.oldText.length);
          }
          if (matches.length === 0) {
            throw new Error("replace_text target not found");
          }
          const occurrence = normalizeOccurrence(op.occurrence, matches.length);
          const at = matches[occurrence - 1];
          current = `${current.slice(0, at)}${op.newText}${current.slice(at + op.oldText.length)}`;
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("target not found") || message.includes("ambiguous")) {
        const tagged = new Error(message);
        tagged.name = "patch_target_not_found";
        throw Object.assign(tagged, { operationIndex: index + 1 });
      }
      const tagged = new Error(message);
      tagged.name = "patch_invalid";
      throw Object.assign(tagged, { operationIndex: index + 1 });
    }
  }
  return { source: current, operationsApplied: patch.length };
}

export function diffLines(baseSource: string, currentSource: string): {
  summary: { addedLines: number; removedLines: number; changedHunks: number };
  hunks: DiffHunk[];
} {
  const oldLines = splitLines(baseSource);
  const newLines = splitLines(currentSource);
  const m = oldLines.length;
  const n = newLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: Array<{ kind: "equal" | "add" | "remove"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "equal", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "remove", line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ kind: "remove", line: oldLines[i] });
    i += 1;
  }
  while (j < n) {
    ops.push({ kind: "add", line: newLines[j] });
    j += 1;
  }

  const hunks: DiffHunk[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;
  let currentHunk: DiffHunk | null = null;

  const flush = () => {
    if (!currentHunk) {
      return;
    }
    currentHunk.oldEndLine = currentHunk.oldStartLine + Math.max(0, currentHunk.removedLines.length - 1);
    currentHunk.newEndLine = currentHunk.newStartLine + Math.max(0, currentHunk.addedLines.length - 1);
    hunks.push(currentHunk);
    currentHunk = null;
  };

  for (const op of ops) {
    if (op.kind === "equal") {
      flush();
      oldLineNo += 1;
      newLineNo += 1;
      continue;
    }
    if (!currentHunk) {
      currentHunk = {
        oldStartLine: oldLineNo,
        oldEndLine: oldLineNo,
        newStartLine: newLineNo,
        newEndLine: newLineNo,
        removedLines: [],
        addedLines: []
      };
    }
    if (op.kind === "remove") {
      currentHunk.removedLines.push(op.line);
      oldLineNo += 1;
    } else {
      currentHunk.addedLines.push(op.line);
      newLineNo += 1;
    }
  }
  flush();

  return {
    summary: {
      addedLines: hunks.reduce((sum, hunk) => sum + hunk.addedLines.length, 0),
      removedLines: hunks.reduce((sum, hunk) => sum + hunk.removedLines.length, 0),
      changedHunks: hunks.length
    },
    hunks
  };
}
