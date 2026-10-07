$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-Value($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Get-TokenValues($Value) {
    [ordered]@{
        inputTokens = [long](Get-Value $Value 'input_tokens' 0)
        cachedInputTokens = [long](Get-Value $Value 'cached_input_tokens' 0)
        cacheWriteInputTokens = [long](Get-Value $Value 'cache_write_input_tokens' 0)
        outputTokens = [long](Get-Value $Value 'output_tokens' 0)
        reasoningOutputTokens = [long](Get-Value $Value 'reasoning_output_tokens' 0)
        totalTokens = [long](Get-Value $Value 'total_tokens' 0)
    }
}

function Test-SameTokenValues($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    foreach ($name in @('inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens')) {
        if ([long]$Left[$name] -ne [long]$Right[$name]) { return $false }
    }
    return $true
}

function Get-RecoveredTokenValues($Reported, $PreviousTotal, $CurrentTotal) {
    if ([long]$Reported['totalTokens'] -le ([long]$Reported['inputTokens'] + [long]$Reported['outputTokens'])) { return $Reported }
    if ($null -eq $CurrentTotal) { return $Reported }
    if ($null -eq $PreviousTotal) { $PreviousTotal = Get-TokenValues $null }
    $delta = [ordered]@{
        inputTokens = [long]$CurrentTotal['inputTokens'] - [long]$PreviousTotal['inputTokens']
        cachedInputTokens = [long]$CurrentTotal['cachedInputTokens'] - [long]$PreviousTotal['cachedInputTokens']
        cacheWriteInputTokens = [long]$CurrentTotal['cacheWriteInputTokens'] - [long]$PreviousTotal['cacheWriteInputTokens']
        outputTokens = [long]$CurrentTotal['outputTokens'] - [long]$PreviousTotal['outputTokens']
        reasoningOutputTokens = [long]$CurrentTotal['reasoningOutputTokens'] - [long]$PreviousTotal['reasoningOutputTokens']
        totalTokens = [long]$CurrentTotal['totalTokens'] - [long]$PreviousTotal['totalTokens']
    }
    foreach ($name in @('inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens')) {
        if ([long]$delta[$name] -lt 0) { return $Reported }
    }
    if ([long]$delta['totalTokens'] -eq [long]$Reported['totalTokens'] -and
        [long]$delta['totalTokens'] -le ([long]$delta['inputTokens'] + [long]$delta['outputTokens'])) {
        return $delta
    }
    return $Reported
}

function Add-Count([hashtable]$Counts, [string]$Name) {
    $clean = $Name.Trim().Trim('/')
    if (-not $clean) { return }
    if ($Counts.ContainsKey($clean)) { $Counts[$clean] += 1 } else { $Counts[$clean] = 1 }
}

function Get-PluginForTool([string]$Name) {
    if ($Name.StartsWith('mcp__node_repl__')) { return 'Browser' }
    if ($Name.StartsWith('image_gen__')) { return 'ImageGen' }
    if ($Name.StartsWith('web__')) { return 'Web' }
    if ($Name.Contains('figma')) { return 'Figma' }
    return $null
}

function Get-PluginForPath([string]$Path) {
    if ($Path.Contains('openai-bundled/browser')) { return 'Browser' }
    if ($Path.Contains('build-web-apps')) { return 'Build Web Apps' }
    if ($Path.Contains('build-web-data-visualization')) { return 'Data Visualization' }
    if ($Path.Contains('codex-security')) { return 'Codex Security' }
    if ($Path.Contains('/figma/')) { return 'Figma' }
    if ($Path.Contains('/hugging-face/')) { return 'Hugging Face' }
    if ($Path.Contains('/notion/')) { return 'Notion' }
    if ($Path.Contains('openai-primary-runtime')) { return 'Artifact Tools' }
    return $null
}

function Analyze-ToolText([string]$Raw, [hashtable]$Skills, [hashtable]$Plugins) {
    $normalized = $Raw.Replace('\', '/')
    foreach ($match in [regex]::Matches($normalized, '/([^/]+)/SKILL\.md')) {
        Add-Count $Skills $match.Groups[1].Value
        $plugin = Get-PluginForPath $normalized.Substring(0, $match.Index)
        if ($plugin) { Add-Count $Plugins $plugin }
    }
    foreach ($match in [regex]::Matches($normalized, 'tools\.([A-Za-z0-9_]+)')) {
        $plugin = Get-PluginForTool $match.Groups[1].Value
        if ($plugin) { Add-Count $Plugins $plugin }
    }
}

function Get-ProjectName([string]$Path) {
    if (-not $Path) { return '未知專案' }
    $parts = $Path.Replace('\', '/').TrimEnd('/').Split('/') | Where-Object { $_ }
    if ($parts.Count -eq 0) { return '未知專案' }
    return $parts[-1]
}

function Convert-Counts([hashtable]$Values) {
    [object[]]($Values.GetEnumerator() | Sort-Object Name | ForEach-Object { [ordered]@{ name = $_.Name; count = [long]$_.Value } })
}

function Convert-Session([string]$Path) {
    $sessionId = ''
    $origin = 'Codex'
    $startedAt = ''
    $endedAt = ''
    $project = '未知專案'
    $model = '未知模型'
    $serviceTier = 'default'
    $reasoningEffort = 'unknown'
    $totals = Get-TokenValues $null
    $turns = New-Object System.Collections.Generic.List[object]
    $skills = @{}
    $plugins = @{}
    $efforts = @{}
    $rateUsedPercent = $null
    $rateWindowMinutes = $null
    $previousTotalSnapshot = $null
    $scanComplete = $true
    $shared = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $shared)
    $reader = $null
    try {
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
        while (($line = $reader.ReadLine()) -ne $null) {
            # Message bodies/tool results are irrelevant to aggregates and can be huge.
            # Only tool invocations contribute activity; avoid deserializing their results.
            if ($line -match '"type"\s*:\s*"response_item"' -and $line -notmatch '"type"\s*:\s*"(custom_tool_call|function_call)"') { continue }
            if ($line -match '"type"\s*:\s*"event_msg"' -and $line -notmatch '"type"\s*:\s*"(token_count|thread_settings_applied)"') { continue }
            $timestamp = ''
            if ($line -match '"timestamp"\s*:\s*"([^"]*)"') { $timestamp = $Matches[1] }
            try { $value = $line | ConvertFrom-Json -ErrorAction Stop } catch { if ($line.Trim()) { $scanComplete = $false }; continue }
            if (-not $timestamp) { $timestamp = [string](Get-Value $value 'timestamp' '') }
            $kind = [string](Get-Value $value 'type' '')
            $payload = Get-Value $value 'payload' $null
            if ($kind -eq 'session_meta') {
                $sessionId = [string](Get-Value $payload 'id' (Get-Value $payload 'session_id' ''))
                $startedAt = $timestamp
                $endedAt = $startedAt
                $origin = [string](Get-Value $payload 'originator' 'Codex')
                $project = Get-ProjectName ([string](Get-Value $payload 'cwd' ''))
            } elseif ($kind -eq 'turn_context') {
                $nextModel = [string](Get-Value $payload 'model' '')
                if ($nextModel) { $model = $nextModel }
                $cwd = [string](Get-Value $payload 'cwd' '')
                if ($cwd) { $project = Get-ProjectName $cwd }
                $effort = [string](Get-Value $payload 'effort' '')
                if ($effort) { $reasoningEffort = $effort.Trim(); Add-Count $efforts $reasoningEffort }
            } elseif ($kind -eq 'event_msg' -and (Get-Value $payload 'type' '') -eq 'thread_settings_applied') {
                $settings = Get-Value $payload 'thread_settings' $null
                $nextModel = [string](Get-Value $settings 'model' '')
                if (-not [string]::IsNullOrWhiteSpace($nextModel)) { $model = $nextModel }
                $reportedTier = Get-Value $settings 'service_tier' $null
                if ($null -ne $reportedTier) {
                    $serviceTier = if (@('priority', 'fast') -contains ([string]$reportedTier).Trim().ToLowerInvariant()) { 'priority' } else { 'default' }
                }
            } elseif ($kind -eq 'event_msg' -and (Get-Value $payload 'type' '') -eq 'token_count') {
                $info = Get-Value $payload 'info' $null
                $totalUsage = Get-Value $info 'total_token_usage' $null
                $isDuplicateSnapshot = $false
                $currentTotalSnapshot = $null
                if ($null -ne $totalUsage) {
                    $currentTotalSnapshot = Get-TokenValues $totalUsage
                    $isDuplicateSnapshot = Test-SameTokenValues $currentTotalSnapshot $previousTotalSnapshot
                }
                $lastUsage = Get-Value $info 'last_token_usage' $null
                if (-not $isDuplicateSnapshot -and $null -ne $lastUsage) {
                    $usage = Get-RecoveredTokenValues (Get-TokenValues $lastUsage) $previousTotalSnapshot $currentTotalSnapshot
                    $cacheRate = if ($usage.inputTokens -gt 0) { $usage.cachedInputTokens / $usage.inputTokens * 100.0 } else { 0.0 }
                    [void]$turns.Add([ordered]@{ ordinal = $turns.Count + 1; timestamp = $timestamp; model = $model; serviceTier = $serviceTier; reasoningEffort = $reasoningEffort; tokens = $usage; estimateMicrousd = $null; cacheRate = $cacheRate })
                } elseif (-not $isDuplicateSnapshot -and $null -ne $currentTotalSnapshot) {
                    $previous = if ($null -ne $previousTotalSnapshot) { [long]$previousTotalSnapshot['totalTokens'] } else { 0 }
                    $current = [long]$currentTotalSnapshot['totalTokens']
                    $missing = if ($current -ge $previous) { $current - $previous } else { $current }
                    if ($missing -gt 0) {
                        $usage = Get-TokenValues $null
                        $usage['totalTokens'] = $missing
                        [void]$turns.Add([ordered]@{ ordinal = $turns.Count + 1; timestamp = $timestamp; model = '未知模型'; serviceTier = 'default'; reasoningEffort = 'unknown'; tokens = $usage; estimateMicrousd = $null; cacheRate = 0 })
                    }
                }
                if ($null -ne $currentTotalSnapshot) { $previousTotalSnapshot = $currentTotalSnapshot }
                $primary = Get-Value (Get-Value $payload 'rate_limits' $null) 'primary' $null
                $rateUsedPercent = Get-Value $primary 'used_percent' $null
                $rateWindowMinutes = Get-Value $primary 'window_minutes' $null
                if ($timestamp) { $endedAt = $timestamp }
            } elseif ($kind -eq 'response_item' -and @('custom_tool_call', 'function_call') -contains (Get-Value $payload 'type' '')) {
                $plugin = Get-PluginForTool ([string](Get-Value $payload 'name' ''))
                if ($plugin) { Add-Count $plugins $plugin }
                $raw = [string](Get-Value $payload 'input' (Get-Value $payload 'arguments' ''))
                if ($raw) { Analyze-ToolText $raw $skills $plugins }
            }
        }
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        $stream.Dispose()
    }
    if (-not $sessionId) { return $null }
    if (-not $startedAt) { $startedAt = $endedAt }
    $firstKnownModel = $turns | ForEach-Object { $_['model'] } | Where-Object { $_ -ne '未知模型' } | Select-Object -First 1
    if (-not $firstKnownModel -and $model -ne '未知模型') { $firstKnownModel = $model }
    if ($firstKnownModel) {
        foreach ($turn in $turns) {
            if ($turn['model'] -ne '未知模型') { break }
            $turn['model'] = $firstKnownModel
        }
    }
    $skillCounts = @()
    $pluginCounts = @()
    $effortCounts = @()
    if ($skills.Count -gt 0) { $skillCounts = [object[]](Convert-Counts $skills) }
    if ($plugins.Count -gt 0) { $pluginCounts = [object[]](Convert-Counts $plugins) }
    if ($efforts.Count -gt 0) { $effortCounts = [object[]](Convert-Counts $efforts) }
    foreach ($turn in $turns) {
        foreach ($name in @('inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens')) {
            $totals[$name] += [long]$turn['tokens'][$name]
        }
    }
    [ordered]@{
        scanComplete = $scanComplete
        sessionId = $sessionId; sourceId = ''; sourceName = ''; sourceKind = 'ssh'
        project = $project; model = $model; startedAt = $startedAt; endedAt = $endedAt; origin = $origin
        tokens = $totals; activityTokens = $totals.totalTokens; estimateMicrousd = $null
        tokenEventCount = $turns.Count; rateUsedPercent = $rateUsedPercent; rateWindowMinutes = $rateWindowMinutes
        activity = [ordered]@{ skills = $skillCounts; plugins = $pluginCounts; efforts = $effortCounts }
        turns = [object[]]$turns.ToArray()
    }
}

function Add-CodexRoot([string]$Path, [System.Collections.Generic.List[string]]$Roots, [hashtable]$Seen) {
    if (-not $Path) { return }
    $clean = [System.Environment]::ExpandEnvironmentVariables($Path.Trim()).TrimEnd('\', '/')
    if (-not $clean) { return }
    $key = $clean.ToLowerInvariant()
    if ($Seen.ContainsKey($key)) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $clean 'sessions') -PathType Container) -and
        -not (Test-Path -LiteralPath (Join-Path $clean 'archived_sessions') -PathType Container)) { return }
    $Seen[$key] = $true
    [void]$Roots.Add($clean)
}

