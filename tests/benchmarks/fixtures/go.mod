// Benchmark fixture projects: data the agent works on in the benchmark and
// integration suites, not code of this repository. This go.mod keeps their Go
// sources out of the juggler module, so no build, vet, lint or dead-code pass
// over it treats them as its packages.
module fixtures

go 1.22
