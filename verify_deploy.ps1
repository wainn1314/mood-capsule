<#
 * Mood Capsule · 上线后一键验收（PowerShell，零依赖，Windows PowerShell 5.1+ 可用）
 * ---------------------------------------------------------------------------
 * 用法：
 *   powershell -NoProfile -ExecutionPolicy Bypass -File .\verify_deploy.ps1 -Api https://mood-capsule-api.onrender.com
 *   powershell -NoProfile -ExecutionPolicy Bypass -File .\verify_deploy.ps1 -Api https://xxx.onrender.com -Site https://xxx.netlify.app
 *
 * 自动检查（都能在 HTTP 层判定）：
 *   [1] 后端 /healthz：ok、两个 Key 是否已配置、数据库路径、CORS 模式
 *   [2] 后端静态资源 200；/.env 与 mood.db* 被 403 拦截；路径穿越被拒
 *   [3] CORS 白名单：白名单内回显 Origin、名单外不回显、OPTIONS 预检同规则
 *   [4] 前端站点：可访问、config.js 的 apiBase 是否已回填、是否误把 .env / mood.db 发了上去
 *
 * 仍需人工确认的 4 项（打字机流式输出、胶囊生成、刷新后历史仍在、请求都指向后端域名）见 DEPLOY.md §7。
 * 任何一项 FAIL 都会让脚本以退出码 1 结束，方便以后接进 CI。
 * ---------------------------------------------------------------------------
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Api,           # 后端地址，如 https://mood-capsule-api.onrender.com

  [string]$Site = '',     # 前端地址（可选），如 https://mood-capsule.netlify.app

  [int]$TimeoutSec = 90   # 免费实例冷启动约 1 分钟，超时给宽一点
)

$ErrorActionPreference = 'Stop'
# 兜底：脚本自身出错时给明确信息并以非 0 退出，避免误判为「验收通过」
trap { Write-Host "`n  [ERROR] 脚本执行中断：$($_.Exception.Message)" -ForegroundColor Red; exit 2 }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Api = $Api.Trim().TrimEnd('/')
if ($Site) { $Site = $Site.Trim().TrimEnd('/') }
$isLocalApi = $Api -match '^https?://(localhost|127\.0\.0\.1|\[::1\])'   # 本地自测时 CORS 放开是预期行为

$script:PassCount = 0
$script:FailCount = 0

function Write-Section([string]$Text) { Write-Host "`n$Text" -ForegroundColor Cyan }
function Write-Pass([string]$Text) { $script:PassCount++; Write-Host "  [PASS] $Text" -ForegroundColor Green }
function Write-Fail([string]$Text) { $script:FailCount++; Write-Host "  [FAIL] $Text" -ForegroundColor Red }
function Write-Info([string]$Text) { Write-Host "  [INFO] $Text" -ForegroundColor DarkGray }

function Assert([bool]$Ok, [string]$Label, [string]$Detail = '') {
  $msg = $Label
  if ($Detail) { $msg = "$Label（$Detail）" }
  if ($Ok) { Write-Pass $msg } else { Write-Fail $msg }
}

# 单次请求：4xx/5xx 也当作正常结果返回，不抛异常（超时/断网时 Status = 0）
function Send-Request {
  param([string]$Url, [hashtable]$Headers = @{}, [string]$Method = 'GET')
  try {
    $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -TimeoutSec $TimeoutSec -UseBasicParsing
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Headers = $r.Headers; Content = [string]$r.Content; Error = '' }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      return [pscustomobject]@{ Status = [int]$resp.StatusCode; Headers = $resp.Headers; Content = ''; Error = '' }
    }
    return [pscustomobject]@{ Status = 0; Headers = @{}; Content = ''; Error = [string]$_.Exception.Message }
  }
}

# 取响应头（PS 5.1 是 WebHeaderCollection，PS 7 是 Dictionary[string,string[]]，两种都兼容）
function Get-HeaderValue {
  param($Response, [string]$Name)
  if (-not $Response -or -not $Response.Headers) { return '' }
  $h = $Response.Headers
  if ($h -is [System.Collections.IDictionary]) {
    foreach ($k in @($h.Keys)) { if ("$k" -ieq $Name) { return ([string]::Join(', ', @($h[$k]))) } }
    return ''
  }
  try { return [string]$h[$Name] } catch { return '' }
}

function Get-FailureDetail {
  param($Response, [int]$Actual)
  if ($Response.Error) { return $Response.Error }
  if ($Actual -eq 0) { return '无响应（地址是否写错？免费实例冷启动是否超时？）' }
  return "实际返回 $Actual"
}

