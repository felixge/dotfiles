---
name: mcporter
description: Use mcporter to call MCP servers — either from the CLI or from TypeScript scripts. Use when the user wants to list/call MCP tools, automate MCP interactions, or build scripts that talk to MCP servers.
---

## mcporter

[mcporter](https://github.com/steipete/mcporter) is a CLI and TypeScript runtime for calling MCP servers. It auto-discovers servers from `~/.mcporter/mcporter.json`, `config/mcporter.json`, and editor imports (Cursor, Claude, Codex, etc.).

## CLI Usage

### List servers and tools

```bash
mcporter list                           # all configured servers
mcporter list linear                    # tool signatures for linear
mcporter list linear --schema           # full JSON schemas
mcporter list linear --all-parameters   # show all optional params
```

### Call tools

```bash
# key=value style
mcporter call context7.resolve-library-id libraryName=react

# function-call style (matches signatures from `mcporter list`)
mcporter call 'linear.create_comment(issueId: "ENG-123", body: "Looks good!")'

# ad-hoc URL (no config needed)
mcporter call https://mcp.linear.app/mcp.search_documentation query=automations

# output formats
mcporter call server.tool --output json
mcporter call server.tool --output markdown
```

### Auth

```bash
mcporter auth linear            # complete OAuth flow
mcporter auth https://url/mcp   # ad-hoc OAuth
```

### Config management

```bash
mcporter config list
mcporter config add sentry https://mcp.sentry.dev/mcp
mcporter config remove sentry
mcporter config import cursor --copy
mcporter config doctor
```

## TypeScript Scripting

### Project setup

Always create a proper npm package — do NOT rely on global installs:

```bash
mkdir -p /tmp/my-script && cd /tmp/my-script
cat > package.json << 'EOF'
{
  "name": "my-script",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "tsx main.ts" },
  "dependencies": { "mcporter": "^0.7.3", "tsx": "^4.21.0" }
}
EOF
npm install
```

`"type": "module"` is required — mcporter only exports ESM.

### Script template

```ts
import { createRuntime, createServerProxy, type CallResult } from "mcporter";

async function main(): Promise<void> {
  const runtime = await createRuntime();
  try {
    const server = createServerProxy(runtime, "server-name") as Record<
      string,
      (args: unknown) => Promise<CallResult>
    >;

    const result = await server.someToolName({ param: "value" });

    // CallResult helpers:
    result.text()        // plain text
    result.markdown()    // markdown
    result.json<T>()     // parsed JSON with type parameter
    result.images()      // image content
    result.content()     // raw MCP content array
  } finally {
    await runtime.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

### Inline server definitions

For servers not in config:

```ts
const runtime = await createRuntime({
  servers: [{
    name: "context7",
    description: "Context7 docs",
    command: { kind: "http", url: new URL("https://mcp.context7.com/mcp") },
  }],
});
```

### Example: Context7 library lookup

```ts
import { createRuntime, createServerProxy, type CallResult } from "mcporter";

async function main(): Promise<void> {
  const runtime = await createRuntime();
  try {
    const ctx = createServerProxy(runtime, "context7") as Record<
      string, (args: unknown) => Promise<CallResult>
    >;

    const resolved = await ctx.resolveLibraryId({ libraryName: "react" });
    const id = resolved.json<{
      candidates?: { context7CompatibleLibraryID?: string }[];
    }>()?.candidates?.[0]?.context7CompatibleLibraryID;

    if (!id) throw new Error("Could not resolve library ID");

    const docs = await ctx.getLibraryDocs({
      context7CompatibleLibraryID: id, topic: "hooks",
    });
    console.log(docs.markdown() ?? docs.text());
  } finally {
    await runtime.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```
