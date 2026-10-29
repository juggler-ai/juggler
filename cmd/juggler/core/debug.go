//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"log"
	"strings"
	"unicode/utf8"
)

// ANSI color codes
const (
	ColorReset   = "\033[0m"
	ColorRed     = "\033[31m"
	ColorGreen   = "\033[32m"
	ColorYellow  = "\033[33m"
	ColorBlue    = "\033[34m"
	ColorMagenta = "\033[35m"
	ColorCyan    = "\033[36m"
	ColorWhite   = "\033[37m"
	ColorBold    = "\033[1m"
	ColorDim     = "\033[2m"

	// Background colors
	BgBlack   = "\033[40m"
	BgRed     = "\033[41m"
	BgGreen   = "\033[42m"
	BgYellow  = "\033[43m"
	BgBlue    = "\033[44m"
	BgMagenta = "\033[45m"
	BgCyan    = "\033[46m"
	BgWhite   = "\033[47m"
)

// PrintProminentBox prints a prominent colored box - always visible regardless of debug mode
func PrintProminentBox(title string, content string, color string) {
	// Calculate required box width based on content
	lines := strings.Split(content, "\n")
	maxLineLen := utf8.RuneCountInString(title)
	for _, line := range lines {
		if utf8.RuneCountInString(line) > maxLineLen {
			maxLineLen = utf8.RuneCountInString(line)
		}
	}

	// Box width = max line length + 4 (for "║ " and " ║")
	boxWidth := maxLineLen + 4

	// Top border
	log.Printf("%s%s╔%s╗%s", ColorBold, color, strings.Repeat("═", boxWidth-2), ColorReset)

	// Title line (centered)
	titleLen := utf8.RuneCountInString(title)
	titlePadding := (boxWidth - 4 - titleLen) / 2
	titleLeftPad := strings.Repeat(" ", titlePadding)
	titleRightPad := strings.Repeat(" ", boxWidth-4-titleLen-titlePadding)
	log.Printf("%s%s║ %s%s%s%s ║%s", ColorBold, color, titleLeftPad, title, titleRightPad, color, ColorReset)

	// Separator
	log.Printf("%s%s╠%s╣%s", ColorBold, color, strings.Repeat("═", boxWidth-2), ColorReset)

	// Content lines (left-aligned)
	for _, line := range lines {
		// Left-align content with right padding
		lineLen := utf8.RuneCountInString(line)
		rightPad := strings.Repeat(" ", boxWidth-4-lineLen)
		log.Printf("%s%s║ %s%s ║%s", ColorBold, color, line, rightPad, ColorReset)
	}

	// Bottom border
	log.Printf("%s%s╚%s╝%s", ColorBold, color, strings.Repeat("═", boxWidth-2), ColorReset)
}
