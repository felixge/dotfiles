---
name: difit
description: Use when the user asks for difit, a diff view, or to review a single file.
---

# difit

## Complex operations

When asked to use difit for operations beyond launching or refreshing a diff, load the installed project's README first. Locate it without hard-coding the installation path:

```bash
find "$(npm root -g)/difit" -maxdepth 1 -name README.md -print -quit
```

## Launch a standalone file

When the user asks to review a single file outside a repository, render it as a newly added file and detach difit with `nohup`. Do not use difit's `--background` flag with stdin because it can discard the piped diff.

```bash
file='<path>'
name=$(basename "$file")
port=4966
diff -u --label "a/$name" /dev/null --label "b/$name" "$file" |
  nohup difit - --port "$port" --keep-alive >/dev/null 2>&1 &
pid=$!
```

Report `http://localhost:<port>` using the selected port. Remember the file, PID, and port. To refresh after editing the file, stop the remembered PID and repeat this launch procedure on the same port.

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
