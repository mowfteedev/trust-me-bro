FROM golang:1.27-alpine AS peer-builder
WORKDIR /src
COPY peer-helper.go .
RUN CGO_ENABLED=0 GO111MODULE=off go build -trimpath -ldflags='-s -w' -o /out/zt-peer-helper peer-helper.go

FROM alpine:3.21
RUN apk add --no-cache wireguard-tools iproute2 iptables
COPY entrypoint.sh /usr/local/bin/zt-wireguard
COPY --from=peer-builder /out/zt-peer-helper /usr/local/bin/zt-peer-helper
ENTRYPOINT ["sh", "/usr/local/bin/zt-wireguard"]
