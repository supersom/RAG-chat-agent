# Learnings

## [LRN-20260724-001] correction

**Logged**: 2026-07-24T14:03:33-07:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Ask before pushing branches where push triggers an Amplify deployment.

### Details
The user corrected the workflow after two fixes were committed and pushed immediately to `worktree-tenant-llm-config`, which triggered Amplify preview deploys. Future work on this repo may need multiple local commits batched before one deploy-triggering push.

### Suggested Action
Commit locally when appropriate, but explicitly ask the user before running `git push` on deployment-connected branches. Mention that pushing will trigger Amplify deployment when asking.

### Metadata
- Source: user_feedback
- Related Files: amplify.yml
- Tags: git, deploy, amplify, workflow

---

## [LRN-20260724-002] correction

**Logged**: 2026-07-24T14:09:46-07:00
**Priority**: high
**Status**: pending
**Area**: docs

### Summary
Update `DEVLOG.md` with every code change and put deferred observations in backlog.

### Details
The user asked to make it standard practice that code changes are accompanied by a devlog update. If a possible improvement, bug, or follow-up is observed but not addressed immediately, it should be added to the project backlog instead of being left only in chat context.

### Suggested Action
Before finishing any code-change task, update `DEVLOG.md`. If any non-current follow-up is discovered, add it to `/home/som/.claude/projects/-home-som-code-claude-quickstarts-customer-support-agent/memory/BACKLOG.md` unless the user chooses a repo-local backlog.

### Metadata
- Source: user_feedback
- Related Files: DEVLOG.md
- Tags: devlog, backlog, workflow

---
