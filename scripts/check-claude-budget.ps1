# check-claude-budget.ps1 — Claude 側トークン使用状況の推計(規則 ROUTE-1、PowerShell 版)
#
# 使い方(bash 版 check-claude-budget.sh と同一インターフェース):
#   scripts/check-claude-budget.ps1
#
# 出力(stdout、1行 JSON):
#   {"state":"green|yellow|red|unknown","blockUsedPct":<num|null>,"reason":"<簡潔な根拠>","fetchedAt":"<ISO8601>"}
#
# 環境変数(既定値を上書き可):
#   CLAUDE_BUDGET_GREEN_MAX  (既定 50)  … アクティブブロック使用率がこの値未満なら green
#   CLAUDE_BUDGET_YELLOW_MAX (既定 70)  … green 超過〜この値以下なら yellow、それ超過なら red
#
# 詳細仕様: docs/adr/0003-review-dod-and-orchestration.md 決定7(規則 ROUTE-1)
#
# 終了コード: 0=判定出力成功(unknown 含む) 5=引数エラー(内部起動する .cmd/.bat 実行ファイル・
#             引数に cmd メタ文字が含まれる場合を含む)
#
# 設計メモ:
#   - ccusage(https://github.com/ryoppippi/ccusage)は Claude Code のローカル transcript から使用量を
#     推計するサードパーティ CLI であり、契約上の正確な残量とは限らない(ADR-0003 残余リスク)。
#   - @latest は使わずバージョンを固定する(挙動の予期しない変更を避けるため)。本スクリプト作成時点では
#     `npm view ccusage version` を実行できる環境が無かったため、既知の妥当なバージョンを暫定指定して
#     いる。導入時・定期見直し時に実際の最新バージョンを確認し、下記定数を更新すること。
#   - ccusage の出力構造(projected/tokenLimit 系フィールドの有無)はバージョンに依存するため、
#     判定ロジックは Node.js(本リポジトリ前提の Node 24)を子プロセスとして呼び出し、フィールドが
#     見つからない場合は必ず unknown へフォールバックする(fail-safe)。

$ErrorActionPreference = 'Continue'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# バージョン更新時は `npm view ccusage version` で確認して書き換える(@latest は使わない)。
$script:CcusageVersion = '20.0.17'
$script:TimeoutSec = 30

function Write-Err([string]$msg) {
    [Console]::Error.WriteLine("ERROR: $msg")
}

function Show-Usage {
    @'
Usage: check-claude-budget.ps1
  出力(stdout, 1行 JSON): {"state":"green|yellow|red|unknown","blockUsedPct":<num|null>,"reason":"...","fetchedAt":"..."}
  環境変数: CLAUDE_BUDGET_GREEN_MAX(既定50) / CLAUDE_BUDGET_YELLOW_MAX(既定70)
'@ | Write-Output
}

foreach ($a in $args) {
    if ($a -eq '-h' -or $a -eq '--help') { Show-Usage; exit 0 }
    Write-Err "不明な引数: $a"
    Show-Usage
    exit 5
}

