# codex-implement.ps1 — Codex CLI による実装実行ラッパー(規則 ROUTE-1、PowerShell 版)
#
# 使い方(bash 版 codex-implement.sh と同一インターフェース):
#   scripts/codex-implement.ps1 --packet <実装パケット md のパス> `
#       --allowed-paths <glob>[,<glob>...] `
#       [--model <codex-model-id>] [--timeout-sec <n>]
#
# 詳細仕様: docs/adr/0003-review-dod-and-orchestration.md 決定7(規則 ROUTE-1)、
#           docs/templates/implementation-packet.md
#
# 終了コード: 0=成功(範囲内変更のみ) 2=Codex CLI 不在 3=タイムアウト
#             5=事前検証・引数エラー(--packet のリポジトリ外/秘密情報パターン一致・--model の
#             許可文字外・内部起動する .cmd/.bat の実行ファイル/引数への cmd メタ文字混入・
#             --packet のシンボリックリンク段数超過を含む)
#             6=事後検証違反(範囲外変更・HEAD 変化・ブランチ変化・staged 非空・
#             ignored ファイル新規出現・任意 ref の作成/削除/移動)
#             8=Codex 実行失敗(タイムアウト以外の非ゼロ終了)
#
# 設計メモ:
#   - workspace-write サンドボックスで実行するため、実装対象は必ず feature/* ブランチ・
#     クリーンな作業ツリーに限定する(事前検証)。
#   - Codex は git 操作(add/commit/push/branch)禁止という指示をプロンプトに含めるが、
#     指示のみでは強制力が無いため、事後に HEAD・ブランチ名・staged・ignored ファイル一覧・
#     全 ref(for-each-ref)の不変性を機械検証する(git 操作自体を隔離実行環境で禁止するわけ
#     ではないため、範囲外変更が成功裏に行われる可能性をこの事後検証で検出する設計)。
#   - --allowed-paths の glob は "*" が単一パス階層内の任意文字列(パス区切り "/" を含まない)に、
#     "**" が階層をまたぐ任意文字列に一致する(一般的な glob 方言と同じ区別)。
#   - --packet のシンボリックリンクは最大10段まで解決を追跡し、10段を超える場合は拒否する
#     (循環・過度なリンクチェーンによる境界チェック回避を防ぐ)。
#
# 残余リスク(検出できない範囲):
#   - 既存の ignored ファイルの「内容」変更(node_modules 等、全内容のハッシュ比較は検査コスト
#     過大なため対象外)。

$ErrorActionPreference = 'Continue'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Err([string]$msg) {
    [Console]::Error.WriteLine("ERROR: $msg")
}

