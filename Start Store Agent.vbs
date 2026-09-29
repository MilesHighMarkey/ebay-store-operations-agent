Option Explicit

Dim shell, fso, folder
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)

' Start the local agent without showing a terminal window.
shell.Run "cmd.exe /c cd /d """ & folder & """ && set PORT=8789 && npm start", 0, False

' Give Node a moment to bind the port, then open the dashboard.
WScript.Sleep 1800
shell.Run "http://localhost:8789/", 1, False

Set fso = Nothing
Set shell = Nothing
