import { describe, expect, it } from "vitest";
import { shouldEnableMcpStdio } from "../src/index.js";

describe("shouldEnableMcpStdio", () => {
  it("disables stdio by default in interactive terminals", () => {
    expect(
      shouldEnableMcpStdio({}, { isTTY: true }, { isTTY: true })
    ).toBe(false);
  });

  it("enables stdio by default for piped non-interactive runtimes", () => {
    expect(
      shouldEnableMcpStdio({}, { isTTY: false }, { isTTY: false })
    ).toBe(true);
  });

  it("disables stdio for explicit HTTP bridge startup with RBXMCP_PORT", () => {
    expect(
      shouldEnableMcpStdio({ RBXMCP_PORT: "5111" }, { isTTY: false }, { isTTY: false })
    ).toBe(false);
  });

  it("honors explicit force-enable mode", () => {
    expect(
      shouldEnableMcpStdio({ RBXMCP_STDIO_MODE: "on", RBXMCP_PORT: "5111" }, { isTTY: true }, { isTTY: true })
    ).toBe(true);
  });

  it("honors explicit force-disable mode", () => {
    expect(
      shouldEnableMcpStdio({ RBXMCP_STDIO_MODE: "off" }, { isTTY: false }, { isTTY: false })
    ).toBe(false);
  });
});
