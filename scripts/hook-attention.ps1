param(
  [string]$Title = "Codex needs your attention",
  [string]$Detail,
  [switch]$Open,
  [int]$Port = 4580
)

$body = @{
  title = $Title
  detail = $Detail
  open = [bool]$Open
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri ("http://127.0.0.1:{0}/api/attention" -f $Port) `
  -ContentType "application/json" `
  -Body $body