function Show-Usage {
    @'
Usage: codex-implement.ps1 --packet <path-to-implementation-packet.md>
                            --allowed-paths <glob>[,<glob>...]
                            [--model <codex-model-id>]
                            [--timeout-sec <n>]
'@ | Write-Output
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

function Test-ExcludedPath([string]$p) {
    # codex-consult.ps1 の Test-ExcludedPath と同一基準の secret パターンガード
    $base = Split-Path -Path $p -Leaf
    if ($base -match '^\.env') { return 'secret-pattern(.env*)' }
    if ($p -match '\.pem$') { return 'secret-pattern(*.pem)' }
    if ($p -match 'key') { return 'secret-pattern(*key*)' }
    if ($p -match 'secret') { return 'secret-pattern(*secret*)' }
    if ($p -match 'credentials') { return 'secret-pattern(*credentials*)' }
    return $null
}

function Convert-GlobToRegex([string]$glob) {
    $g = $glob.Trim() -replace '\\', '/'
    $g = $g -replace '^\./', ''
    $escaped = [regex]::Escape($g)
    # エスケープ後は元の '**' が '\*\*'(4文字)に、単体 '*' が '\*'(2文字)になる。
    # 先に '**' を退避してから単体 '*' を変換し、最後に退避分を '.*' へ戻す。
    $escaped = $escaped -replace '\\\*\\\*', "`u{2}DOUBLESTAR`u{2}"
    $escaped = $escaped -replace '\\\*', '[^/]*'
    $escaped = $escaped -replace "`u{2}DOUBLESTAR`u{2}", '.*'
    $escaped = $escaped -replace '\\\?', '[^/]'
    return '^' + $escaped + '$'
}

function Test-PathMatchesAnyGlob([string]$path, [string[]]$patterns) {
    $normalized = $path -replace '\\', '/'
    foreach ($pat in $patterns) {
        if (-not $pat) { continue }
        $rx = Convert-GlobToRegex $pat
        if ($normalized -match $rx) { return $true }
    }
    return $false
}

function Get-ChangedFilesFromPorcelain([string]$porcelainText) {
    # `git status --porcelain` の各行を解析し、作業ツリー上の現在パス一覧を返す。
    # rename ("R  old -> new") は new 側を対象パスとして扱う(old は情報として保持)。
    # 注意: 特殊文字を含むパスの git 側クォート(C スタイルエスケープ)は簡易的にダブルクォート
    # の除去のみ対応する(残余リスク。本ツールの用途上、パケットが通常の英数パスを想定するため許容)。
    $result = New-Object System.Collections.Generic.List[PSCustomObject]
    if (-not $porcelainText) { return $result }
    $lines = $porcelainText -split "`r?`n"
    foreach ($line in $lines) {
        if ($line.Length -lt 4) { continue }
        $status = $line.Substring(0, 2)
        $rest = $line.Substring(3)
        $oldPath = $null
        $newPath = $rest
        if ($rest -match '^(.*) -> (.*)$') {
            $oldPath = $Matches[1]
            $newPath = $Matches[2]
        }
        $newPath = $newPath.Trim('"')
        if ($oldPath) { $oldPath = $oldPath.Trim('"') }
        $result.Add([PSCustomObject]@{ Status = $status; Path = $newPath; OldPath = $oldPath })
    }
    return $result
}

# --- 引数解析 ---
$PacketArg = ''
$AllowedPathsArg = ''
$ModelArg = ''
$TimeoutSec = 1800
$sawPacket = $false
$sawAllowed = $false

$i = 0
while ($i -lt $args.Count) {
    $a = $args[$i]
    if ($a -eq '--packet') { $PacketArg = $args[$i + 1]; $sawPacket = $true; $i += 2 }
    elseif ($a -eq '--allowed-paths') { $AllowedPathsArg = $args[$i + 1]; $sawAllowed = $true; $i += 2 }
    elseif ($a -eq '--model') { $ModelArg = $args[$i + 1]; $i += 2 }
    elseif ($a -eq '--timeout-sec') { $TimeoutSec = $args[$i + 1]; $i += 2 }
    elseif ($a -eq '-h' -or $a -eq '--help') { Show-Usage; exit 0 }
    else {
        Write-Err "不明な引数: $a"
        Show-Usage
        exit 5
    }
}

if (-not $sawPacket -or -not $PacketArg) {
    Write-Err '--packet は必須です'
    Show-Usage
    exit 5
}
if (-not $sawAllowed -or -not $AllowedPathsArg) {
    Write-Err '--allowed-paths は必須です'
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

$script:AllowedPatterns = @($AllowedPathsArg -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
if ($script:AllowedPatterns.Count -eq 0) {
    Write-Err '--allowed-paths に有効なパターンがありません'
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

# --- packet ファイルの実体解決(シンボリックリンク解決込み)+ リポジトリ配下限定 + secret ガード ---
$script:PacketPath = $PacketArg
if (-not (Test-Path -LiteralPath $script:PacketPath -PathType Leaf)) {
    $candidate2 = Join-Path $script:RepoRoot $PacketArg
    if (Test-Path -LiteralPath $candidate2 -PathType Leaf) {
        $script:PacketPath = $candidate2
    } else {
        Write-Err "--packet のファイルが存在しません: $PacketArg"
        exit 5
    }
}
# Resolve-Path は相対パス・"."/".." を正規化する。シンボリックリンクの実体(Target)がある場合は
# 最大10段まで解決を追跡し、リポジトリ境界チェックの対象にする(10段を超える場合は拒否)。
$resolvedItem = Resolve-Path -LiteralPath $script:PacketPath
$script:PacketPath = $resolvedItem.Path
$linkDepth = 0
$maxLinkDepth = 10
try {
    while ($true) {
        $fileInfo = Get-Item -LiteralPath $script:PacketPath -ErrorAction Stop
        if (-not ($fileInfo.LinkType -and $fileInfo.Target)) { break }
        $linkDepth += 1
        if ($linkDepth -gt $maxLinkDepth) {
            Write-Err "--packet のシンボリックリンクが $maxLinkDepth 段を超えています(解決を中止します): $PacketArg"
            exit 5
        }
        $linkTarget = $fileInfo.Target | Select-Object -First 1
        if (-not $linkTarget) { break }
        if (-not [System.IO.Path]::IsPathRooted($linkTarget)) {
            $linkTarget = Join-Path (Split-Path -Path $script:PacketPath -Parent) $linkTarget
        }
        $script:PacketPath = (Resolve-Path -LiteralPath $linkTarget).Path
    }
} catch {
    Write-Err "--packet の実体パスを解決できませんでした: $PacketArg"
    exit 5
}
if (-not $script:PacketPath.StartsWith($repoRootWithSep, [System.StringComparison]::OrdinalIgnoreCase) -and ($script:PacketPath -ne $script:RepoRoot)) {
    Write-Err "--packet はリポジトリ配下である必要があります(シンボリックリンクの解決先を含む): $PacketArg -> $($script:PacketPath)"
    exit 5
}
$packetRelPath = ($script:PacketPath.Substring($repoRootWithSep.Length) -replace '\\', '/')
$packetExcludeReason = Test-ExcludedPath $packetRelPath
if ($packetExcludeReason) {
    Write-Err "--packet が除外パターンに一致するため使用できません: $PacketArg ($packetExcludeReason)"
    exit 5
}

# --- 事前検証: ブランチ ---
$branchRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
$script:CurrentBranch = $branchRes.StdOut.Trim()
if ($script:CurrentBranch -notmatch '^feature/') {
    Write-Err "現在のブランチが feature/* ではありません(現在: '$($script:CurrentBranch)')。codex-implement は feature ブランチでのみ実行できます"
    exit 5
}

# --- 事前検証: 作業ツリーがクリーンであること ---
$statusRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'status', '--porcelain')
if ($statusRes.StdOut.Trim()) {
    Write-Err '作業ツリーがクリーンではありません(git status --porcelain が空ではありません)。事前にコミット/退避してください'
    exit 5
}

# --- 事前検証: staged (index) が空であること(クリーン要件に含まれるはずだが明示検査する) ---
$stagedPreRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'diff', '--cached', '--name-only')
if ($stagedPreRes.StdOut.Trim()) {
    Write-Err 'index に staged な変更があります(codex-implement は staged が空の状態でのみ実行できます)'
    exit 5
}

# --- 開始時 HEAD・ブランチ・ignored ファイル一覧の記録(事後検証で不変性を確認するため) ---
$startHeadRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'rev-parse', 'HEAD')
$script:StartHead = $startHeadRes.StdOut.Trim()
if (-not $script:StartHead) {
    Write-Err '開始時の HEAD を取得できませんでした'
    exit 5
}
$script:StartBranch = $script:CurrentBranch
$preIgnoredRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'status', '--porcelain', '--ignored=matching')
$script:PreIgnored = @(($preIgnoredRes.StdOut -split "`r?`n") | Where-Object { $_ -like '!! *' })
$preRefsRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'for-each-ref', '--format=%(refname) %(objectname)')
$script:PreRefs = $preRefsRes.StdOut.Trim()

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

