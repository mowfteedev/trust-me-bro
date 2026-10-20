#!/bin/sh
set -eu
output_dir=${1:?Usage: sh build-windows.sh OUTPUT_DIRECTORY}
mkdir -p "$output_dir"
# Keep the supported crypto snapshot without its newer 32 MiB static buffer.
# platform_windows.go preserves the existing non-FIPS runtime behavior.
export CGO_ENABLED=0 GOOS=windows GOARCH=amd64 GOFIPS140=v1.0.0
go build -trimpath -ldflags='-s -w' -o "$output_dir/zt-agent.exe" .
go test -c -o "$output_dir/zt-agent-tests.exe" .
go version -m "$output_dir/zt-agent.exe" > "$output_dir/build-info.txt"
