//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"os"
	"path/filepath"
	"testing"
)

// TestProject represents a temporary test project
type TestProject struct {
	Path    string
	Files   map[string]string
	t       *testing.T
	cleanup func()
}

// NewTestProject creates a new test project
func NewTestProject(t *testing.T) *TestProject {
	tmpDir, err := os.MkdirTemp("", "juggler-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	return &TestProject{
		Path:  tmpDir,
		Files: make(map[string]string),
		t:     t,
		cleanup: func() {
			os.RemoveAll(tmpDir)
		},
	}
}

// Build writes all files to disk
func (tp *TestProject) Build() *TestProject {
	for path, content := range tp.Files {
		fullPath := filepath.Join(tp.Path, path)

		// Create parent directories
		dir := filepath.Dir(fullPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			tp.t.Fatalf("Failed to create directory %s: %v", dir, err)
		}

		// Write file
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			tp.t.Fatalf("Failed to write file %s: %v", fullPath, err)
		}
	}

	return tp
}

// Cleanup removes the test project directory
func (tp *TestProject) Cleanup() {
	if tp.cleanup != nil {
		tp.cleanup()
	}
}

// EmptyProject creates an empty project
func EmptyProject(t *testing.T) *TestProject {
	return NewTestProject(t).Build()
}

// CreateTempDir creates a temporary directory for testing
func CreateTempDir(t *testing.T) string {
	t.Helper()
	tmpDir, err := os.MkdirTemp("", "juggler-security-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	return tmpDir
}

// WriteFile writes content to a file
func WriteFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0644); err != nil {
		t.Fatalf("Failed to write file %s: %v", path, err)
	}
}

// CreateFileWithSize creates a file with specified size (filled with 'a' characters)
func CreateFileWithSize(t *testing.T, dir, filename string, sizeBytes int64) string {
	t.Helper()
	path := filepath.Join(dir, filename)
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("Failed to create file: %v", err)
	}
	defer file.Close()

	// Write in chunks to avoid memory issues with huge files
	chunkSize := int64(1024 * 1024) // 1MB chunks
	chunk := make([]byte, chunkSize)
	for i := range chunk {
		chunk[i] = 'a'
	}

	remaining := sizeBytes
	for remaining > 0 {
		writeSize := min(remaining, chunkSize)
		if _, err := file.Write(chunk[:writeSize]); err != nil {
			t.Fatalf("Failed to write to file: %v", err)
		}
		remaining -= writeSize
	}

	return path
}

// CreateSubdir creates a subdirectory in the given parent directory
func CreateSubdir(t *testing.T, parent, name string) string {
	t.Helper()
	path := filepath.Join(parent, name)
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatalf("Failed to create subdirectory: %v", err)
	}
	return path
}
