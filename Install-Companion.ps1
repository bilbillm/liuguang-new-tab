$ErrorActionPreference = 'Stop'

$hostName = 'com.lumoren.edge_wallpaper_preview'
$extensionId = 'hehajkmlmaeedjcaindjmcnjafilemjj'
$program = Join-Path $PSScriptRoot 'companion/runtime/WallpaperCompanion.exe'
if (!(Test-Path -LiteralPath $program -PathType Leaf)) { throw 'WallpaperCompanion.exe is missing from companion/runtime.' }

$installDir = Join-Path $env:LOCALAPPDATA 'LiuguangEdgePreview'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$manifest = Join-Path $installDir "$hostName.json"
$settings = @{
    name = $hostName
    description = 'Local Wallpaper Engine library and playback for Liuguang New Tab'
    path = $program
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}
[IO.File]::WriteAllText($manifest, ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

$registryPath = "Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
try { $key.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $key.Dispose() }
Write-Output 'Wallpaper Engine companion registered for this Windows user.'
