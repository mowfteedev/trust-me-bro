FROM alpine:3.21
RUN apk add --no-cache wireguard-tools iproute2 iptables
COPY entrypoint.sh /usr/local/bin/zt-wireguard
ENTRYPOINT ["sh", "/usr/local/bin/zt-wireguard"]
