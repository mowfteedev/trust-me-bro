# Only the builder contains Go. Runtime has one static Linux binary and CA roots.
FROM golang:1.27-alpine AS builder
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/zt-agent .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && addgroup -S ztgroup && adduser -S ztuser -G ztgroup
COPY --from=builder /out/zt-agent /usr/local/bin/zt-agent
ENV GOMAXPROCS=1
USER ztuser
ENTRYPOINT ["/usr/local/bin/zt-agent"]