Write-Host ''
Write-Host 'Mood Capsule · 上线验收' -ForegroundColor White
Write-Host "  后端：$Api" -ForegroundColor Gray
if ($Site) { Write-Host "  前端：$Site" -ForegroundColor Gray }

# ---------------------------------------------------------------- [1] 健康检查
Write-Section "[1/4] 后端健康检查   GET $Api/healthz"

$health = Send-Request "$Api/healthz"
$healthJson = $null
if ($health.Status -ne 200) {
  Write-Fail "/healthz 可访问：$(Get-FailureDetail $health $health.Status)"
} else {
  Write-Pass '/healthz 返回 200'
  try { $healthJson = $health.Content | ConvertFrom-Json } catch { $healthJson = $null }
  if (-not $healthJson) {
    Write-Fail '返回体是合法 JSON'
  } else {
    Assert ($healthJson.ok -eq $true) 'ok = true'
    Assert ([bool]$healthJson.aiKeys.dify) 'DIFY_API_KEY 已配置（aiKeys.dify = true）' '未配置时所有 /api/dify/* 都会返回 503'
    Assert ([bool]$healthJson.aiKeys.deepseek) 'DEEPSEEK_API_KEY 已配置（aiKeys.deepseek = true）' '未配置时胶囊外观会退回本地规则'
    Write-Info "数据库：$($healthJson.database.path)（文件已存在：$($healthJson.database.ready)）"
    Write-Info "CORS  ：$($healthJson.corsOrigin)"
    Write-Info "运行  ：Node $($healthJson.node)，已启动 $($healthJson.uptime) 秒"
  }
}

# ---------------------------------------------------- [2] 静态资源 & 敏感文件
Write-Section '[2/4] 后端静态资源与敏感文件拦截'

foreach ($p in @('/', '/index.html', '/app.js', '/capsule.js', '/config.js', '/styles.css')) {
  $r = Send-Request "$Api$p"
  Assert ($r.Status -eq 200) "GET $p → 200" (Get-FailureDetail $r $r.Status)
}

foreach ($p in @('/.env', '/mood.db', '/mood.db-wal', '/mood.db-shm')) {
  $r = Send-Request "$Api$p"
  Assert ($r.Status -eq 403) "GET $p → 403（不通过 HTTP 泄露）" (Get-FailureDetail $r $r.Status)
}

$traversal = Send-Request "$Api/%2e%2e%2fserver.js"
Assert ($traversal.Status -in 403, 404) 'GET 路径穿越 /%2e%2e%2fserver.js 被拒（403/404）' (Get-FailureDetail $traversal $traversal.Status)

# -------------------------------------------------------------------- [3] CORS
Write-Section '[3/4] CORS 白名单（公网接口没有鉴权，这里不收紧就等于给别人白嫖模型额度）'

