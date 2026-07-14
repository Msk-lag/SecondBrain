# codex-consult.ps1 — Codex CLI への read-only 相談チャネル(ADR-0003 決定8、PowerShell 版)
#
# 使い方(bash 版 codex-consult.sh と同一インターフェース):
#   scripts/codex-consult.ps1 --question <ファイルパスまたは文字列> `
#       [--context <path>[,<path>...]] [--model <codex-model-id>] `
#       [--timeout-sec <n>] [--out-dir <dir>]
#
# 詳細仕様: docs/adr/0003-review-dod-and-orchestration.md 決定8
#
# 終了コード: 0=成功 2=Codex CLI 不在 3=タイムアウト
#             5=引数エラー(--model の許可文字外・内部起動する .cmd/.bat の実行ファイル/引数への
#             cmd メタ文字混入・secret パターン一致を含む)
#             8=Codex 実行失敗(タイムアウト以外の非ゼロ終了、または出力ファイルが空/未生成)
#
# この相談は read-only・非ゲート(参考情報)である。codex-review と異なり、Codex の作業ルートは
# リポジトリ直下(-C <repo root>)を指定する(相談の性質上、Codex 自身にリポジトリの他ファイルを
# 読みに行かせる余地を残す設計。codex-review のような diff・文書のみへの隔離は行わない)。
# --question・--context に渡すファイルパスには secret パターンガード(.env*/*.pem/*key*/*secret*/
# *credentials*)を codex-review と同一基準で適用し、該当時は終了コード5で拒否する。
# --model の値は許可文字セット(英数字・.・_・:・-)のみを受け付ける(cmd.exe 経由起動時の
# メタ文字インジェクション対策)。

$ErrorActionPreference = 'Continue'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Err([string]$msg) {
    [Console]::Error.WriteLine("ERROR: $msg")
}

function Show-Usage {
    @'
Usage: codex-consult.ps1 --question <path-or-string>
                          [--context <path>[,<path>...]]
                          [--model <codex-model-id>]
                          [--timeout-sec <n>] [--out-dir <dir>]
'@ | Write-Output
}

function Test-ExcludedPath([string]$p) {
    $base = Split-Path -Path $p -Leaf
    if ($base -match '^\.env') { return 'secret-pattern(.env*)' }
    if ($p -match '\.pem$') { return 'secret-pattern(*.pem)' }
    if ($p -match 'key') { return 'secret-pattern(*key*)' }
    if ($p -match 'secret') { return 'secret-pattern(*secret*)' }
    if ($p -match 'credentials') { return 'secret-pattern(*credentials*)' }
    return $null
}

