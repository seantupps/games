$dir = "D:\Projects\five\build\tools\ttyd"
$exe = Join-Path $dir "ttyd.exe"
$log = Join-Path $dir "ttyd.log"
$err = Join-Path $dir "ttyd.err"
$pass = ((Get-Content (Join-Path $dir "credentials.txt")) | Where-Object { $_ -match "^pass=" }) -replace "^pass=",""
while ($true) {
  Add-Content $log "$(Get-Date -Format o) starting ttyd"
  $p = Start-Process -FilePath $exe -ArgumentList @("-p","7681","-i","0.0.0.0","-W","-c","gops:$pass","powershell.exe","-NoLogo","-NoExit") -PassThru -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden
  $p.WaitForExit()
  Add-Content $log "$(Get-Date -Format o) exited code=$($p.ExitCode)"
  Start-Sleep 2
}
