import { describe, expect, it } from "vitest";
import { classifyCommand } from "../../src/execution/commandSafety.js";

describe("classifyCommand", () => {
  it("classifies read-only commands", () => {
    expect(classifyCommand("git status").risk).toBe("read_only");
    expect(classifyCommand("ls -la").risk).toBe("read_only");
  });

  it("classifies destructive commands", () => {
    expect(classifyCommand("rm -rf /tmp/whatever").risk).toBe("destructive");
    expect(classifyCommand("git reset --hard HEAD~1").risk).toBe("destructive");
    expect(classifyCommand("git push origin main --force").risk).toBe(
      "destructive",
    );
    expect(classifyCommand("sudo rm file").risk).toBe("destructive");
  });

  it("classifies network commands", () => {
    expect(classifyCommand("curl https://example.com").risk).toBe("network");
    expect(classifyCommand("npm install left-pad").risk).toBe("network");
  });

  it("classifies unrecognized commands as low risk", () => {
    expect(classifyCommand("node build.js").risk).toBe("low");
  });
});
