Set sh = CreateObject("WScript.Shell")
sh.Run "node """ & WScript.Arguments(0) & """", 0, False
