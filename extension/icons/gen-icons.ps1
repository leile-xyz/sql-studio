# 生成 SQL Studio 扩展图标（16/48/128 px）— 渐变圆角底 + 数据库柱
# 需用 Windows PowerShell 执行：powershell.exe -ExecutionPolicy Bypass -File gen-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # 圆角矩形背景（蓝紫渐变）
    $pad = [float]($size * 0.03)
    $span = [float]($size - 2 * $pad)
    $d = [float]($size * 0.4)
    $x2 = $pad + $span
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc($pad, $pad, $d, $d, 180, 90)
    $gp.AddArc($x2 - $d, $pad, $d, $d, 270, 90)
    $gp.AddArc($x2 - $d, $x2 - $d, $d, $d, 0, 90)
    $gp.AddArc($pad, $x2 - $d, $d, $d, 90, 90)
    $gp.CloseFigure()
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $c1 = [System.Drawing.Color]::FromArgb(255, 53, 116, 240)
    $c2 = [System.Drawing.Color]::FromArgb(255, 123, 92, 240)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)
    $g.FillPath($brush, $gp)

    # 数据库柱（白线）
    $w = [float]($size * 0.46); $h = [float]($size * 0.46)
    $ex = [float](($size - $w) / 2); $ey = [float](($size - $h) / 2)
    $ry = [float]($w * 0.18)
    $penW = [float]([Math]::Max(1.0, $size * 0.055))
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawEllipse($pen, $ex, $ey, $w, 2 * $ry)
    $g.DrawLine($pen, $ex, $ey + $ry, $ex, $ey + $h - $ry)
    $g.DrawLine($pen, $ex + $w, $ey + $ry, $ex + $w, $ey + $h - $ry)
    $g.DrawArc($pen, $ex, $ey + $h - 2 * $ry, $w, 2 * $ry, 0, 180)
    $g.DrawArc($pen, $ex, [float]($ey + $h * 0.42 - $ry), $w, 2 * $ry, 0, 180)

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($n in 16, 48, 128) { New-Icon $n (Join-Path $dir "icon$n.png") }
"图标已生成: icon16/48/128.png"
