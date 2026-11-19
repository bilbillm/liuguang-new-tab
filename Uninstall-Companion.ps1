$ErrorActionPreference = 'Stop'
$hostName = 'com.lumoren.edge_wallpaper_preview'
$registryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
$manifest = Join-Path $env:LOCALAPPDATA "LiuguangEdgePreview/$hostName.json"
if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest }
Write-Output 'Wallpaper Engine companion registration removed.'
