#Requires AutoHotkey v2.0
; Force-resize a window below app-imposed minimums (e.g. Chrome ~516px on Windows).
;
; Usage:
;   AutoHotkey64.exe force-chrome-window-size.ahk <width> <height> [left top] --pid <pid> [--index N]
;   AutoHotkey64.exe force-chrome-window-size.ahk <width> <height> [left top] --title <substring>
;   AutoHotkey64.exe force-chrome-window-size.ahk <width> <height> [left top] --active

SWP_NOSENDCHANGING := 0x0400
SWP_NOZORDER := 0x0004
SWP_NOACTIVATE := 0x0010

ForceResize(hwnd, x, y, w, h) {
    flags := SWP_NOSENDCHANGING | SWP_NOZORDER | SWP_NOACTIVATE
    ok := DllCall("SetWindowPos", "Ptr", hwnd, "Ptr", 0, "Int", x, "Int", y, "Int", w, "Int", h, "UInt", flags, "Int")
    return ok
}

GetWindowRect(hwnd) {
    rect := Buffer(16, 0)
    if !DllCall("GetWindowRect", "Ptr", hwnd, "Ptr", rect)
        return { left: 0, top: 0, width: 0, height: 0 }
    left := NumGet(rect, 0, "Int")
    top := NumGet(rect, 4, "Int")
    right := NumGet(rect, 8, "Int")
    bottom := NumGet(rect, 12, "Int")
    return { left: left, top: top, width: right - left, height: bottom - top }
}

ListWindowsByPid(pid) {
    hwnds := []
    try {
        for hwnd in WinGetList("ahk_pid " pid)
            hwnds.Push(hwnd)
    } catch {
        return hwnds
    }
    if hwnds.Length <= 1
        return hwnds

    SortByLeft(hwnds) {
        items := []
        for hwnd in hwnds {
            r := GetWindowRect(hwnd)
            items.Push({ hwnd: hwnd, left: r.left, top: r.top })
        }
        loop items.Length - 1 {
            swapped := false
            Loop items.Length - A_Index {
                i := A_Index
                a := items[i]
                b := items[i + 1]
                if (a.left > b.left) || (a.left = b.left && a.top > b.top) {
                    tmp := items[i]
                    items[i] := items[i + 1]
                    items[i + 1] := tmp
                    swapped := true
                }
            }
            if !swapped
                break
        }
        out := []
        for item in items
            out.Push(item.hwnd)
        return out
    }
    return SortByLeft(hwnds)
}

FindWindowByTitle(substr) {
    try {
        for hwnd in WinGetList()
            if InStr(WinGetTitle("ahk_id " hwnd), substr)
                return hwnd
    }
    return 0
}

FindWindowByOuterRect(x, y, w, h, tolerance := 32) {
    best := 0
    bestScore := tolerance + 1
    try {
        for hwnd in WinGetList("ahk_exe chrome.exe") {
            r := GetWindowRect(hwnd)
            if (r.width < 200 || r.height < 200)
                continue
            score := Abs(r.left - x) + Abs(r.top - y) + Abs(r.width - w) + Abs(r.height - h)
            if (score <= tolerance * 4 && score < bestScore) {
                bestScore := score
                best := hwnd
            }
        }
    }
    return best
}

ParseArgs(args) {
    if (args.Length < 2)
        throw Error("Need at least width and height")
    spec := {
        width: Integer(args[1]),
        height: Integer(args[2]),
        left: "",
        top: "",
        pid: 0,
        index: 0,
        title: "",
        active: false,
        matchLeft: "",
        matchTop: "",
        matchWidth: "",
        matchHeight: ""
    }
    i := 3
    if (args.Length >= 5 && RegExMatch(args[3], "^-?\d+$") && RegExMatch(args[4], "^-?\d+$")) {
        spec.left := Integer(args[3])
        spec.top := Integer(args[4])
        i := 5
    }
    while (i <= args.Length) {
        flag := StrLower(args[i])
        if (flag = "--match") {
            if (i + 4 > args.Length)
                throw Error("--match requires left top width height")
            spec.matchLeft := Integer(args[++i])
            spec.matchTop := Integer(args[++i])
            spec.matchWidth := Integer(args[++i])
            spec.matchHeight := Integer(args[++i])
        } else if (flag = "--pid") {
            if (i + 1 > args.Length)
                throw Error("--pid requires a value")
            spec.pid := Integer(args[++i])
        } else if (flag = "--index") {
            if (i + 1 > args.Length)
                throw Error("--index requires a value")
            spec.index := Integer(args[++i])
        } else if (flag = "--title") {
            if (i + 1 > args.Length)
                throw Error("--title requires a value")
            spec.title := args[++i]
        } else if (flag = "--active") {
            spec.active := true
        } else {
            throw Error("Unknown argument: " args[i])
        }
        i += 1
    }
    return spec
}

ResolveHwnd(spec) {
    if (spec.matchWidth != "" && spec.matchHeight != "") {
        hwnd := FindWindowByOuterRect(spec.matchLeft, spec.matchTop, spec.matchWidth, spec.matchHeight)
        if hwnd
            return hwnd
    }
    if (spec.pid) {
        hwnds := ListWindowsByPid(spec.pid)
        if (hwnds.Length = 0)
            return 0
        idx := spec.index + 1
        if (idx < 1 || idx > hwnds.Length)
            return hwnds[1]
        return hwnds[idx]
    }
    if (spec.title)
        return FindWindowByTitle(spec.title)
    if (spec.active) {
        hwnd := WinGetID("A")
        return hwnd ? hwnd : 0
    }
    return 0
}

Main() {
    try {
        spec := ParseArgs(A_Args)
    } catch as err {
        FileAppend("ERROR: " err.Message "`n", "*")
        ExitApp(2)
    }

    hwnd := ResolveHwnd(spec)
    if !hwnd {
        FileAppend("ERROR: no matching window`n", "*")
        ExitApp(1)
    }

    x := spec.left
    y := spec.top
    if (x = "" || y = "") {
        rect := GetWindowRect(hwnd)
        x := (x = "") ? rect.left : x
        y := (y = "") ? rect.top : y
    }

    if !ForceResize(hwnd, x, y, spec.width, spec.height) {
        FileAppend("ERROR: SetWindowPos failed`n", "*")
        ExitApp(3)
    }

    rect := GetWindowRect(hwnd)
    FileAppend("OK hwnd=" hwnd " outer=" rect.width "x" rect.height " at " rect.left "," rect.top "`n", "*")
    ExitApp(0)
}

Main()
