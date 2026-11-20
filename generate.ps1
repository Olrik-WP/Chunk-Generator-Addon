$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$Source = Join-Path $ProjectRoot "src"
$ManifestPath = Join-Path $Source "manifest.json"
$PackName = "Chunk Generator - aceinetx"
$BaseName = "ChunkGenerator-aceinetx-v1.0.1"
$Output = Join-Path $ProjectRoot "$BaseName.mcpack"
$TempZip = Join-Path $ProjectRoot "$BaseName.$([guid]::NewGuid().ToString('N')).build.zip"
$RequiredFiles = @("manifest.json", "scripts/main.js", "scripts/generation.js", "pack_icon.png")

foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $RelativePath) -PathType Leaf)) {
        throw "Missing source file: $RelativePath"
    }
}

# A build validates metadata; it must not rewrite the source manifest.
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($Manifest.header.name -cne $PackName -or ($Manifest.header.version -join ".") -ne "1.0.1") {
    throw "Expected pack name '$PackName', version 1.0.1."
}
if ($Manifest.header.uuid -ne "9896eaf3-0251-496a-a122-54d44e04cd17") {
    throw "The existing pack UUID must be preserved."
}
$ModuleIds = @{
    data = "0de16d3a-0524-409e-9ad0-23286b71d970"
    script = "a6436a08-0ea8-41c3-88d6-a0a7b0c744fd"
}
if ($Manifest.modules.Count -ne 2 -or @($Manifest.modules.type | Select-Object -Unique).Count -ne 2) {
    throw "Expected one data module and one script module."
}
foreach ($Module in $Manifest.modules) {
    if (-not $ModuleIds.ContainsKey($Module.type) -or $Module.uuid -ne $ModuleIds[$Module.type] -or
        ($Module.version -join ".") -ne "1.0.1") {
        throw "Module UUID or version was changed: $($Module.type)"
    }
    if ($Module.type -eq "script" -and ($Module.entry -ne "scripts/main.js" -or $Module.language -ne "javascript")) {
        throw "Invalid JavaScript entry point."
    }
}
$ExpectedDependencies = @{ "@minecraft/server" = "2.8.0"; "@minecraft/server-ui" = "2.1.0" }
if ($Manifest.dependencies.Count -ne 2 -or @($Manifest.dependencies.module_name | Select-Object -Unique).Count -ne 2) {
    throw "Expected the two existing stable Minecraft API dependencies."
}
foreach ($Dependency in $Manifest.dependencies) {
    if (-not $ExpectedDependencies.ContainsKey($Dependency.module_name) -or
        $Dependency.version -ne $ExpectedDependencies[$Dependency.module_name]) {
        throw "Unexpected dependency: $($Dependency.module_name) $($Dependency.version)"
    }
}
$MainScript = Get-Content -LiteralPath (Join-Path $Source "scripts/main.js") -Raw -Encoding utf8
foreach ($Command in @("gui", "generate", "radius", "stop")) {
    if (-not $MainScript.Contains("chunk_generator:$Command")) { throw "Missing command: $Command" }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[string[]]$SourceFiles = @(Get-ChildItem -LiteralPath $Source -Recurse -File | ForEach-Object { $_.FullName })
[Array]::Sort($SourceFiles, [StringComparer]::Ordinal)

try {
    # Stable ordering and timestamps make repeated builds reproducible on the
    # same PowerShell/.NET runtime, without modifying any source file.
    $ArchiveStream = [System.IO.File]::Open($TempZip, [System.IO.FileMode]::CreateNew)
    try {
        $Archive = [System.IO.Compression.ZipArchive]::new($ArchiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($SourceFile in $SourceFiles) {
                $EntryName = $SourceFile.Substring($Source.Length + 1).Replace('\', '/')
                $Entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
                $Entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                $EntryStream = $Entry.Open()
                try {
                    $InputStream = [System.IO.File]::OpenRead($SourceFile)
                    try { $InputStream.CopyTo($EntryStream) } finally { $InputStream.Dispose() }
                } finally { $EntryStream.Dispose() }
            }
        } finally { $Archive.Dispose() }
    } finally { $ArchiveStream.Dispose() }

    $Verification = [System.IO.Compression.ZipFile]::OpenRead($TempZip)
    $HashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        if ($Verification.Entries.Count -ne $SourceFiles.Count) { throw "Unexpected archive file count." }
        foreach ($RequiredFile in $RequiredFiles) {
            if ($null -eq $Verification.GetEntry($RequiredFile)) { throw "Missing archive entry: $RequiredFile" }
        }
        foreach ($SourceFile in $SourceFiles) {
            $EntryName = $SourceFile.Substring($Source.Length + 1).Replace('\', '/')
            $EntryStream = $Verification.GetEntry($EntryName).Open()
            try { $EntryDigest = [Convert]::ToBase64String($HashAlgorithm.ComputeHash($EntryStream)) }
            finally { $EntryStream.Dispose() }
            $InputStream = [System.IO.File]::OpenRead($SourceFile)
            try { $SourceDigest = [Convert]::ToBase64String($HashAlgorithm.ComputeHash($InputStream)) }
            finally { $InputStream.Dispose() }
            if ($EntryDigest -ne $SourceDigest) { throw "Archive content differs from source: $EntryName" }
        }
    } finally { $HashAlgorithm.Dispose(); $Verification.Dispose() }

    # Keep the previous pack until the complete new archive has been verified.
    Move-Item -LiteralPath $TempZip -Destination $Output -Force
} finally {
    if (Test-Path -LiteralPath $TempZip) { Remove-Item -LiteralPath $TempZip -Force }
}

Write-Host "Build successful" -ForegroundColor Green
Write-Host "Name: $PackName"
Write-Host "Version: 1.0.1"
Write-Host "Output: $Output"