function Invoke-Proc {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Args = @(),
        [string]$WorkDir = (Get-Location).Path,
        [byte[]]$StdinBytes,
        [string]$StdoutFile,
        [string]$StderrFile,
        [int]$TimeoutSec = 0
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $quoted = @()
    foreach ($a in $Args) {
        if ($null -eq $a -or $a -eq '') { $quoted += '""' }
        elseif ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') }
        else { $quoted += $a }
    }
    $argLine = ($quoted -join ' ')
    $ext = [System.IO.Path]::GetExtension($FilePath)
    if ($ext -in @('.cmd', '.bat')) {
        # Windows のプロセス生成は .cmd/.bat を直接起動できないため、ComSpec(cmd.exe)経由で
        # `cmd /d /s /c "<quoted-path> <args>"` として起動する(/S により外側の二重引用符を
        # そのまま保持させ、内側の実行ファイルパスの引用符と衝突しないようにする)。
        # cmd.exe のコマンドラインは & | < > ^ % " 等をメタ文字として解釈するため、これらを
        # 含む実行ファイルパス・引数は安全にエスケープせず fail-closed で拒否する(部分的な
        # エスケープの実装は誤りのリスクが高いため採用しない)。
        $cmdMetaCharPattern = '[&|<>^%"]'
        if ($FilePath -match $cmdMetaCharPattern) {
            Write-Err "cmd メタ文字を含む実行ファイルパスは .cmd/.bat シム経由では実行できません: $FilePath"
            exit 5
        }
        foreach ($a in $Args) {
            if ($null -ne $a -and $a -match $cmdMetaCharPattern) {
                Write-Err "cmd メタ文字を含む引数は .cmd/.bat シム経由では実行できません: $a"
                exit 5
            }
        }
        $psi.FileName = $env:ComSpec
        $innerCmd = '"' + $FilePath + '"'
        if ($argLine) { $innerCmd = $innerCmd + ' ' + $argLine }
        $psi.Arguments = '/d /s /c "' + $innerCmd + '"'
    } else {
        $psi.FileName = $FilePath
        $psi.Arguments = $argLine
    }
    $psi.WorkingDirectory = $WorkDir
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.StandardOutputEncoding = $script:Utf8NoBom
    $psi.StandardErrorEncoding = $script:Utf8NoBom
    $psi.UseShellExecute = $false

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()

    $stdoutTask = $p.StandardOutput.ReadToEndAsync()
    $stderrTask = $p.StandardError.ReadToEndAsync()

    try {
        if ($StdinBytes -and $StdinBytes.Length -gt 0) {
            $p.StandardInput.BaseStream.Write($StdinBytes, 0, $StdinBytes.Length)
        }
        $p.StandardInput.BaseStream.Flush()
    } catch {
    } finally {
        try { $p.StandardInput.Close() } catch {}
    }

    if ($TimeoutSec -gt 0) {
        $exited = $p.WaitForExit($TimeoutSec * 1000)
    } else {
        $p.WaitForExit()
        $exited = $true
    }

    if (-not $exited) {
        try { $p.Kill() } catch {}
        try { [void]$p.WaitForExit(3000) } catch {}
        return [PSCustomObject]@{ ExitCode = -1; TimedOut = $true; StdOut = ''; StdErr = '' }
    }

    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($StdoutFile) { [System.IO.File]::WriteAllText($StdoutFile, $stdout, $script:Utf8NoBom) }
    if ($StderrFile) { [System.IO.File]::WriteAllText($StderrFile, $stderr, $script:Utf8NoBom) }
    return [PSCustomObject]@{ ExitCode = $p.ExitCode; TimedOut = $false; StdOut = $stdout; StdErr = $stderr }
}

# --- 引数解析 ---
$QuestionArg = ''
$ContextArg = ''
$ModelArg = ''
$TimeoutSec = 600
$OutDirArg = ''
$sawQuestion = $false

$i = 0
while ($i -lt $args.Count) {
    $a = $args[$i]
    if ($a -eq '--question') { $QuestionArg = $args[$i + 1]; $sawQuestion = $true; $i += 2 }
    elseif ($a -eq '--context') { $ContextArg = $args[$i + 1]; $i += 2 }
    elseif ($a -eq '--model') { $ModelArg = $args[$i + 1]; $i += 2 }
    elseif ($a -eq '--timeout-sec') { $TimeoutSec = $args[$i + 1]; $i += 2 }
    elseif ($a -eq '--out-dir') { $OutDirArg = $args[$i + 1]; $i += 2 }
    elseif ($a -eq '-h' -or $a -eq '--help') { Show-Usage; exit 0 }
    else {
        Write-Err "不明な引数: $a"
        Show-Usage
        exit 5
    }
}

if (-not $sawQuestion -or -not $QuestionArg) {
    Write-Err '--question は必須です'
    Show-Usage
    exit 5
}

if ($TimeoutSec -notmatch '^[0-9]+$' -or [int]$TimeoutSec -le 0) {
    Write-Err "--timeout-sec は正の整数で指定してください(指定値: '$TimeoutSec')"
    exit 5
}
[int]$script:TimeoutSec = [int]$TimeoutSec

