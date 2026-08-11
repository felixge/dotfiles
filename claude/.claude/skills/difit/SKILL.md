---
name: difit
description: Launch and refresh difit for a jj change. Use when the user asks for difit or a diff view.
---

# difit

## Launch a jj change

Resolve the requested revision to its stable jj change ID, then resolve its current Git commit ID and launch difit in the background:

```bash
change=$(jj log -r '<revision>' --no-graph -T 'change_id')
commit=$(jj log -r "$change" --no-graph -T 'commit_id')
difit "$commit" --port 4966 --background
```

Use `@` when the user does not specify a revision. Report the URL returned by difit. Remember the change ID, port, and returned PID for refreshes.

## Refresh after edits

Once the user has first requested a difit view, refresh it after **every** subsequent edit to that jj change. A jj change keeps its change ID but receives a new Git commit ID when modified, so resolve the commit ID again; never reuse the old one.

Stop the previous difit process, wait for it to exit, then relaunch on the same port:

```bash
kill '<pid>' 2>/dev/null || true
for i in 1 2 3 4 5; do
  if ! kill -0 '<pid>' 2>/dev/null; then break; fi
  sleep 0.2
done
commit=$(jj log -r '<change-id>' --no-graph -T 'commit_id')
difit "$commit" --port '<port>' --background
```

Update the remembered PID and port from the returned JSON and report the refreshed URL. This refresh requirement remains active for the rest of the task/session after the first difit request.
