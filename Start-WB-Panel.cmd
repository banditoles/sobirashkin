@echo off
setlocal
set "WB_PANEL_SCRIPT=%~dp0wb-live.cjs"
set "WB_PANEL_BUNDLED_NODE=%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1119-907-0_26.1119.907.0_x64__3k8sg7r9htsxt\dependencies\node\bin\node.exe"
powershell.exe -NoLogo -NoProfile -Command "$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source; if (-not $node) { $node = $env:WB_PANEL_BUNDLED_NODE }; if (-not (Test-Path -LiteralPath $node)) { Write-Error 'Node.js is unavailable'; exit 1 }; & $node $env:WB_PANEL_SCRIPT; exit $LASTEXITCODE"
if errorlevel 1 pause
