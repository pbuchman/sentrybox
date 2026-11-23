FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates curl iproute2 openssl python3 systemd udev \
    && rm -rf /var/lib/apt/lists/*

ENV container=docker
COPY sentrybox-worker-relay.socket sentrybox-worker-relay.service /etc/systemd/system/
COPY wait-worker-relay-gateway.sh /opt/sentrybox-control/current/deploy/home-dev/
COPY test/worker-relay-fixture.sh /fixture/
RUN touch /fixture/isolated-test-container && /fixture/worker-relay-fixture.sh prepare

STOPSIGNAL SIGRTMIN+4
CMD ["/usr/lib/systemd/systemd"]
