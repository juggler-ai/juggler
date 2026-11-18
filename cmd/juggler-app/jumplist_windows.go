//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The taskbar button's right-click menu (its jump list) carries one task, New
// Window: a link to this exe with no arguments. Launching the exe while the app
// runs is a bare relaunch, which opens a new window (onSecondInstance); with
// the app not running it is an ordinary launch. Windows keeps the list between
// runs, so it is written again at each launch, in the UI language, and on every
// change of language.
//
// The process and the installer's shortcuts carry no explicit AppUserModelID,
// so both get Windows' default one, derived from the exe's path, and the list
// is the one shown on this app's own taskbar button.

var (
	ole32                = windows.NewLazySystemDLL("ole32.dll")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")

	clsidDestinationList            = windows.GUID{Data1: 0x77F10CF0, Data2: 0x3DB5, Data3: 0x4966, Data4: [8]byte{0xB5, 0x20, 0xB7, 0xC5, 0x4F, 0xD3, 0x5E, 0xD6}}
	iidCustomDestinationList        = windows.GUID{Data1: 0x6332DEBF, Data2: 0x87B5, Data3: 0x4670, Data4: [8]byte{0x90, 0xC0, 0x5E, 0x57, 0xB4, 0x08, 0xA4, 0x9E}}
	clsidEnumerableObjectCollection = windows.GUID{Data1: 0x2D3468C1, Data2: 0x36A7, Data3: 0x43B6, Data4: [8]byte{0xAC, 0x24, 0xD3, 0xF0, 0x2F, 0xD9, 0x60, 0x7A}}
	iidObjectCollection             = windows.GUID{Data1: 0x5632B1A4, Data2: 0xE38A, Data3: 0x400A, Data4: [8]byte{0x92, 0x8A, 0xD4, 0xCD, 0x63, 0x23, 0x02, 0x95}}
	iidObjectArray                  = windows.GUID{Data1: 0x92CA9DCD, Data2: 0x5622, Data3: 0x4BBA, Data4: [8]byte{0xA8, 0x05, 0x5E, 0x9F, 0x54, 0x1B, 0xD8, 0xC9}}
	clsidShellLink                  = windows.GUID{Data1: 0x00021401, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidShellLinkW                   = windows.GUID{Data1: 0x000214F9, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidPropertyStore                = windows.GUID{Data1: 0x886D8EEB, Data2: 0x8CF2, Data3: 0x4446, Data4: [8]byte{0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99}}

	// pkeyTitle is PKEY_Title, the property a jump-list task's label is read
	// from.
	pkeyTitle = propertyKey{fmtid: windows.GUID{Data1: 0xF29F85E0, Data2: 0x4FF9, Data3: 0x1068, Data4: [8]byte{0xAB, 0x91, 0x08, 0x00, 0x2B, 0x27, 0xB3, 0xD9}}, pid: 2}
)

// Vtable slots, after IUnknown's QueryInterface (0), AddRef (1), Release (2).
const (
	slotRelease = 2

	slotDestinationListBeginList    = 4
	slotDestinationListAddUserTasks = 7
	slotDestinationListCommitList   = 8
	slotDestinationListAbortList    = 11

	slotObjectCollectionAddObject = 5

	slotShellLinkSetArguments    = 11
	slotShellLinkSetIconLocation = 17
	slotShellLinkSetPath         = 20

	slotPropertyStoreSetValue = 6
	slotPropertyStoreCommit   = 7

	slotQueryInterface = 0
)

const (
	clsctxInprocServer = 0x1
	vtLPWSTR           = 31
)

type propertyKey struct {
	fmtid windows.GUID
	pid   uint32
}

// propVariant is a PROPVARIANT holding a VT_LPWSTR: the tag, three reserved
// words, then the value, padded to the union's full size.
type propVariant struct {
	vt       uint16
	reserved [3]uint16
	val      uintptr
	pad      uintptr
}

// comObject is a COM interface pointer: what it points at begins with its
// vtable.
type comObject struct {
	vtbl *[32]uintptr
}

func (o *comObject) call(slot int, args ...uintptr) error {
	r, _, _ := syscall.SyscallN(o.vtbl[slot], append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)...)
	if int32(r) < 0 {
		return fmt.Errorf("HRESULT 0x%08X", uint32(r))
	}
	return nil
}

func (o *comObject) release() {
	if o != nil {
		_ = o.call(slotRelease)
	}
}

func (o *comObject) queryInterface(iid *windows.GUID) (*comObject, error) {
	var out *comObject
	if err := o.call(slotQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))); err != nil {
		return nil, err
	}
	return out, nil
}

func coCreate(clsid, iid *windows.GUID) (*comObject, error) {
	var out *comObject
	r, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(clsid)), 0, clsctxInprocServer,
		uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	if int32(r) < 0 {
		return nil, fmt.Errorf("CoCreateInstance: HRESULT 0x%08X", uint32(r))
	}
	return out, nil
}