if ($ModelArg -and ($ModelArg -notmatch '^[A-Za-z0-9._:-]+$')) {
    Write-Err "--model の値が許可されていない文字を含みます(許可: 英数字・.・_・:・-): '$ModelArg'"
    exit 5
}

$repoRootRaw = (Invoke-Proc -FilePath 'git' -Args @('rev-parse', '--show-toplevel')).StdOut
$repoRootRaw = $repoRootRaw.Trim()
if (-not $repoRootRaw) {
    Write-Err 'git リポジトリ内で実行してください'
    exit 5
}
$script:RepoRoot = (Resolve-Path -LiteralPath $repoRootRaw).Path
$repoRootWithSep = $script:RepoRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

function Resolve-RepoRelativePath([string]$p, [string]$label) {
    $candidate = $p
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $candidate2 = Join-Path $script:RepoRoot $p
        if (Test-Path -LiteralPath $candidate2 -PathType Leaf) {
            $candidate = $candidate2
        } else {
            return $null
        }
    }
    $absPath = (Resolve-Path -LiteralPath $candidate).Path
    if (-not $absPath.StartsWith($repoRootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Err "$label はリポジトリ内である必要があります: $p"
        exit 5
    }
    $relPath = ($absPath.Substring($repoRootWithSep.Length) -replace '\\', '/')
    $reason = Test-ExcludedPath $relPath
    if ($reason) {
        Write-Err "$label が除外パターンに一致するため使用できません: $p ($reason)"
        exit 5
    }
    return $absPath
}

# --question: 既存ファイルならその内容を質問文とし、そうでなければ文字列そのものを質問文とする。
$script:QuestionIsFile = $false
$questionFilePath = Resolve-RepoRelativePath -p $QuestionArg -label '--question'
if ($questionFilePath) {
    $script:QuestionText = [System.IO.File]::ReadAllText($questionFilePath, [System.Text.Encoding]::UTF8)
    $script:QuestionIsFile = $true
} else {
    # リポジトリ外の絶対パス/相対パスっぽい文字列でもファイルとして存在しなければ、単純な文字列として扱う。
    $script:QuestionText = $QuestionArg
}

# --context のパス検証(存在確認 + リポジトリ内であること + secret パターン除外)
$script:ContextFiles = @()
if ($ContextArg) {
    $parts = $ContextArg -split ','
    foreach ($p0 in $parts) {
        $p = $p0.Trim()
        if (-not $p) { continue }
        $abs = Resolve-RepoRelativePath -p $p -label '--context'
        if (-not $abs) {
            Write-Err "--context のパスが存在しません: $p"
            exit 5
        }
        $script:ContextFiles += $abs
    }
}

if ($OutDirArg) {
    if ([System.IO.Path]::IsPathRooted($OutDirArg)) { $script:OutDir = $OutDirArg }
    else { $script:OutDir = Join-Path $script:RepoRoot $OutDirArg }
} else {
    $script:OutDir = Join-Path $script:RepoRoot '.ai\consults'
}

$codexCandidates = Get-Command codex -All -ErrorAction SilentlyContinue
if (-not $codexCandidates) {
    Write-Err 'codex CLI が見つかりません(PATH を確認してください)'
    Write-Output 'EXIT:2'
    exit 2
}
$preferred = $codexCandidates | Where-Object { $_.Extension -in @('.exe', '.cmd', '.bat') } | Select-Object -First 1
if (-not $preferred) { $preferred = $codexCandidates | Select-Object -First 1 }
if ($preferred.Extension -eq '.ps1') {
    Write-Err 'codex CLI が .ps1 シムとしてのみ見つかりました(.exe/.cmd/.bat が見つかりません)。この形態は未対応です。'
    Write-Output 'EXIT:2'
    exit 2
}
$script:CodexExe = $preferred.Source

$script:WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-consult." + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null