function Get-NowIso8601Utc {
    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Write-UnknownResult([string]$reason) {
    $obj = [ordered]@{
        state        = 'unknown'
        blockUsedPct = $null
        reason       = $reason
        fetchedAt    = Get-NowIso8601Utc
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

function Invoke-Proc {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Args = @(),
        [string]$WorkDir = (Get-Location).Path,
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
    try { $p.StandardInput.Close() } catch {}

    $stdoutTask = $p.StandardOutput.ReadToEndAsync()
    $stderrTask = $p.StandardError.ReadToEndAsync()

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

function Resolve-PreferredExe([string]$name) {
    $candidates = Get-Command $name -All -ErrorAction SilentlyContinue
    if (-not $candidates) { return $null }
    $preferred = $candidates | Where-Object { $_.Extension -in @('.exe', '.cmd', '.bat') } | Select-Object -First 1
    if (-not $preferred) { $preferred = $candidates | Select-Object -First 1 }
    if ($preferred.Extension -eq '.ps1') { return $null }
    return $preferred.Source
}

$script:NodeExe = Resolve-PreferredExe 'node'
if (-not $script:NodeExe) {
    Write-UnknownResult 'node CLI が見つかりません(判定ロジックを実行できないため unknown)'
    exit 0
}

$script:NpxExe = Resolve-PreferredExe 'npx'
if (-not $script:NpxExe) {
    Write-UnknownResult 'npx CLI が見つかりません(ccusage を実行できないため unknown)'
    exit 0
}

$script:WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("check-claude-budget." + [System.Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null

# decide.js — ccusage の JSON 出力から state/blockUsedPct を判定する共通ロジック(sh 版と同一内容)。
# 引数: <primaryJsonFile> [<secondaryJsonFile>]
#   primaryJsonFile   : `ccusage blocks --json --active` の生出力
#   secondaryJsonFile : `ccusage blocks --json`(履歴含む全ブロック)の生出力。任意。
# 標準出力: 確定できた場合は最終 JSON(1行)を出力し終了コード0。
# 終了コード: 0=確定出力済み 42=limit フィールドが無く履歴フォールバックが必要(呼び出し元が2回目を実行)
$DecideJs = @'
"use strict";
const fs = require("fs");

function nowIso() { return new Date().toISOString(); }

function emit(state, pct, reason) {
  const obj = {
    state,
    blockUsedPct: (pct === null || pct === undefined) ? null : Math.round(pct * 10) / 10,
    reason,
    fetchedAt: nowIso(),
  };
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function readJsonFile(p) {
  const text = fs.readFileSync(p, "utf8");
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

function extractBlocks(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

function findNumber(obj, paths) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur && typeof cur === "object" && part in cur) {
        cur = cur[part];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === "number" && isFinite(cur)) return { value: cur, path: p };
  }
  return null;
}

const primaryFile = process.argv[2];
const secondaryFile = process.argv[3];

let primary;
try {
  primary = readJsonFile(primaryFile);
} catch (e) {
  emit("unknown", null, "ccusage 出力の JSON 解析に失敗しました: " + e.message);
  process.exit(0);
}

if (!primary) {
  emit("unknown", null, "ccusage の出力が空でした");
  process.exit(0);
}

const blocks = extractBlocks(primary);
let active = blocks.find((b) => b && b.isActive === true);
if (!active && blocks.length === 1) active = blocks[0];

if (!active) {
  emit("unknown", null, "アクティブなブロックが見つかりませんでした");
  process.exit(0);
}

const usedCandidate = findNumber(active, [
  "projection.totalTokens",
  "projectedUsage",
  "tokenLimitStatus.projectedUsage",
  "totalTokens",
  "tokenCounts.totalTokens",
]);

if (!usedCandidate) {
  emit("unknown", null, "ccusage の出力からトークン使用量フィールドを特定できませんでした");
  process.exit(0);
}

let limitCandidate = findNumber(active, ["tokenLimitStatus.limit", "tokenLimit", "limit"]);
if (!limitCandidate) limitCandidate = findNumber(primary, ["tokenLimit", "limit"]);

let limitValue = null;
let limitSource = null;

if (limitCandidate && limitCandidate.value > 0) {
  limitValue = limitCandidate.value;
  limitSource = "active." + limitCandidate.path;
} else if (secondaryFile) {
  let secondary;
  try {
    secondary = readJsonFile(secondaryFile);
  } catch (e) {
    emit("unknown", null, "過去ブロック取得の JSON 解析に失敗しました: " + e.message);
    process.exit(0);
  }
  const histBlocks = extractBlocks(secondary).filter((b) => b && b.isActive !== true);
  let max = 0;
  for (const b of histBlocks) {
    const t = findNumber(b, ["totalTokens", "tokenCounts.totalTokens"]);
    if (t && t.value > max) max = t.value;
  }
  if (max > 0) {
    limitValue = max;
    limitSource = "historical-max-total-tokens";
  } else {
    emit("unknown", null, "limit フィールドが無く、過去ブロックからも上限を推計できませんでした");
    process.exit(0);
  }
} else {
  process.exit(42);
}

const pct = (usedCandidate.value / limitValue) * 100;

const envGreen = Number(process.env.CLAUDE_BUDGET_GREEN_MAX || "50");
const envYellow = Number(process.env.CLAUDE_BUDGET_YELLOW_MAX || "70");
const gm = isFinite(envGreen) ? envGreen : 50;
const ym = isFinite(envYellow) ? envYellow : 70;

let state;
if (pct < gm) state = "green";
else if (pct <= ym) state = "yellow";
else state = "red";

const reason = "blockUsedPct=" + (Math.round(pct * 10) / 10) + "% (used=" + usedCandidate.value +
  "[" + usedCandidate.path + "] / limit=" + limitValue + "[" + limitSource + "])";
emit(state, pct, reason);
process.exit(0);
'@

try {
    $DecideJsPath = Join-Path $script:WorkDir 'decide.js'
    [System.IO.File]::WriteAllText($DecideJsPath, $DecideJs, $script:Utf8NoBom)

    $PrimaryJson = Join-Path $script:WorkDir 'primary.json'
    $primaryStderr = Join-Path $script:WorkDir 'primary.stderr.log'
    $primaryArgs = @('--yes', "ccusage@$($script:CcusageVersion)", 'blocks', '--json', '--active')
    $primaryRes = Invoke-Proc -FilePath $script:NpxExe -Args $primaryArgs -StdoutFile $PrimaryJson -StderrFile $primaryStderr -TimeoutSec $script:TimeoutSec

    if ($primaryRes.TimedOut) {
        Write-UnknownResult "ccusage の実行がタイムアウトしました($($script:TimeoutSec)秒)"
        exit 0
    }
    if ($primaryRes.ExitCode -ne 0) {
        $errTail = ($primaryRes.StdErr -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1)
        Write-UnknownResult "ccusage が終了コード $($primaryRes.ExitCode) で失敗しました($errTail)"
        exit 0
    }
    if (-not (Test-Path $PrimaryJson) -or ((Get-Item $PrimaryJson).Length -eq 0)) {
        Write-UnknownResult 'ccusage の出力が空でした'
        exit 0
    }

    $decideOut1 = Join-Path $script:WorkDir 'decide1.stdout.log'
    $decideRes1 = Invoke-Proc -FilePath $script:NodeExe -Args @($DecideJsPath, $PrimaryJson) -StdoutFile $decideOut1 -TimeoutSec 15

    if ($decideRes1.ExitCode -eq 42) {
        # limit フィールドが無い → 履歴ブロックを取得してフォールバック計算する
        $SecondaryJson = Join-Path $script:WorkDir 'secondary.json'
        $secondaryStderr = Join-Path $script:WorkDir 'secondary.stderr.log'
        $secondaryArgs = @('--yes', "ccusage@$($script:CcusageVersion)", 'blocks', '--json')
        $secondaryRes = Invoke-Proc -FilePath $script:NpxExe -Args $secondaryArgs -StdoutFile $SecondaryJson -StderrFile $secondaryStderr -TimeoutSec $script:TimeoutSec

        if ($secondaryRes.TimedOut) {
            Write-UnknownResult "過去ブロック取得(ccusage)がタイムアウトしました($($script:TimeoutSec)秒)"
            exit 0
        }
        if ($secondaryRes.ExitCode -ne 0 -or -not (Test-Path $SecondaryJson) -or ((Get-Item $SecondaryJson).Length -eq 0)) {
            Write-UnknownResult 'limit フィールドが無く、過去ブロックの取得にも失敗しました'
            exit 0
        }

        $decideOut2 = Join-Path $script:WorkDir 'decide2.stdout.log'
        $decideRes2 = Invoke-Proc -FilePath $script:NodeExe -Args @($DecideJsPath, $PrimaryJson, $SecondaryJson) -StdoutFile $decideOut2 -TimeoutSec 15
        if ($decideRes2.ExitCode -ne 0 -or -not (Test-Path $decideOut2) -or ((Get-Item $decideOut2).Length -eq 0)) {
            Write-UnknownResult '判定ロジック(node)の実行に失敗しました'
            exit 0
        }
        Write-Output ([System.IO.File]::ReadAllText($decideOut2, [System.Text.Encoding]::UTF8).Trim())
        exit 0
    }

    if ($decideRes1.ExitCode -ne 0 -or -not (Test-Path $decideOut1) -or ((Get-Item $decideOut1).Length -eq 0)) {
        Write-UnknownResult '判定ロジック(node)の実行に失敗しました'
        exit 0
    }
    Write-Output ([System.IO.File]::ReadAllText($decideOut1, [System.Text.Encoding]::UTF8).Trim())
    exit 0
}
finally {
    if ($script:WorkDir -and (Test-Path $script:WorkDir)) {
        Remove-Item -Recurse -Force -LiteralPath $script:WorkDir -ErrorAction SilentlyContinue
    }
}
