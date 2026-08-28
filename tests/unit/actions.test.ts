import { describe, expect, it } from "vitest";
import { parseDeveloperResponse } from "../../src/orchestration/actions.js";
import { ActionValidationError } from "../../src/errors/index.js";

const DONE_ALL_EMPTY = {
  changedFiles: [],
  requestedChecks: [],
  skippedChecks: [],
  blockers: [],
  assumptions: [],
  architecturalDecisions: [],
};

describe("parseDeveloperResponse", () => {
  it("parses a single read_file action", () => {
    const result = parseDeveloperResponse({
      action: { type: "read_file", path: "a.txt" },
    });
    expect(result).toEqual({
      kind: "single",
      action: { type: "read_file", path: "a.txt" },
    });
  });

  it("parses a legacy actions[] response", () => {
    const result = parseDeveloperResponse({
      actions: [{ type: "write_file", path: "a.txt", content: "x" }],
    });
    expect(result).toEqual({
      kind: "legacy",
      actions: [{ type: "write_file", path: "a.txt", content: "x" }],
    });
  });

  it("parses DONE and BLOCKED as single actions", () => {
    expect(
      parseDeveloperResponse({ action: { type: "done", ...DONE_ALL_EMPTY } }),
    ).toEqual({ kind: "single", action: { type: "done", ...DONE_ALL_EMPTY } });

    expect(
      parseDeveloperResponse({
        action: { type: "blocked", reason: "OUT_OF_SCOPE", detail: "not mine" },
      }),
    ).toEqual({
      kind: "single",
      action: { type: "blocked", reason: "OUT_OF_SCOPE", detail: "not mine" },
    });
  });

  it("rejects a response that is neither an object nor has action/actions", () => {
    expect(() => parseDeveloperResponse("nope")).toThrow(ActionValidationError);
    expect(() => parseDeveloperResponse([1, 2])).toThrow(ActionValidationError);
    expect(() => parseDeveloperResponse({})).toThrow(ActionValidationError);
  });

  it("rejects a response with both action and actions", () => {
    expect(() =>
      parseDeveloperResponse({
        action: { type: "done", ...DONE_ALL_EMPTY },
        actions: [],
      }),
    ).toThrow(ActionValidationError);
  });

  it("rejects an unknown action type with UNKNOWN_ACTION_TYPE", () => {
    let caught: unknown;
    try {
      parseDeveloperResponse({ action: { type: "delete_repo" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActionValidationError);
    expect((caught as ActionValidationError).validationCode).toBe(
      "UNKNOWN_ACTION_TYPE",
    );
  });

  it("rejects a missing action type with UNKNOWN_ACTION_TYPE", () => {
    let caught: unknown;
    try {
      parseDeveloperResponse({ action: { path: "a.txt" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActionValidationError);
    expect((caught as ActionValidationError).validationCode).toBe(
      "UNKNOWN_ACTION_TYPE",
    );
  });

  it("rejects an unrecognized field with UNKNOWN_FIELD", () => {
    let caught: unknown;
    try {
      parseDeveloperResponse({
        action: { type: "list_files", path: ".", recursive: true },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActionValidationError);
    expect((caught as ActionValidationError).validationCode).toBe(
      "UNKNOWN_FIELD",
    );
  });

  it("rejects a missing required field with MALFORMED_ACTION", () => {
    let caught: unknown;
    try {
      parseDeveloperResponse({ action: { type: "read_file" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActionValidationError);
    expect((caught as ActionValidationError).validationCode).toBe(
      "MALFORMED_ACTION",
    );
  });

  it("rejects a run_command with an out-of-range expected exit code", () => {
    expect(() =>
      parseDeveloperResponse({
        action: { type: "run_command", command: "x", expectedExitCodes: [999] },
      }),
    ).toThrow(ActionValidationError);
  });

  it("rejects a BLOCKED action with an unrecognized reason", () => {
    expect(() =>
      parseDeveloperResponse({
        action: { type: "blocked", reason: "I_FEEL_LIKE_IT", detail: "x" },
      }),
    ).toThrow(ActionValidationError);
  });

  it("rejects DONE with a missing field, with a per-array-element error identifying the right offending action in a legacy list", () => {
    let caught: unknown;
    try {
      parseDeveloperResponse({
        actions: [
          { type: "write_file", path: "a.txt", content: "ok" },
          { type: "run_command", command: "x", extraField: true },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActionValidationError);
    expect((caught as ActionValidationError).validationCode).toBe(
      "UNKNOWN_FIELD",
    );
    expect((caught as ActionValidationError).message).toContain("run_command");
  });

  it("rejects DONE or BLOCKED inside a legacy actions[] list (terminal actions are single-turn only)", () => {
    expect(() =>
      parseDeveloperResponse({
        actions: [{ type: "done", ...DONE_ALL_EMPTY }],
      }),
    ).toThrow(ActionValidationError);
  });
});
