param(
  [Parameter(Mandatory = $true)]
  [string]$ModelRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$speechModels = Join-Path $ModelRoot 'speech'
$downloads = Join-Path $ModelRoot '.downloads'
$target = Join-Path $speechModels 'sense-voice-zh-en-ja-ko-yue-int8'
$archive = Join-Path $downloads 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2'
$staging = Join-Path $speechModels '.sense-voice-download'
$extracted = Join-Path $staging 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
$url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2'

if (-not $Force -and
    (Test-Path -LiteralPath (Join-Path $target 'model.int8.onnx')) -and
    (Test-Path -LiteralPath (Join-Path $target 'tokens.txt'))) {
  Write-Host 'SenseVoice final recognition model is already installed.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $speechModels | Out-Null
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

Write-Host 'Downloading Sherpa SenseVoice INT8 model (about 230 MB)...'
try {
  Invoke-WebRequest -Uri $url -OutFile $archive
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  tar -xjf $archive -C $staging
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $extracted 'model.int8.onnx')) -or
      -not (Test-Path -LiteralPath (Join-Path $extracted 'tokens.txt'))) {
    throw 'SenseVoice archive is missing model.int8.onnx or tokens.txt.'
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Move-Item -LiteralPath $extracted -Destination $target
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "SenseVoice model is ready: $target"
