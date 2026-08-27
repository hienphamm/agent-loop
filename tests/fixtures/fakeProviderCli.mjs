#!/usr/bin/env node
// Fake "provider CLI" used to exercise `--reviewer-auth cli --developer-auth
// cli` end to end without any real network/API key. Reads the rendered
// prompt on stdin, decides which phase it's being asked for, and prints a
// scripted JSON completion on stdout — exactly the contract CliExecProvider
// expects from a real provider CLI's exec/non-interactive mode.
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");

function reply(content) {
  process.stdout.write(content);
  process.exit(0);
}

if (prompt.includes("You are the Planner")) {
  reply(
    JSON.stringify({
      tasks: [
        {
          id: "write-greeting",
          description: "write greeting.txt",
          dependencies: [],
          risk: "low",
          acceptanceCriteria: ["file exists"],
        },
      ],
      rationale: "single simple task",
    }),
  );
} else if (prompt.includes("You are the Reviewer")) {
  reply(JSON.stringify({ decision: "approve", notes: "looks good" }));
} else if (prompt.includes("You are the Developer/Executor")) {
  reply(
    JSON.stringify({
      actions: [{ type: "write_file", path: "greeting.txt", content: "hello from the fake provider CLI" }],
    }),
  );
} else if (prompt.includes("Summarize this conversation")) {
  reply(JSON.stringify({ decisions: [], facts: [], rules: [], artifacts: [], openQuestions: [] }));
} else {
  reply("{}");
}