$script:WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-implement." + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null

try {
    $packetText = [System.IO.File]::ReadAllText($script:PacketPath, [System.Text.Encoding]::UTF8)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('=== CODEX IMPLEMENTATION TASK ===')
    [void]$sb.AppendLine("date: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")
    [void]$sb.AppendLine("branch: $($script:CurrentBranch)")
    [void]$sb.AppendLine("start-head: $($script:StartHead)")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('あなたは実装担当です。以下の実装パケットに厳密に従ってください。変更可能パス以外に触れた場合は失敗扱いになります。git 操作(add/commit/push/branch)は一切禁止です。停止条件に該当したら作業を止めて理由を報告してください。')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('=== IMPLEMENTATION PACKET ===')
    [void]$sb.AppendLine($packetText)
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('=== END OF INPUT ===')

    $promptFile = Join-Path $script:WorkDir 'prompt.txt'
    [System.IO.File]::WriteAllText($promptFile, $sb.ToString(), $script:Utf8NoBom)

    $OutDir = Join-Path $script:RepoRoot '.ai\implement-runs'
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $FinalPath = Join-Path $OutDir "$stamp-implement.md"
    $suffix = 2
    while (Test-Path -LiteralPath $FinalPath) {
        $FinalPath = Join-Path $OutDir "$stamp-implement-r$suffix.md"
        $suffix += 1
    }

    $promptBytes = [System.IO.File]::ReadAllBytes($promptFile)
    $stdoutFile = Join-Path $script:WorkDir 'codex.stdout.log'
    $stderrFile = Join-Path $script:WorkDir 'codex.stderr.log'

    $codexArgs = @('exec', '--skip-git-repo-check')
    if ($ModelArg) { $codexArgs += @('-m', $ModelArg) }
    $codexArgs += @('-C', $script:RepoRoot, '-s', 'workspace-write', '-o', $FinalPath, '-')

    $res = Invoke-Proc -FilePath $script:CodexExe -Args $codexArgs -StdinBytes $promptBytes -StdoutFile $stdoutFile -StderrFile $stderrFile -TimeoutSec $script:TimeoutSec

    if ($res.TimedOut) {
        Write-Err "codex exec がタイムアウトしました($($script:TimeoutSec)秒)。作業ツリーの状態を確認し、必要なら手動で後始末してください(revert はこのラッパーの責務外)"
        exit 3
    }

    $relSaved = $FinalPath.Substring($script:RepoRoot.Length).TrimStart('\', '/')

    if ($res.ExitCode -ne 0) {
        Write-Err "codex exec が非ゼロ終了しました(終了コード $($res.ExitCode))。実装は失敗として扱います"
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

    # --- 事後検証 1: HEAD が開始時と同一(commit されていないこと) ---
    $endHeadRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'rev-parse', 'HEAD')
    $endHead = $endHeadRes.StdOut.Trim()
    if ($endHead -ne $script:StartHead) {
        Write-Err "事後検証違反: HEAD が開始時( $($script:StartHead) )から変化しています(現在: $endHead)。Codex が git commit 等の操作を行った可能性があります。revert はせず報告のみ行います"
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:6'
        exit 6
    }

    # --- 事後検証 1b: ブランチ名が開始時と同一であること(checkout/branch 操作の検出) ---
    $endBranchRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
    $endBranch = $endBranchRes.StdOut.Trim()
    if ($endBranch -ne $script:StartBranch) {
        Write-Err "事後検証違反: ブランチが開始時( $($script:StartBranch) )から変化しています(現在: $endBranch)。revert はせず報告のみ行います"
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:6'
        exit 6
    }

    # --- 事後検証 1c: staged (index) が空のままであること(git add 操作の検出) ---
    $stagedPostRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'diff', '--cached', '--name-only')
    $stagedPost = $stagedPostRes.StdOut.Trim()
    if ($stagedPost) {
        Write-Err '事後検証違反: index に staged な変更が検出されました(Codex が git add を実行した可能性)。revert はせず報告のみ行います'
        foreach ($f in ($stagedPost -split "`r?`n")) { Write-Err "  - $f" }
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:6'
        exit 6
    }

    # --- 事後検証 1d: ignored ファイルの新規出現がないこと(--ignored=matching の事前/事後比較) ---
    $postIgnoredRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'status', '--porcelain', '--ignored=matching')
    $postIgnored = @(($postIgnoredRes.StdOut -split "`r?`n") | Where-Object { $_ -like '!! *' })
    $preIgnoredSet = New-Object System.Collections.Generic.HashSet[string]
    foreach ($line in $script:PreIgnored) { [void]$preIgnoredSet.Add($line) }
    $newIgnored = New-Object System.Collections.Generic.List[string]
    foreach ($line in $postIgnored) {
        if (-not $preIgnoredSet.Contains($line)) { $newIgnored.Add($line) }
    }
    if ($newIgnored.Count -gt 0) {
        Write-Err '事後検証違反: 新規に出現した ignored ファイルが検出されました(既存 ignored ファイルの内容変更は検出対象外)。revert はせず報告のみ行います'
        foreach ($f in $newIgnored) { Write-Err "  - $f" }
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:6'
        Write-Output 'NEW_IGNORED:'
        foreach ($f in $newIgnored) { Write-Output "  - $f" }
        exit 6
    }

    # --- 事後検証 1e: 任意の ref(ブランチ・タグ等)の作成・削除・移動がないこと(for-each-ref の事前/事後比較) ---
    $postRefsRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'for-each-ref', '--format=%(refname) %(objectname)')
    $postRefs = $postRefsRes.StdOut.Trim()
    if ($postRefs -ne $script:PreRefs) {
        Write-Err '事後検証違反: git ref(ブランチ・タグ等)の作成・削除・移動が検出されました。revert はせず報告のみ行います'
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:6'
        exit 6
    }

    # --- 事後検証 2: 変更ファイルが --allowed-paths の範囲内であること ---
    $finalStatusRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'status', '--porcelain')
    $changed = Get-ChangedFilesFromPorcelain $finalStatusRes.StdOut

    if ($changed.Count -eq 0) {
        Write-Err '事後検証: Codex 実行後に変更ファイルがありません(何も実装されなかった可能性があります)'
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:0'
        Write-Output 'CHANGED_FILES: (none)'
        exit 0
    }

    $outOfScope = New-Object System.Collections.Generic.List[string]
    $inScope = New-Object System.Collections.Generic.List[string]
    foreach ($c in $changed) {
        if (Test-PathMatchesAnyGlob -path $c.Path -patterns $script:AllowedPatterns) {
            $inScope.Add($c.Path)
        } else {
            $outOfScope.Add($c.Path)
        }
        if ($c.OldPath -and -not (Test-PathMatchesAnyGlob -path $c.OldPath -patterns $script:AllowedPatterns)) {
            if (-not $outOfScope.Contains($c.OldPath)) { $outOfScope.Add($c.OldPath + ' (rename-source)') }
        }
    }

    if ($outOfScope.Count -gt 0) {
        Write-Err '事後検証違反: --allowed-paths の範囲外の変更が検出されました。revert はせず報告のみ行います'
        foreach ($f in $outOfScope) { Write-Err "  - $f" }
        Write-Output "SAVED: $relSaved"
        Write-Output 'EXIT:6'
        Write-Output 'OUT_OF_SCOPE:'
        foreach ($f in $outOfScope) { Write-Output "  - $f" }
        exit 6
    }

    # --- 合格: 変更ファイル一覧 + diff stat + 出力ファイルパスを要約 ---
    $diffStatRes = Invoke-Proc -FilePath 'git' -Args @('-C', $script:RepoRoot, 'diff', '--stat')

    Write-Output "SAVED: $relSaved"
    Write-Output 'CHANGED_FILES:'
    foreach ($c in $changed) {
        if ($c.OldPath) {
            Write-Output "  - [$($c.Status)] $($c.OldPath) -> $($c.Path)"
        } else {
            Write-Output "  - [$($c.Status)] $($c.Path)"
        }
    }
    Write-Output 'DIFF_STAT:'
    Write-Output $diffStatRes.StdOut.TrimEnd()
    Write-Output 'EXIT:0'
    exit 0
}
finally {
    if ($script:WorkDir -and (Test-Path $script:WorkDir)) {
        Remove-Item -Recurse -Force -LiteralPath $script:WorkDir -ErrorAction SilentlyContinue
    }
}
