# Real SSH + kernel WireGuard fixture for the classroom container demo.
# The standalone Mini-Agent remains agent/Dockerfile; VM workers use system SSH.
FROM python:3.12-alpine
RUN apk add --no-cache openssh-server wireguard-tools iproute2 iptables su-exec \
    && addgroup -S ztgroup && adduser -D -s /bin/sh -G ztgroup ztuser \
    && passwd -d ztuser \
    && mkdir -p /run/sshd /etc/ssh/authorized_keys
COPY agent/src/ /app/
COPY deploy/demo/sshd_config /etc/ssh/sshd_config
COPY deploy/demo/worker-entrypoint.sh /usr/local/bin/zt-worker
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["sh", "/usr/local/bin/zt-worker"]