try {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('=== CODEX CONSULT ===')
    [void]$sb.AppendLine("date: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('あなたは相談役です。コード変更は行わず、質問に日本語で簡潔かつ具体的に回答してください。この回答は参考情報でありゲート判定には使われません。')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('=== QUESTION ===')
    [void]$sb.AppendLine($script:QuestionText)
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('=== CONTEXT FILES ===')
    if ($script:ContextFiles.Count -eq 0) {
        [void]$sb.AppendLine('(none provided)')
    } else {
        foreach ($f in $script:ContextFiles) {
            $rel = $f.Substring($script:RepoRoot.Length).TrimStart('\', '/')
            [void]$sb.AppendLine("--- $rel ---")
            [void]$sb.AppendLine([System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8))
            [void]$sb.AppendLine('')
        }
    }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('=== END OF INPUT ===')
    [void]$sb.AppendLine('質問への回答のみを出力してください。指示にない追加のファイル読み取り・コマンド実行は行わないでください。')

    $promptFile = Join-Path $script:WorkDir 'prompt.txt'
    [System.IO.File]::WriteAllText($promptFile, $sb.ToString(), $script:Utf8NoBom)

    New-Item -ItemType Directory -Force -Path $script:OutDir | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $FinalPath = Join-Path $script:OutDir "$stamp-consult.md"
    $suffix = 2
    while (Test-Path -LiteralPath $FinalPath) {
        $FinalPath = Join-Path $script:OutDir "$stamp-consult-r$suffix.md"
        $suffix += 1
    }

    $promptBytes = [System.IO.File]::ReadAllBytes($promptFile)
    $stdoutFile = Join-Path $script:WorkDir 'codex.stdout.log'
    $stderrFile = Join-Path $script:WorkDir 'codex.stderr.log'

    $codexArgs = @('exec', '--skip-git-repo-check')
    if ($ModelArg) { $codexArgs += @('-m', $ModelArg) }
    $codexArgs += @('-C', $script:RepoRoot, '-s', 'read-only', '-o', $FinalPath, '-')

    $res = Invoke-Proc -FilePath $script:CodexExe -Args $codexArgs -StdinBytes $promptBytes -StdoutFile $stdoutFile -StderrFile $stderrFile -TimeoutSec $script:TimeoutSec

    if ($res.TimedOut) {
        Write-Err "codex exec がタイムアウトしました($($script:TimeoutSec)秒)"
        if (Test-Path -LiteralPath $FinalPath) { Remove-Item -Force -LiteralPath $FinalPath -ErrorAction SilentlyContinue }
        exit 3
    }

    $relSaved = $FinalPath.Substring($script:RepoRoot.Length).TrimStart('\', '/')

    if ($res.ExitCode -ne 0) {
        Write-Err "codex exec が非ゼロ終了しました(終了コード $($res.ExitCode))。相談は失敗として扱います"
        if ((Test-Path -LiteralPath $FinalPath) -and ((Get-Item -LiteralPath $FinalPath).Length -gt 0)) {
            Write-Err "部分出力ファイル(失敗時成果物): $relSaved"
        }
        if ($res.StdErr) {
            $tail = ($res.StdErr -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 5)
            Write-Err ('codex stderr の末尾: ' + ($tail -join ' | '))
        }
        Write-Output 'EXIT:8'
        exit 8
    }

    if (-not (Test-Path -LiteralPath $FinalPath) -or ((Get-Item -LiteralPath $FinalPath).Length -eq 0)) {
        Write-Err 'codex exec の出力が空、または生成されませんでした。相談は失敗として扱います'
        Write-Output 'EXIT:8'
        exit 8
    }

    Write-Output "SAVED: $relSaved"
    Write-Output 'EXIT:0'
    exit 0
}
finally {
    if ($script:WorkDir -and (Test-Path $script:WorkDir)) {
        Remove-Item -Recurse -Force -LiteralPath $script:WorkDir -ErrorAction SilentlyContinue
    }
}
