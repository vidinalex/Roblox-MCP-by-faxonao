# Windows Large Payload Workflow

PowerShell and `cmd.exe` are poor places to inline very large JSON bodies or long script sources. The stable pattern is:

1. Put the payload or source on disk.
2. Pass only the file path through the shell.
3. Let the helper script or Node request client send the bytes.

## Generic JSON request

```powershell
@'
{
  "scope": "all",
  "verbosity": "minimal"
}
'@ | Set-Content C:\temp\rbxmcp-payload.json -Encoding UTF8

powershell -File .\tools\rbxmcp-post.ps1 `
  -Endpoint /v1/agent/get_project_summary `
  -JsonFile C:\temp\rbxmcp-payload.json `
  -Port 5111
```

Direct Node helper:

```powershell
node .\tools\rbxmcp-request.mjs `
  --endpoint /v1/agent/get_project_summary `
  --port 5111 `
  --file C:\temp\rbxmcp-payload.json
```

## Create script from file

```powershell
powershell -File .\tools\rbxmcp-create-script.ps1 `
  -Path "ReplicatedStorage/MyFolder/NewModule" `
  -ClassName ModuleScript `
  -SourceFile C:\temp\NewModule.lua `
  -Port 5111
```

## Update script from file

```powershell
powershell -File .\tools\rbxmcp-update-script.ps1 `
  -Path "ReplicatedStorage/MyFolder/NewModule" `
  -ExpectedHash "abcd1234" `
  -SourceFile C:\temp\NewModule.lua `
  -Port 5111
```

## Apply script patch from file

```powershell
powershell -File .\tools\rbxmcp-apply-script-patch.ps1 `
  -Path "ReplicatedStorage/MyFolder/NewModule" `
  -PatchFile C:\temp\patch.json `
  -ExpectedHash "abcd1234" `
  -Port 5111
```

## Large local file write

```powershell
Get-Content C:\temp\generated.txt -Raw | powershell -File .\tools\write-file.ps1 `
  -Path C:\Users\vidin\Roblox-MCP-by-faxonao\server\scratch\generated.txt
```

## Rule of thumb

- Do not pass 1000+ lines as one inline shell argument.
- Do not rely on `-Body '{ ...huge json... }'` for large requests.
- Do not rely on `curl` quoting tricks when a payload file is available.
- If the content is large, save it first and send only the path.
