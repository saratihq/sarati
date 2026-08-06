# sarati-mcp

stdio bridge to a [Sarati](https://github.com/saratihq/sarati) instance's MCP endpoint. It
forwards JSON-RPC frames and injects your API key as a bearer token — no tool definitions, no
business logic, so it can never drift from the server it talks to.

Use it with any MCP client that speaks stdio. Clients that speak Streamable HTTP can point at
`https://your-instance/mcp` directly and skip this package.

## Configure

```json
{
  "mcpServers": {
    "sarati": {
      "command": "npx",
      "args": ["-y", "sarati-mcp"],
      "env": {
        "SARATI_BASE_URL": "http://localhost:8001",
        "SARATI_API_KEY": "ork_…"
      }
    }
  }
}
```

`SARATI_BASE_URL` may include the `/mcp` path or omit it. Both variables are required.

## The key decides what the agent can do

Issue the key with only the scopes the agent needs — the tool list it sees is filtered by them, and
the server refuses anything beyond them whether or not a tool was listed:

| Scope | What it unlocks |
| --- | --- |
| `workflow:read` | Reading workflows, versions, diffs and runs. Required to open a session at all. |
| `connection:read` | Listing which connections exist (ids and status only — never credentials). |
| `workflow:write` | Editing, committing to a branch, opening a review. |
| `run:dry` | Testing a workflow as a dry run, which changes nothing outside. |
| `run:execute` | Letting that test fire for real instead. |

Those five are every scope the tools ask for. No tool deploys, promotes, merges, changes a connection
or administers an organization — so a key carrying broader scopes still cannot reach those operations
here. An agent's terminal move is opening a review for a human.

## License

MIT — see [LICENSE](LICENSE). This package is deliberately carved out of the repository's
Sustainable Use License so it can be embedded in any MCP client; it is a transport shim that ships
no platform code.
