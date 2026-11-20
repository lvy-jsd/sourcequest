# SourceQuest agent handoff

Start with [the handoff](docs/HANDOFF.md) and [the implementation plan](docs/IMPLEMENTATION_PLAN.md). The handoff records current work and verified results. The plan defines task dependencies and acceptance criteria.

Before editing, fetch the current GitHub refs, inspect the working tree, and check whether another contributor is already working on the same task. Preserve local changes. Keep concurrent work on separate branches and compare against the latest main before integrating.

Update the handoff with each meaningful checkpoint, including task ID, status, branch or evidence link, actual validation, blockers, and the next action. Commit the status update with the work when possible. Push the relevant branch promptly using a normal push. If a push is rejected, fetch and reconcile the changes while preserving others' work. Use task branches for unfinished parallel work and link them from the public handoff when available.

Use an isolated DSH profile and fixtures for development. Keep credentials, private sources, user sessions, and local deployment details out of the public repository.
