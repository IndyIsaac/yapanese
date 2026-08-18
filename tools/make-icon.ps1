# Draws the Murmur app icon and writes both PNG and ICO.
# Run: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$size = 256
$out  = Join-Path $PSScriptRoot "..\assets"
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Rounded-square ground in the app's surface colour.
$radius = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius, $radius, 180, 90)
$path.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
$path.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
$path.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$ground = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0,0)),
  (New-Object System.Drawing.Point($size,$size)),
  [System.Drawing.Color]::FromArgb(255, 32, 30, 46),
  [System.Drawing.Color]::FromArgb(255, 18, 18, 24))
$g.FillPath($ground, $path)

# Microphone glyph in the accent violet.
$accent = [System.Drawing.Color]::FromArgb(255, 124, 108, 240)
$brush  = New-Object System.Drawing.SolidBrush($accent)
$pen    = New-Object System.Drawing.Pen($accent, 15)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

# capsule
$capW = 62; $capH = 108
$capX = ($size - $capW) / 2; $capY = 52
$cap = New-Object System.Drawing.Drawing2D.GraphicsPath
$cap.AddArc($capX, $capY, $capW, $capW, 180, 180)
$cap.AddArc($capX, $capY + $capH - $capW, $capW, $capW, 0, 180)
$cap.CloseFigure()
$g.FillPath($brush, $cap)

# cradle arc + stem
$arcX = ($size - 118) / 2
$g.DrawArc($pen, $arcX, 108, 118, 108, 20, 140)
$g.DrawLine($pen, ($size / 2), 190, ($size / 2), 214)

$g.Dispose()

$pngPath = Join-Path $out "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Wrap the PNG in an ICO container. Windows Vista and later read PNG-compressed
# icon entries directly, so no BMP conversion is needed.
$png = [System.IO.File]::ReadAllBytes($pngPath)
$ms  = New-Object System.IO.MemoryStream
$bw  = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type: icon
$bw.Write([UInt16]1)      # image count
$bw.Write([Byte]0)        # width  (0 = 256)
$bw.Write([Byte]0)        # height (0 = 256)
$bw.Write([Byte]0)        # palette
$bw.Write([Byte]0)        # reserved
$bw.Write([UInt16]1)      # colour planes
$bw.Write([UInt16]32)     # bits per pixel
$bw.Write([UInt32]$png.Length)
$bw.Write([UInt32]22)     # offset to image data
$bw.Write($png)
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $out "icon.ico"), $ms.ToArray())
$bw.Dispose(); $ms.Dispose(); $bmp.Dispose()

Write-Output "wrote assets/icon.png and assets/icon.ico"