var (
	// jumpListTitles holds the title of the next write of the list: only the
	// latest language matters, so a newer title replaces one not yet written.
	jumpListTitles      = make(chan string, 1)
	startJumpListWriter sync.Once
)

// setTaskbarTasks writes the taskbar button's tasks, New Window titled
// newWindow, in the background. A failure is logged, never fatal: the app
// works the same without the task.
func setTaskbarTasks(newWindow string) {
	startJumpListWriter.Do(func() { go jumpListWriter() })
	for {
		select {
		case jumpListTitles <- newWindow:
			return
		default:
		}
		select {
		case <-jumpListTitles:
		default:
		}
	}
}

// jumpListWriter writes each title it is handed, one at a time, on a thread of
// its own: COM is initialised per thread.
func jumpListWriter() {
	runtime.LockOSThread()
	// S_FALSE (1) is a thread COM was already initialised on, which is as
	// good.
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil && err != syscall.Errno(1) {
		logf("taskbar tasks: CoInitializeEx: %v", err)
		return
	}
	for title := range jumpListTitles {
		if err := writeJumpList(title); err != nil {
			logf("taskbar tasks: %v", err)
		}
	}
}

func writeJumpList(newWindow string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	link, err := newWindowLink(exe, newWindow)
	if err != nil {
		return fmt.Errorf("the New Window link: %w", err)
	}
	defer link.release()

	collection, err := coCreate(&clsidEnumerableObjectCollection, &iidObjectCollection)
	if err != nil {
		return err
	}
	defer collection.release()
	if err := collection.call(slotObjectCollectionAddObject, uintptr(unsafe.Pointer(link))); err != nil {
		return fmt.Errorf("AddObject: %w", err)
	}
	tasks, err := collection.queryInterface(&iidObjectArray)
	if err != nil {
		return fmt.Errorf("IObjectArray: %w", err)
	}
	defer tasks.release()

	list, err := coCreate(&clsidDestinationList, &iidCustomDestinationList)
	if err != nil {
		return err
	}
	defer list.release()
	var minSlots uint32
	var removed *comObject
	if err := list.call(slotDestinationListBeginList, uintptr(unsafe.Pointer(&minSlots)),
		uintptr(unsafe.Pointer(&iidObjectArray)), uintptr(unsafe.Pointer(&removed))); err != nil {
		return fmt.Errorf("BeginList: %w", err)
	}
	removed.release()
	if err := list.call(slotDestinationListAddUserTasks, uintptr(unsafe.Pointer(tasks))); err != nil {
		_ = list.call(slotDestinationListAbortList)
		return fmt.Errorf("AddUserTasks: %w", err)
	}
	if err := list.call(slotDestinationListCommitList); err != nil {
		return fmt.Errorf("CommitList: %w", err)
	}
	return nil
}

// newWindowLink is the shell link the New Window task runs: exe, with no
// arguments and exe's own icon, titled title.
func newWindowLink(exe, title string) (*comObject, error) {
	link, err := coCreate(&clsidShellLink, &iidShellLinkW)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			link.release()
		}
	}()
	exeW, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return nil, err
	}
	empty, _ := windows.UTF16PtrFromString("")
	if err := link.call(slotShellLinkSetPath, uintptr(unsafe.Pointer(exeW))); err != nil {
		return nil, fmt.Errorf("SetPath: %w", err)
	}
	if err := link.call(slotShellLinkSetArguments, uintptr(unsafe.Pointer(empty))); err != nil {
		return nil, fmt.Errorf("SetArguments: %w", err)
	}
	if err := link.call(slotShellLinkSetIconLocation, uintptr(unsafe.Pointer(exeW)), 0); err != nil {
		return nil, fmt.Errorf("SetIconLocation: %w", err)
	}

	props, err := link.queryInterface(&iidPropertyStore)
	if err != nil {
		return nil, fmt.Errorf("IPropertyStore: %w", err)
	}
	defer props.release()
	titleW, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return nil, err
	}
	// The store copies the value, so the string only has to outlive the call.
	value := propVariant{vt: vtLPWSTR, val: uintptr(unsafe.Pointer(titleW))}
	err = props.call(slotPropertyStoreSetValue, uintptr(unsafe.Pointer(&pkeyTitle)), uintptr(unsafe.Pointer(&value)))
	runtime.KeepAlive(titleW)
	if err != nil {
		return nil, fmt.Errorf("SetValue(Title): %w", err)
	}
	if err := props.call(slotPropertyStoreCommit); err != nil {
		return nil, fmt.Errorf("IPropertyStore.Commit: %w", err)
	}
	ok = true
	return link, nil
}
