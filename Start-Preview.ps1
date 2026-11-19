$ErrorActionPreference = 'Stop'

$candidates = @(
    (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft/Edge/Application/msedge.exe'),
    (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Microsoft/Edge/Application/msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft/Edge/Application/msedge.exe')
)
$edge = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$edge) { throw 'Microsoft Edge could not be found.' }

& (Join-Path $PSScriptRoot 'Install-Companion.ps1')
$extension = Join-Path $PSScriptRoot 'extension'
$profile = Join-Path $env:LOCALAPPDATA 'LiuguangEdgePreview/BrowserProfile'
Start-Process -FilePath $edge -WindowStyle Normal -ArgumentList @(
    "--user-data-dir=`"$profile`"",
    "--disable-extensions-except=`"$extension`"",
    "--load-extension=`"$extension`"",
    '--no-first-run',
    '--no-default-browser-check',
    'edge://newtab/'
)
