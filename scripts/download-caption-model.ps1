param(
  [Parameter(Mandatory = $true)]
  [string]$ModelRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$modelName = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25'
$archiveName = "$modelName.tar.bz2"
$speechModels = Join-Path $ModelRoot 'speech'
$downloads = Join-Path $ModelRoot '.downloads'
$target = Join-Path $speechModels $modelName
$archive = Join-Path $downloads $archiveName
$staging = Join-Path $speechModels '.caption-model-download'
$extracted = Join-Path $staging $modelName
$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$archiveName"
$requiredFiles = @(
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt'
)

function Test-ModelFiles([string]$Directory) {
  foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $Directory $file) -PathType Leaf)) {
      return $false
    }
  }
  return $true
}

if (-not $Force -and (Test-ModelFiles $target)) {
  Write-Host 'English live-caption model is already installed.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $speechModels | Out-Null
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

Write-Host 'Downloading Sherpa-ONNX Nemotron English live-caption model (about 632 MB extracted)...'
$completed = $false
$downloaded = $false
try {
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    & curl.exe `
      --location `
      --fail `
      --continue-at - `
      --output $archive `
      $url
    if ($LASTEXITCODE -eq 0) {
      $downloaded = $true
      break
    }
    if ($attempt -lt 8) {
      Write-Warning "Caption model download interrupted; resuming (attempt $($attempt + 1) of 8)..."
      Start-Sleep -Seconds 2
    }
  }
  if (-not $downloaded) {
    throw 'Caption model download failed after 8 resumable attempts.'
  }
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  tar -xjf $archive -C $staging
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-ModelFiles $extracted)) {
    throw 'Caption model archive is missing encoder, decoder, joiner, or tokens files.'
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Move-Item -LiteralPath $extracted -Destination $target
  $completed = $true
} finally {
  if ($completed -or $downloaded) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "English live-caption model is ready: $target"