$allowed = ''
if ($healthJson) { $allowed = [string]$healthJson.corsOrigin }
$allowedList = @()
if ($allowed -and $allowed -ne '*') {
  $allowedList = @($allowed -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$probe = 'https://evil.example.com'
$preflight = @{ 'Access-Control-Request-Method' = 'POST'; 'Access-Control-Request-Headers' = 'content-type' }

if (-not $healthJson) {
  Write-Fail '跳过 CORS 检查：/healthz 没返回 JSON，先按第 1 项修好'
}
elseif ($allowedList.Count -eq 0) {
  $r = Send-Request "$Api/healthz" @{ Origin = $probe }
  Assert ((Get-HeaderValue $r 'Access-Control-Allow-Origin') -eq '*') '未设 CORS_ORIGIN 时按 * 放开（确认服务按默认策略在跑）'
  if ($isLocalApi) {
    Write-Info '本地自测：CORS 放开（*）属预期，不用设 CORS_ORIGIN'
  }
  else {
    Write-Fail 'CORS_ORIGIN 尚未收紧：请设为前端域名后重新部署（DEPLOY.md §6.2）'
  }
}
else {
  $mine = $allowedList[0]
  $r = Send-Request "$Api/healthz" @{ Origin = $mine }
  Assert ((Get-HeaderValue $r 'Access-Control-Allow-Origin') -eq $mine) "白名单内 $mine 回显 Origin" "实际 $(Get-HeaderValue $r 'Access-Control-Allow-Origin')"

  $r2 = Send-Request "$Api/healthz" @{ Origin = $probe }
  $evil = Get-HeaderValue $r2 'Access-Control-Allow-Origin'
  Assert ($evil -ne $probe) '名单外来源不回显 Origin（浏览器会拦下，别人用不了你的额度）' "实际 $(if ($evil) { $evil } else { '（无该响应头）' })"

  $pre = Send-Request "$Api/api/dify/chat-messages" ($preflight + @{ Origin = $mine }) -Method Options
  Assert ($pre.Status -eq 204) 'OPTIONS 预检返回 204' (Get-FailureDetail $pre $pre.Status)
  Assert ((Get-HeaderValue $pre 'Access-Control-Allow-Origin') -eq $mine) 'OPTIONS 预检同样回显白名单 Origin'
  Assert ((Get-HeaderValue $pre 'Access-Control-Allow-Methods') -match 'POST') 'OPTIONS 预检允许 POST'

  $pre2 = Send-Request "$Api/api/dify/chat-messages" ($preflight + @{ Origin = $probe }) -Method Options
  $evilPre = Get-HeaderValue $pre2 'Access-Control-Allow-Origin'
  Assert ($evilPre -ne $probe) 'OPTIONS 预检对名单外来源不下发 CORS 头' "实际 $(if ($evilPre) { $evilPre } else { '（无该响应头）' })"

  if ($Site) {
    Assert ($allowedList -contains $Site) "当前前端域名 $Site 已在白名单里" "白名单 = $allowed"
  }
}

# -------------------------------------------------------------- [4] 前端站点
if (-not $Site) {
  Write-Section '[4/4] 前端站点（已跳过：未提供 -Site）'
  Write-Info '想看前端是否可访问、config.js 是否回填正确，请加 -Site https://xxx.netlify.app 再跑一次'
}
else {
  Write-Section "[4/4] 前端站点与前后端对接   $Site"

  $homeResp = Send-Request "$Site/"
  Assert ($homeResp.Status -eq 200) 'GET / → 200（站点已发布）' (Get-FailureDetail $homeResp $homeResp.Status)
  if ($homeResp.Status -eq 200) { Assert ($homeResp.Content -match 'Mood Capsule') '首页返回的是本项目页面' }

  $cfg = Send-Request "$Site/config.js"
  Assert ($cfg.Status -eq 200) 'GET /config.js → 200' (Get-FailureDetail $cfg $cfg.Status)
  if ($cfg.Status -eq 200) {
    # 先剥掉 /* ... */ 块注释与整行 // 注释：config.js 的注释里就有 apiBase 示例，
    # 直接正则匹配会命中注释而误判为「已回填」。（不剥行尾 // 是为了不破坏 https:// 里的双斜杠）
    $cfgBody = $cfg.Content
    $cfgBody = [regex]::Replace($cfgBody, '(?s)/\*.*?\*/', '')
    $cfgBody = [regex]::Replace($cfgBody, '(?m)^\s*//.*$', '')
    $m = [regex]::Match($cfgBody, 'apiBase\s*:\s*[''"]?([^''"\r\n}]*)')
    $apiBase = ''
    if ($m.Success) { $apiBase = $m.Groups[1].Value.Trim() }
    if (-not $apiBase) {
      Write-Fail 'config.js 的 apiBase 已回填（当前为空：线上会提示「未配置后端地址」且读不到远端数据）'
    }
    else {
      Assert (-not $apiBase.EndsWith('/')) 'apiBase 末尾没有多余斜杠' "config.js = $apiBase"
      Assert ($apiBase.TrimEnd('/') -eq $Api) 'apiBase 指向本次验收的后端' "config.js = $apiBase"
    }
  }

  foreach ($p in @('/.env', '/mood.db', '/mood.db-wal')) {
    $r = Send-Request "$Site$p"
    Assert ($r.Status -ne 200) "GET $p 没被发布到 Netlify（不能是 200）" "实际 $($r.Status)（404 = 没上传，符合预期）"
  }
}

# ---------------------------------------------------------------------- 汇总
Write-Section '验收结果'
$color = 'Green'
if ($script:FailCount -gt 0) { $color = 'Red' }
Write-Host ("  通过 $($script:PassCount) 项 / 失败 $($script:FailCount) 项") -ForegroundColor $color

if ($script:FailCount -gt 0) {
  Write-Host '  按每个失败项括号里的提示处理，常见现象对照 DEPLOY.md §8 排错表' -ForegroundColor Yellow
  exit 1
}

Write-Host '  HTTP 层已全部通过，剩下这 4 项需要人工点一遍（DEPLOY.md §7）：' -ForegroundColor Yellow
Write-Host '    1) 发一条消息是逐字出现（说明 SSE 没被中间层缓冲）'
Write-Host '    2) 结束对话能生成情绪总结与胶囊'
Write-Host '    3) 保存后能在「我的胶囊」里打开并删除'
Write-Host '    4) 刷新后历史与胶囊仍在，且 DevTools → Network 里请求都指向后端域名'
exit 0
