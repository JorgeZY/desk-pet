param(
  [Parameter(Mandatory = $true)]
  [string]$ModelRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$speechModels = Join-Path $ModelRoot 'speech'
$downloads = Join-Path $ModelRoot '.downloads'
$target = Join-Path $speechModels 'streaming-paraformer-bilingual-zh-en'
$archive = Join-Path $downloads 'sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2'
$staging = Join-Path $speechModels '.streaming-model-download'
$extracted = Join-Path $staging 'sherpa-onnx-streaming-paraformer-bilingual-zh-en'
$url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2'

function Remove-UnusedFp32Models([string]$Directory) {
  Remove-Item -LiteralPath (Join-Path $Directory 'encoder.onnx') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $Directory 'decoder.onnx') -Force -ErrorAction SilentlyContinue
}

if (-not $Force -and
    (Test-Path -LiteralPath (Join-Path $target 'encoder.int8.onnx')) -and
    (Test-Path -LiteralPath (Join-Path $target 'decoder.int8.onnx')) -and
    (Test-Path -LiteralPath (Join-Path $target 'tokens.txt'))) {
  Remove-UnusedFp32Models $target
  Write-Host 'Streaming preview model is already installed.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $speechModels | Out-Null
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

Write-Host 'Downloading Sherpa streaming Chinese-English preview model (about 226 MB)...'
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
  if (-not (Test-Path -LiteralPath (Join-Path $extracted 'encoder.int8.onnx')) -or
      -not (Test-Path -LiteralPath (Join-Path $extracted 'decoder.int8.onnx')) -or
      -not (Test-Path -LiteralPath (Join-Path $extracted 'tokens.txt'))) {
    throw 'Streaming archive is missing encoder, decoder, or tokens files.'
  }
  Remove-UnusedFp32Models $extracted
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Move-Item -LiteralPath $extracted -Destination $target
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Streaming preview model is ready: $target"
