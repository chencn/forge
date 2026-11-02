param(
  [string]$Revision = '14e2fff0a9b351e49e1b4d0fded5d261ba235738',
  [string]$InputPath,
  [ValidateSet('idea', 'vscode', 'eclipse')][string]$Preset = 'idea'
)
$ErrorActionPreference = 'Stop'
# 固定上游版本，保留全部动作及键盘/鼠标/手势，禁止手工摘录常用键。
$sourcePath = switch ($Preset) {
  'idea' { 'platform/platform-resources/src/keymaps/$default.xml' }
  'vscode' { 'plugins/keymaps/vscode-keymap/resources/keymaps/VSCode.xml' }
  'eclipse' { 'plugins/keymaps/eclipse-keymap/resources/keymaps/Eclipse.xml' }
}
$source = "https://raw.githubusercontent.com/JetBrains/intellij-community/$Revision/$sourcePath"
[xml]$document = if ($InputPath) { Get-Content -LiteralPath $InputPath -Raw } else { (Invoke-WebRequest -Uri $source -TimeoutSec 30).Content }
# action id 大小写敏感（VSCode 同时声明 GoToClass 与 GotoClass），与上游解析器一致。
$actions = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
foreach ($action in $document.keymap.action) {
  $keys = @($action.SelectNodes('keyboard-shortcut') | ForEach-Object {
    $_.GetAttribute('first-keystroke') + $(if ($_.HasAttribute('second-keystroke')) { ' > ' + $_.GetAttribute('second-keystroke') })
  })
  $actions[$action.id] = [ordered]@{
    keyboard = $keys
    mouse = @($action.SelectNodes('mouse-shortcut') | ForEach-Object { $_.GetAttribute('keystroke') })
    gestures = @($action.SelectNodes('keyboard-gesture-shortcut') | ForEach-Object {
      [ordered]@{ keystroke = $_.GetAttribute('keystroke'); modifier = $_.GetAttribute('modifier') }
    })
  }
}
$result = [ordered]@{
  source = $source
  parent = $document.keymap.GetAttribute('parent')
  license = 'Apache-2.0; Copyright JetBrains s.r.o.; https://www.apache.org/licenses/LICENSE-2.0.txt'
  actions = $actions
}
$fileName = if ($Preset -eq 'idea') { 'idea-default' } else { $Preset }
$destination = Join-Path $PSScriptRoot "../src/lib/keymaps/$fileName.json"
[IO.Directory]::CreateDirectory((Split-Path $destination)) | Out-Null
[IO.File]::WriteAllText($destination, ($result | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
Write-Output "Imported $($actions.Count) actions from $source"
