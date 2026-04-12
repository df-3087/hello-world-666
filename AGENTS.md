## 1. Project Overview
- Read docs/FR24_AIR_TRAFFIC_BRD.md for full project context.

## 2. Coding Standards


## 3. Agent Behavior Rules
- When asked to fix an issue, always investigate and explain the root cause first. Then pause and wait for human approval before making any changes.
- Always read existing code before making changes.
- Do not modify files outside the task scope. Task scope is defined as files directly related to the feature or fix described in the prompt.
- Never commit secrets or API keys.
- If a change causes a test failure or console error, stop immediately and report to the human before proceeding.

## 4. File and Folder Conventions
- Add your top-level folder structure here (e.g. src/, public/, docs/)
- Flag any directories or files that are off-limits to the agent.

## 5. API Usage Policy
- Always consider the impact of any feature change on API consumption.
- Flag to the human any change that would cause a significant increase in API calls before implementing.

## 6. Testing and Quality
- No console.log statements left in production code.

## 7. Workflow and Collaboration
- Escalate to the human if requirements are ambiguous.