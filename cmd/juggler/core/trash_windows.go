//go:build windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"juggler/internal/atomicio"
)

// Win32 shell file-operation constants (shellapi.h).
const (
	foDelete          = 0x0003 // SHFILEOPSTRUCT.wFunc: delete
	fofAllowUndo      = 0x0040 // route to the Recycle Bin instead of deleting
	fofNoConfirmation = 0x0010 // suppress confirmation dialogs
	fofSilent         = 0x0004 // no progress UI
	fofNoErrorUI      = 0x0400 // no error dialogs (we report via return code)
)

// shFileOpStructW mirrors the Win32 SHFILEOPSTRUCTW layout. The field types
// and ordering match the C struct so the default Go alignment reproduces it on
// amd64 (the only Windows arch we ship).
type shFileOpStructW struct {
	hwnd                  windows.Handle
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

var (
	modshell32           = windows.NewLazySystemDLL("shell32.dll")
	procSHFileOperationW = modshell32.NewProc("SHFileOperationW")
)

// trashOrRemove moves path to the Windows Recycle Bin, falling back to
// permanent removal. The Recycle Bin gives users a recovery path if they
// accidentally delete a conversation. Implemented through the Win32 shell API
// directly (no cgo) so the binary cross-compiles from non-Windows hosts.
func trashOrRemove(path string) error {
	if err := moveToRecycleBin(path); err == nil {
		return nil
	}
	// Recycle failed (e.g. network volume, overlong path, a handle held in the
	// folder) — permanent delete, outlasting a briefly held handle.
	return atomicio.RobustRemoveAll(path)
}

func moveToRecycleBin(path string) error {
	// SHFileOperationW wants an absolute, double-NUL-terminated path list.
	abs, err := windows.FullPath(path)
	if err != nil {
		return err
	}
	from, err := windows.UTF16FromString(abs)
	if err != nil {
		return err
	}
	from = append(from, 0) // second NUL terminates the (single-entry) list

	op := shFileOpStructW{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
	}

	rc, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if rc != 0 {
		return fmt.Errorf("SHFileOperationW failed: 0x%x", rc)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("recycle operation aborted for %q", abs)
	}
	return nil
}
