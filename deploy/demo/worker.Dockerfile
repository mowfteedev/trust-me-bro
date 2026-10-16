# Real SSH + kernel WireGuard fixture for the classroom container demo.
FROM golang:1.27-alpine AS builder
WORKDIR /src
COPY agent/go.mod agent/*.go ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/zt-agent .

FROM alpine:3.22
RUN apk add --no-cache openssh-server wireguard-tools iproute2 iptables su-exec ca-certificates \
    && addgroup -S ztgroup && adduser -D -s /bin/sh -G ztgroup ztuser \
    && passwd -d ztuser \
    && mkdir -p /run/sshd /etc/ssh/authorized_keys
COPY --from=builder /out/zt-agent /usr/local/bin/zt-agent
COPY deploy/demo/sshd_config /etc/ssh/sshd_config
COPY deploy/demo/worker-entrypoint.sh /usr/local/bin/zt-worker
ENV GOMAXPROCS=1
ENTRYPOINT ["sh", "/usr/local/bin/zt-worker"]
