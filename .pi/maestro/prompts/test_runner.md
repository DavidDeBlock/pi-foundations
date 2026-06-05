---
name: test_runner
description: Executes the local test suite and reports pass/fail counts. Runs commands only.
tools: ['Read', 'Bash']
---

## PHASE: test_runner
## ISSUE: {issue_number}

{prefetched_context}

## Working Memory (from previous phases)

```json
{working_memory_json}
```

{previous_output}

**YOUR TASK:** Execute the local test suite and report results.

**COMMAND TO RUN:**
```bash
pnpm test --run
```

**RULES:**
1. Run the test command in the project root directory
2. Capture both stdout and stderr
3. Report pass/fail status with specific failing tests if any
4. If all tests pass, mark as "success"
5. If tests fail, provide specific error messages for the builder to fix

**EVIDENCE WRITING (REQUIRED):**

After the test run completes — whether the suite passed or failed — you MUST
write a `tested.json` evidence marker. This is the auditable artifact that
the close phase checks before declaring success. If you skip this step, the
flow will route to `diagnostic` even if the tests actually passed.

```bash
maestro mark-tested {issue_number} \
  --command "pnpm test --run" \
  --tests-run $TESTS_RUN \
  --tests-passed $TESTS_PASSED \
  --exit-code $EXIT_CODE
```

Parse the test output to extract:
- `$TESTS_RUN` — total number of tests executed
- `$TESTS_PASSED` — number of tests that passed (NOT including skipped)
- `$EXIT_CODE` — exit code of the test command (0 = success)

The `mark-tested` command will:
- Exit 0 with `verified=true` if `exit_code == 0 && tests_passed == tests_run`
- Exit 1 with `verified=false` otherwise (so the close phase knows the run failed)

**RESULT FORMAT:**

Output your verdict as a JSON code block with language tag `verdict`:
```verdict
{"status":"approved","verdict":"passed","details":"All tests passed","issues":[],"labels":{"add":[],"remove":[]},"findings":[]}
```

If ANY TEST FAILS, move test errors to the issues array:
```verdict
{"status":"rejected","verdict":"failed","details":"","issues":["Test 1 failed: ...", "Test 2 failed: ..."],"labels":{"add":[],"remove":[]},"findings":[]}
```

**IMPORTANT:** The evidence marker must be written even if the test run
itself failed — that's how the close phase knows the run was *attempted*.
