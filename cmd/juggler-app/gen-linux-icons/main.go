//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Command gen-linux-icons renders the app icon into the hicolor icon-theme
// layout a Linux desktop looks it up in: <out>/hicolor/<N>x<N>/apps/<name>.png
// for each size the desktop shells ask for. `make linux-tarball` runs it to
// put the icons beside packaging/linux/install.sh, which copies them into
// the user's icon theme.
//
// GTK4 has no way to give a window an icon from image data: a shell finds the
// icon through the .desktop file matching the window's application id, and
// that file names an icon in the theme. These are that icon.
//
// It is a build tool: it is not linked into the app.
package main

import (
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"

	xdraw "golang.org/x/image/draw"
)

// sizes are the hicolor sizes rendered: the fixed sizes panels, docks, the
// app grid and alt-tab ask for, up to the largest the theme defines. Ascending,
// so the largest is written last: the Makefile takes it as the sign that a run
// finished.
var sizes = []int{16, 24, 32, 48, 64, 128, 256, 512}

func main() {
	src := flag.String("src", "", "source PNG (square, at least 512px)")
	out := flag.String("o", "", "directory to write the hicolor/ tree into")
	name := flag.String("name", "", "icon name: the .desktop file's Icon= value")
	flag.Parse()
	if *src == "" || *out == "" || *name == "" {
		fmt.Fprintln(os.Stderr, "usage: gen-linux-icons -src icon.png -o dir -name icon-name")
		os.Exit(2)
	}
	if err := run(*src, *out, *name); err != nil {
		fmt.Fprintln(os.Stderr, "gen-linux-icons:", err)
		os.Exit(1)
	}
}

func run(srcPath, outDir, name string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	img, err := png.Decode(f)
	_ = f.Close()
	if err != nil {
		return fmt.Errorf("%s: %w", srcPath, err)
	}
	b := img.Bounds()
	if b.Dx() != b.Dy() || b.Dx() < sizes[len(sizes)-1] {
		return fmt.Errorf("%s is %dx%d; it must be square and at least %dpx", srcPath, b.Dx(), b.Dy(), sizes[len(sizes)-1])
	}
	for _, n := range sizes {
		dst := image.NewNRGBA(image.Rect(0, 0, n, n))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Src, nil)
		dir := filepath.Join(outDir, "hicolor", fmt.Sprintf("%dx%d", n, n), "apps")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		if err := writePNG(filepath.Join(dir, name+".png"), dst); err != nil {
			return err
		}
	}
	return nil
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