$since = $null
if ($SinceIso) { try { $since = [DateTimeOffset]::Parse($SinceIso).UtcDateTime.AddHours(-6) } catch {} }
$roots = New-Object 'System.Collections.Generic.List[string]'
$seenRoots = @{}
if ($CodexHome) {
    Add-CodexRoot $CodexHome $roots $seenRoots
} else {
    if ($env:CODEX_HOME) { Add-CodexRoot $env:CODEX_HOME $roots $seenRoots }
    $profileRoot = [System.Environment]::GetFolderPath('UserProfile')
    if (-not $profileRoot) { $profileRoot = $env:USERPROFILE }
    if ($profileRoot) { Add-CodexRoot (Join-Path $profileRoot '.codex') $roots $seenRoots }

    # Codex running inside an already-active WSL distribution writes to that Linux user's ~/.codex.
    # Probe every readable Linux home in an active distribution without starting stopped distributions.
    foreach ($providerRoot in @('\\wsl.localhost', '\\wsl$')) {
        try {
            if (-not (Test-Path -LiteralPath $providerRoot -PathType Container -ErrorAction SilentlyContinue)) { continue }
            foreach ($distribution in Get-ChildItem -LiteralPath $providerRoot -Directory -ErrorAction SilentlyContinue) {
                $linuxHomes = Join-Path $distribution.FullName 'home'
                if (Test-Path -LiteralPath $linuxHomes -PathType Container -ErrorAction SilentlyContinue) {
                    foreach ($userHome in Get-ChildItem -LiteralPath $linuxHomes -Directory -ErrorAction SilentlyContinue) {
                        Add-CodexRoot (Join-Path $userHome.FullName '.codex') $roots $seenRoots
                    }
                }
                Add-CodexRoot (Join-Path $distribution.FullName 'root\.codex') $roots $seenRoots
            }
        } catch { continue }
    }
}

if ($roots.Count -eq 0) {
    [Console]::Error.Write('CODEX_SESSIONS_NOT_FOUND')
    exit 3
}

$skippedFiles = 0
foreach ($root in $roots) {
    foreach ($folder in @('sessions', 'archived_sessions')) {
        $base = Join-Path $root $folder
        if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }
        $enumerationErrors = @()
        foreach ($file in Get-ChildItem -LiteralPath $base -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue -ErrorVariable enumerationErrors) {
            if ($null -ne $since -and $file.LastWriteTimeUtc -le $since) { continue }
            try { $result = Convert-Session $file.FullName } catch { $skippedFiles += 1; continue }
            if ($null -ne $result) {
                [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
                if (-not $result['scanComplete']) { $skippedFiles += 1 }
            } else { $skippedFiles += 1 }
        }
        $skippedFiles += $enumerationErrors.Count
    }
}
[Console]::Out.WriteLine((@{ scanSummary = @{ skippedFiles = $skippedFiles } } | ConvertTo-Json -Compress))
