# Agent Notes

## Windows Payload Limits

- Do not inline large JSON bodies or long source strings directly in PowerShell commands.
- For RBXMCP HTTP calls on Windows, prefer the helper scripts in [`tools/`](C:\Users\vidin\Roblox-MCP-by-faxonao\tools):
  - [`rbxmcp-post.ps1`](C:\Users\vidin\Roblox-MCP-by-faxonao\tools\rbxmcp-post.ps1) for generic JSON-file requests
  - [`rbxmcp-create-script.ps1`](C:\Users\vidin\Roblox-MCP-by-faxonao\tools\rbxmcp-create-script.ps1) for `create_script` using `-SourceFile`
  - [`rbxmcp-update-script.ps1`](C:\Users\vidin\Roblox-MCP-by-faxonao\tools\rbxmcp-update-script.ps1) for `update_script` using `-SourceFile`
- [`rbxmcp-apply-script-patch.ps1`](C:\Users\vidin\Roblox-MCP-by-faxonao\tools\rbxmcp-apply-script-patch.ps1) for large patch payloads from a JSON file
- [`write-file.ps1`](C:\Users\vidin\Roblox-MCP-by-faxonao\tools\write-file.ps1) for safe large local text writes from stdin or an existing file
- For local code edits, prefer `apply_patch`. Do not use `powershell` commands with huge inline here-strings for file writes.
- If a payload or script body is large, write it to disk first and pass only the file path to the helper script.
