//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ingress

import (
	"os"
	"testing"
)

func TestTakeSecretRemovesItFromTheEnvironment(t *testing.T) {
	t.Setenv(SecretEnv, "s3cret")
	if got := TakeSecret(); got != "s3cret" {
		t.Fatalf("TakeSecret() = %q, want %q", got, "s3cret")
	}
	if v, ok := os.LookupEnv(SecretEnv); ok {
		t.Fatalf("%s still set to %q after TakeSecret", SecretEnv, v)
	}
	if got := TakeSecret(); got != "" {
		t.Fatalf("second TakeSecret() = %q, want empty", got)
	}
}

func TestTakeTokenRemovesItFromTheEnvironment(t *testing.T) {
	t.Setenv(TokenEnv, "t0ken")
	if got := TakeToken(); got != "t0ken" {
		t.Fatalf("TakeToken() = %q, want %q", got, "t0ken")
	}
	if v, ok := os.LookupEnv(TokenEnv); ok {
		t.Fatalf("%s still set to %q after TakeToken", TokenEnv, v)
	}
}

func TestNewSecretIsFreshEachTime(t *testing.T) {
	a, b := NewSecret(), NewSecret()
	if len(a) != 64 || a == b {
		t.Fatalf("NewSecret() gave %q then %q, want two distinct 64-char secrets", a, b)
	}
}
