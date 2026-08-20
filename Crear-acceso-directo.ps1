# Crea un acceso directo a AdminTerm en el Escritorio y en el menu Inicio.
# La app pide UAC por si misma, asi que el acceso directo no necesita marcar
# "Ejecutar como administrador".

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$icon = Join-Path $root 'build\icon.ico'

# Se prefiere la app compilada (arranca mas rapido y no depende de Node). Si hay
# varias carpetas de salida (dist, dist2, dist3...) se toma la MAS RECIENTE:
# no se puede recompilar sobre una carpeta con la app abierta, asi que cada
# compilacion hecha con AdminTerm en marcha aterriza en una carpeta nueva.
$packaged = Get-ChildItem -Path $root -Directory -Filter 'dist*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'win-unpacked\AdminTerm.exe' } |
    Where-Object { Test-Path $_ } |
    Sort-Object { (Get-Item $_).LastWriteTime } -Descending |
    Select-Object -First 1

$dev = Join-Path $root 'node_modules\electron\dist\electron.exe'

if ($packaged) {
    $exe = $packaged
    $arguments = ''
} elseif (Test-Path $dev) {
    $exe = $dev
    $arguments = '"' + $root + '"'
} else {
    Write-Host 'No se encontro la app. Ejecuta primero:  npm install   (y opcionalmente npm run build)' -ForegroundColor Yellow
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AdminTerm.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\AdminTerm.lnk')
)

foreach ($lnkPath in $targets) {
    $dir = Split-Path -Parent $lnkPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $exe
    $lnk.Arguments = $arguments
    $lnk.WorkingDirectory = $root
    $lnk.Description = 'Terminal de administrador con dictado y carga de archivos'
    if (Test-Path $icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
    Write-Host "Creado: $lnkPath" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Listo. Abre AdminTerm desde el Escritorio o el menu Inicio.' -ForegroundColor Cyan
